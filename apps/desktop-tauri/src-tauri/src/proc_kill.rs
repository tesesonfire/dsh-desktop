//! Process-tree termination — the shell's kill primitive.
//!
//! Windows: the sidecar child is assigned to a kill-on-close job object at
//! spawn time; `TerminateJobObject` kills the whole tree instantly and
//! `taskkill /T /F` is kept as a fallback for the no-job case.
//! Unix: the child is spawned with `process_group(0)`, so the whole tree
//! shares a process group that can be signalled as `-pid`
//! (SIGTERM → grace → SIGKILL).

// The graceful SIGTERM wait (Duration/Instant) exists on Unix only; Windows
// terminates immediately through the job object / taskkill.
#[cfg(unix)]
use std::time::{Duration, Instant};

/// CREATE_NO_WINDOW for detached child processes on Windows.
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// PIDs below 1 are never valid targets; `kill(0, ...)`/`kill(-0, ...)`
/// would signal our own process group instead.
fn pid_is_valid(pid: u32) -> bool {
    pid > 0
}

// ---------------------------------------------------------------------------
// Windows job objects
// ---------------------------------------------------------------------------

#[cfg(windows)]
mod job {
    use std::os::windows::io::RawHandle;
    use std::ptr;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    /// RAII wrapper around a Windows job object configured with
    /// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: if our process dies with the handle
    /// still open, the kernel terminates every process in the job.
    pub struct JobObject {
        handle: HANDLE,
    }

    // SAFETY: HANDLE is a raw kernel pointer, but the job object is only used
    // through the Windows API which is thread-safe.
    unsafe impl Send for JobObject {}
    unsafe impl Sync for JobObject {}

    impl JobObject {
        /// Create a job object with the kill-on-close limit set.
        pub fn create() -> Result<Self, String> {
            // SAFETY: both arguments are documented as optional (null).
            let handle = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
            if handle.is_null() {
                return Err("CreateJobObjectW failed".to_string());
            }
            // SAFETY: zeroed JOBOBJECT_EXTENDED_LIMIT_INFORMATION is the
            // documented "no limits" state; we only set the limit flags.
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            // SAFETY: handle is valid, info pointer and size match the class.
            let ok = unsafe {
                SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const core::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            };
            if ok == 0 {
                // Drop through a temporary JobObject so its RAII close runs.
                let failed = Self { handle };
                drop(failed);
                return Err("SetInformationJobObject failed".to_string());
            }
            Ok(Self { handle })
        }

        /// Assign the freshly spawned child (via its raw process handle — we
        /// own it, so no OpenProcess round-trip is needed) to the job.
        pub fn assign_handle(&self, raw: RawHandle) -> Result<(), String> {
            // RawHandle and windows-sys HANDLE are both *mut c_void.
            // SAFETY: both handles are valid.
            let ok = unsafe { AssignProcessToJobObject(self.handle, raw) };
            if ok == 0 {
                return Err("AssignProcessToJobObject failed".to_string());
            }
            Ok(())
        }

        /// Terminate every process currently in the job.
        pub fn terminate(&self) -> Result<(), String> {
            // SAFETY: handle is valid; exit code 1 marks a forced kill.
            let ok = unsafe { TerminateJobObject(self.handle, 1) };
            if ok == 0 {
                return Err("TerminateJobObject failed".to_string());
            }
            Ok(())
        }
    }

    impl Drop for JobObject {
        fn drop(&mut self) {
            // SAFETY: handle is owned exclusively by this struct.
            unsafe { CloseHandle(self.handle) };
        }
    }
}

#[cfg(windows)]
pub use job::JobObject;

/// Type placeholder so signatures stay identical across platforms.
#[cfg(not(windows))]
#[derive(Debug)]
pub struct JobObject;

// ---------------------------------------------------------------------------
// Tree kill
// ---------------------------------------------------------------------------

/// Kill the process tree rooted at `pid`. Async because the Unix path waits
/// up to 3 seconds for a graceful SIGTERM exit.
pub async fn kill_process_tree(pid: u32, job: Option<&JobObject>) {
    if !pid_is_valid(pid) {
        return;
    }
    #[cfg(windows)]
    {
        if let Some(job) = job {
            if let Err(err) = job.terminate() {
                tracing::warn!("TerminateJobObject({pid}) failed: {err}");
            }
        }
        // Fallback / no-job case: taskkill walks the tree by pid.
        let _ = tokio::process::Command::new("taskkill")
            .args(["/pid", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .await;
    }
    #[cfg(unix)]
    {
        let _ = job;
        // SAFETY: signal sending has no memory-safety preconditions.
        unsafe { libc::kill(-(pid as i32), libc::SIGTERM) };
        let deadline = Instant::now() + Duration::from_secs(3);
        while is_pid_alive(pid) && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        if is_pid_alive(pid) {
            unsafe { libc::kill(-(pid as i32), libc::SIGKILL) };
        }
        if is_pid_alive(pid) {
            unsafe { libc::kill(pid as i32, libc::SIGKILL) };
        }
    }
}

/// Synchronous variant for exit paths where awaiting is impossible
/// (RunEvent::Exit, tray Quit). On Unix the SIGKILL escalation is delegated
/// to a detached thread so the UI thread never blocks for the grace period.
pub fn kill_process_tree_blocking(pid: u32, job: Option<&JobObject>) {
    if !pid_is_valid(pid) {
        return;
    }
    #[cfg(windows)]
    {
        if let Some(job) = job {
            let _ = job.terminate();
        }
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("taskkill")
            .args(["/pid", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
    }
    #[cfg(unix)]
    {
        let _ = job;
        // SAFETY: signal sending has no memory-safety preconditions.
        unsafe { libc::kill(-(pid as i32), libc::SIGTERM) };
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(3));
            if is_pid_alive(pid) {
                // SAFETY: signal sending has no memory-safety preconditions.
                unsafe {
                    libc::kill(-(pid as i32), libc::SIGKILL);
                    libc::kill(pid as i32, libc::SIGKILL);
                }
            }
        });
    }
}

/// True when a process with `pid` currently exists. Used by stop paths and
/// by the orphan assertions in tests.
pub fn is_pid_alive(pid: u32) -> bool {
    if !pid_is_valid(pid) {
        return false;
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{CloseHandle, WAIT_TIMEOUT};
        use windows_sys::Win32::System::Threading::{
            OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
            PROCESS_SYNCHRONIZE,
        };
        // SAFETY: polling an arbitrary pid is safe; we hold no references.
        let handle =
            unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE, 0, pid) };
        if handle.is_null() {
            // Process object gone (or access denied) — treat as dead; our own
            // children always grant these access rights.
            return false;
        }
        // SAFETY: handle is valid and we own it.
        let state = unsafe { WaitForSingleObject(handle, 0) };
        // SAFETY: close in all cases.
        unsafe { CloseHandle(handle) };
        state == WAIT_TIMEOUT
    }
    #[cfg(unix)]
    {
        // SAFETY: signal 0 performs an existence check only.
        let rc = unsafe { libc::kill(pid as i32, 0) };
        if rc == 0 {
            true
        } else {
            std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
        }
    }
}

#[cfg(all(test, unix))]
mod unix_tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn kills_the_whole_process_group() {
        // sh keeps two `sleep` children; they inherit the child's process
        // group (spawned with process_group(0)), so a group signal must
        // terminate sh AND both sleeps.
        let mut child = tokio::process::Command::new("sh")
            .arg("-c")
            .arg("sleep 300 & sleep 300")
            .process_group(0)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn sh");
        let pid = child.id().expect("pid");
        assert!(is_pid_alive(pid));

        tokio::time::timeout(Duration::from_secs(30), kill_process_tree(pid, None))
            .await
            .expect("kill completes within timeout");

        let status = tokio::time::timeout(Duration::from_secs(10), child.wait())
            .await
            .expect("child reaped within timeout")
            .expect("wait ok");
        assert!(!status.success(), "sh must have been signalled, not exited cleanly");

        // The group itself must be empty: signalling -pid returns ESRCH.
        // SAFETY: signal 0 performs an existence check only.
        let rc = unsafe { libc::kill(-(pid as i32), 0) };
        assert_ne!(rc, 0, "process group must be empty after the kill");
        assert!(!is_pid_alive(pid));
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;
    use std::os::windows::process::CommandExt;
    use std::time::Duration;

    /// Direct child pids of `parent` via CIM (no external crates needed).
    fn child_pids(parent: u32) -> Vec<u32> {
        let script = format!(
            "(Get-CimInstance Win32_Process -Filter 'ParentProcessId={parent}').ProcessId"
        );
        let output = std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .expect("powershell query");
        String::from_utf8_lossy(&output.stdout)
            .split_whitespace()
            .filter_map(|token| token.parse::<u32>().ok())
            .collect()
    }

    #[tokio::test]
    async fn kills_cmd_and_its_children() {
        // cmd waits for ping: a two-level tree. taskkill /T must take both.
        let mut child = tokio::process::Command::new("cmd")
            .args(["/c", "ping -n 30 127.0.0.1"])
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn cmd");
        let pid = child.id().expect("pid");
        assert!(is_pid_alive(pid));

        tokio::time::timeout(Duration::from_secs(30), kill_process_tree(pid, None))
            .await
            .expect("kill completes within timeout");

        tokio::time::timeout(Duration::from_secs(10), child.wait())
            .await
            .expect("child reaped within timeout")
            .expect("wait ok");
        assert!(!is_pid_alive(pid), "cmd must be dead");

        // The grandchild (ping) must not have survived the tree kill.
        let mut grandchildren = child_pids(pid);
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                grandchildren.retain(|gpid| is_pid_alive(*gpid));
                if grandchildren.is_empty() {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        })
        .await
        .expect("grandchildren terminated");
    }
}
