//! DSH sidecar lifecycle: resolve the `dsh` command, spawn it, pump its
//! output, parse the official ready line, and own the running child.
//!
//! Contracts implemented here (single source of truth in packages/protocol):
//! - ready line: `dsh web: http://127.0.0.1:<port>/?token=<base64url>` with an
//!   optional ` (LAN: ...)` suffix — packages/protocol/src/readyline.ts; the
//!   `?token=` query is the per-process credential and MUST survive into the
//!   URL handed to the web view.
//! - spawn args: `--profile <p> --patch <yml> --port 0 --no-open` (fixed
//!   order; all launcher flags, so they precede any inner-app tokens).
//! - DSH_BIN resolution: .mjs/.cjs/.js → node (DSH_NODE, else PATH);
//!   .cmd/.bat (Windows only) → `cmd.exe /d /s /c <path>`; otherwise the path
//!   is executed directly.
//!
//! The state machine is framework-free: DshSidecar reports through an
//! `EventSink` instead of a Tauri AppHandle so tests/lifecycle.rs can run it
//! under plain tokio. lib.rs wires the sink to `app.emit` + main-window
//! navigation.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::control_server;
use crate::launcher;
use crate::proc_kill;

/// Renderer event channels — must stay byte-identical with `BRIDGE_EVENTS`
/// in packages/protocol/src/events.ts (`dsh:state` / `dsh:log`).
pub const EVENT_STATE: &str = "dsh:state";
pub const EVENT_LOG: &str = "dsh:log";

/// Waiting deadline for the ready line (same 90s budget as the reference
/// implementation's health check).
const READY_DEADLINE: Duration = Duration::from_secs(90);
const POLL_INTERVAL: Duration = Duration::from_millis(100);

// ---------------------------------------------------------------------------
// Protocol DTOs (serde shapes must match packages/protocol/src/bridge.ts)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum HostState {
    #[default]
    Stopped,
    Starting,
    Running,
    Error,
}

/// Mirrors `HostStatus` in packages/protocol/src/bridge.ts.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostStatus {
    pub state: HostState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<u64>,
}

/// Mirrors `HostEndpoint` in packages/protocol/src/bridge.ts and
/// `ControlHostEndpoint` in packages/protocol/src/control.ts.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostEndpoint {
    pub port: u16,
    pub url: String,
}

/// Shell → plugin events delivered via the control channel long-poll.
/// Serialized shape must match `ControlEvent` in
/// packages/protocol/src/control.ts: `{"type":"window-close"}` /
/// `{"type":"shutdown"}`.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ShellControlEvent {
    WindowClose,
    Shutdown,
}

/// Recorded POST /v0/hello payload (plugin → shell announcement).
#[derive(Debug, Clone)]
pub struct HelloInfo {
    pub pid: u32,
    pub web_port: u16,
    pub profile: String,
}

/// Sidecar events forwarded to the host wiring (renderer events, window
/// navigation). Kept tauri-free for testability.
pub enum SidecarEvent {
    State(HostStatus),
    Log { level: String, line: String },
}

pub type EventSink = Arc<dyn Fn(SidecarEvent) + Send + Sync>;

// ---------------------------------------------------------------------------
// Ready-line parsing
// ---------------------------------------------------------------------------

/// Result of a successful ready-line parse.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadyLineInfo {
    /// Authenticated URL (token included) — load this in the web view.
    pub url: String,
    /// Exact origin; the navigation fence allows nothing else.
    pub origin: String,
    pub port: u16,
}

/// Parse the official ready line without a regex dependency.
///
/// Format (deepseek-harness packages/bundle/web-app/src/index.ts:271, e2e lock
/// apps/cli/tests/built-bin.e2e.ts:787):
/// `dsh web: http://127.0.0.1:<port>/?token=<base64url>[ (LAN: <url>)]`
pub fn parse_ready_line(line: &str) -> Option<ReadyLineInfo> {
    let trimmed = line.trim();
    let rest = trimmed.strip_prefix("dsh web: http://127.0.0.1:")?;
    let (port_str, after) = rest.split_once("/?token=")?;
    if port_str.is_empty() || port_str.len() > 5 || !port_str.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let port: u32 = port_str.parse().ok()?;
    if port == 0 || port > 65535 {
        return None;
    }
    // The LAN suffix, when present, is informational only — drop it.
    let token = match after.find(" (LAN: ") {
        Some(idx) => &after[..idx],
        None => after,
    };
    if token.is_empty() || !token.bytes().all(is_base64url_byte) {
        return None;
    }
    let url = format!("http://127.0.0.1:{port}/?token={token}");
    Some(ReadyLineInfo {
        origin: format!("http://127.0.0.1:{port}"),
        url,
        port: port as u16,
    })
}

fn is_base64url_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'-' || b == b'_'
}

// ---------------------------------------------------------------------------
// DSH_BIN resolution
// ---------------------------------------------------------------------------

/// Resolved spawn target for the sidecar.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DshCommand {
    pub program: String,
    pub args: Vec<String>,
}

/// PATH lookup function; injected so resolution is testable.
pub type PathFinder = dyn Fn(&str) -> Option<String> + Send + Sync;

/// Reads DSH_BIN / DSH_NODE from the environment and resolves the command.
pub fn resolve_dsh_command() -> Result<DshCommand, String> {
    let bin = nonempty_env("DSH_BIN");
    let node = nonempty_env("DSH_NODE");
    resolve_dsh_command_from(bin.as_deref(), node.as_deref(), &find_in_path)
}

/// Pure-ish core of DSH_BIN resolution (see module docs for the contract).
pub fn resolve_dsh_command_from(
    bin: Option<&str>,
    node: Option<&str>,
    find: &PathFinder,
) -> Result<DshCommand, String> {
    if let Some(bin) = bin {
        let lower = bin.to_ascii_lowercase();
        if lower.ends_with(".mjs") || lower.ends_with(".cjs") || lower.ends_with(".js") {
            let node_path = match node {
                Some(explicit) => explicit.to_string(),
                None => find(if cfg!(windows) { "node.exe" } else { "node" }).ok_or_else(|| {
                    "node runtime not found on PATH (required to run DSH_BIN scripts); set DSH_NODE"
                        .to_string()
                })?,
            };
            return Ok(DshCommand {
                program: node_path,
                args: vec![bin.to_string()],
            });
        }
        #[cfg(windows)]
        if lower.ends_with(".cmd") || lower.ends_with(".bat") {
            return Ok(DshCommand {
                program: "cmd.exe".to_string(),
                args: vec!["/d".to_string(), "/s".to_string(), "/c".to_string(), bin.to_string()],
            });
        }
        return Ok(DshCommand {
            program: bin.to_string(),
            args: Vec::new(),
        });
    }
    // DSH_BIN unset: search PATH for the globally installed CLI shim.
    #[cfg(windows)]
    if let Some(shim) = find("dsh.cmd") {
        return Ok(DshCommand {
            program: shim,
            args: Vec::new(),
        });
    }
    if let Some(shim) = find("dsh") {
        return Ok(DshCommand {
            program: shim,
            args: Vec::new(),
        });
    }
    Err("dsh binary not found: install @deepseek-ai/dsh or set DSH_BIN".to_string())
}

/// PATH search identical in spirit to the reference `which_node`
/// (.refs/dsh-tauri-desktop src-tauri/src/services/workflow_service.rs:432).
pub fn find_in_path(name: &str) -> Option<String> {
    let path_var = std::env::var_os("PATH")?;
    std::env::split_paths(&path_var)
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
        .map(|p| p.to_string_lossy().into_owned())
}

/// cordis.patch.yml handed to `--patch`: DSH_PATCH overrides, otherwise the
/// monorepo file is located by walking upward from the executable (dev
/// checkout layout).
pub fn resolve_patch_yml() -> Result<PathBuf, String> {
    if let Some(override_path) = nonempty_env("DSH_PATCH") {
        return Ok(PathBuf::from(override_path));
    }
    let exe = std::env::current_exe()
        .map_err(|err| format!("cannot resolve current executable: {err}"))?;
    // TODO(packaged): a bundled app has no monorepo next to the exe. Ship
    // cordis.patch.yml as a Tauri resource and resolve it through
    // `AppHandle::path().resource_dir()` — that requires an AppHandle, which
    // this framework-free module deliberately does not take.
    find_upward_from(
        &exe,
        Path::new("packages").join("desktop-shell").join("cordis.patch.yml").as_path(),
    )
    .ok_or_else(|| {
        "cordis.patch.yml not found: set DSH_PATCH (searched upward from the executable for \
         packages/desktop-shell/cordis.patch.yml)"
            .to_string()
    })
}

/// Walk upward from `start` looking for `relative` (dev-checkout layout).
pub fn find_upward_from(start: &Path, relative: &Path) -> Option<PathBuf> {
    let mut dir = start.parent();
    while let Some(current) = dir {
        let candidate = current.join(relative);
        if candidate.is_file() {
            return Some(candidate);
        }
        dir = current.parent();
    }
    None
}

fn nonempty_env(name: &str) -> Option<String> {
    std::env::var(name).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

/// Loopback control-channel coordinates passed to the sidecar process via env
/// (DSH_DESKTOP_CONTROL_URL / DSH_DESKTOP_CONTROL_TOKEN — see
/// packages/protocol/src/control.ts).
#[derive(Debug, Clone)]
pub struct ControlChannel {
    pub base_url: String,
    pub token: String,
}

/// Per-spawn Windows job-object slot; empty on other platforms.
#[derive(Default)]
struct JobSlot(#[cfg(windows)] Mutex<Option<proc_kill::JobObject>>);

/// Everything shared between the sidecar, the control server and the IPC
/// commands. All locks are short, non-async and never held across `.await`.
pub struct Shared {
    status: RwLock<HostStatus>,
    expected_origin: RwLock<Option<String>>,
    ready_url: RwLock<Option<String>>,
    control: Mutex<Option<ControlChannel>>,
    hello: Mutex<Option<HelloInfo>>,
    hello_seen: AtomicBool,
    webview_attached: AtomicBool,
    events: Mutex<VecDeque<ShellControlEvent>>,
    child: tokio::sync::Mutex<Option<tokio::process::Child>>,
    pid: AtomicU32,
    generation: AtomicU64,
    profile: RwLock<String>,
    job: JobSlot,
}

impl Default for Shared {
    fn default() -> Self {
        Self {
            status: RwLock::new(HostStatus::default()),
            expected_origin: RwLock::new(None),
            ready_url: RwLock::new(None),
            control: Mutex::new(None),
            hello: Mutex::new(None),
            hello_seen: AtomicBool::new(false),
            webview_attached: AtomicBool::new(false),
            events: Mutex::new(VecDeque::new()),
            child: tokio::sync::Mutex::new(None),
            pid: AtomicU32::new(0),
            generation: AtomicU64::new(0),
            profile: RwLock::new(launcher::DEFAULT_PROFILE.to_string()),
            job: JobSlot::default(),
        }
    }
}

impl Shared {
    pub fn status(&self) -> HostStatus {
        self.status.read().map(|s| s.clone()).unwrap_or_default()
    }

    pub fn current_profile(&self) -> String {
        self.profile.read().map(|p| p.clone()).unwrap_or_default()
    }

    pub fn set_current_profile(&self, profile: &str) {
        if let Ok(mut guard) = self.profile.write() {
            *guard = profile.to_string();
        }
    }

    pub fn expected_origin(&self) -> Option<String> {
        self.expected_origin.read().ok().and_then(|o| o.clone())
    }

    pub fn ready_url(&self) -> Option<String> {
        self.ready_url.read().ok().and_then(|u| u.clone())
    }

    pub fn ready_endpoint(&self) -> Option<HostEndpoint> {
        let status = self.status();
        if status.state != HostState::Running {
            return None;
        }
        Some(HostEndpoint {
            port: status.port?,
            url: status.url?,
        })
    }

    pub fn control_channel(&self) -> Option<ControlChannel> {
        self.control.lock().ok().and_then(|c| c.clone())
    }

    /// Set once at startup, before the first spawn. The sidecar forwards the
    /// coordinates to the child process env.
    pub fn set_control_channel(&self, channel: ControlChannel) {
        if let Ok(mut guard) = self.control.lock() {
            *guard = Some(channel);
        }
    }

    pub fn hello_seen(&self) -> bool {
        self.hello_seen.load(Ordering::SeqCst)
    }

    pub fn webview_attached(&self) -> bool {
        self.webview_attached.load(Ordering::SeqCst)
    }

    pub fn set_webview_attached(&self) {
        self.webview_attached.store(true, Ordering::SeqCst);
    }

    pub fn hello_info(&self) -> Option<HelloInfo> {
        self.hello.lock().ok().and_then(|h| h.clone())
    }

    pub fn record_hello(&self, info: HelloInfo) {
        if let Ok(mut guard) = self.hello.lock() {
            *guard = Some(info);
        }
        self.hello_seen.store(true, Ordering::SeqCst);
    }

    pub fn pid(&self) -> u32 {
        self.pid.load(Ordering::SeqCst)
    }

    /// Drain the shell → plugin event queue (control channel long-poll).
    pub fn drain_events(&self) -> Vec<ShellControlEvent> {
        match self.events.lock() {
            Ok(mut queue) => queue.drain(..).collect(),
            Err(_) => Vec::new(),
        }
    }

    pub fn enqueue_event(&self, event: ShellControlEvent) {
        if let Ok(mut queue) = self.events.lock() {
            queue.push_back(event);
        }
    }

    fn now_millis() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    fn publish<F: FnOnce(&mut HostStatus)>(&self, mutate: F) {
        if let Ok(mut status) = self.status.write() {
            mutate(&mut status);
        }
    }

    fn set_starting(&self, profile: &str, pid: u32) {
        self.set_current_profile(profile);
        self.pid.store(pid, Ordering::SeqCst);
        self.publish(|s| {
            *s = HostStatus {
                state: HostState::Starting,
                port: None,
                url: None,
                error: None,
                started_at: Some(Self::now_millis()),
            };
        });
    }

    /// Ready-line hit: flip to Running and publish the navigation fence.
    fn set_running(&self, info: &ReadyLineInfo) {
        self.ready_url_write(info.url.clone());
        if let Ok(mut guard) = self.expected_origin.write() {
            *guard = Some(info.origin.clone());
        }
        // A fresh server instance: the previous attach (if any) is stale.
        self.webview_attached.store(false, Ordering::SeqCst);
        self.publish(|s| {
            *s = HostStatus {
                state: HostState::Running,
                port: Some(info.port),
                url: Some(info.url.clone()),
                error: None,
                started_at: Some(Self::now_millis()),
            };
        });
    }

    fn set_error(&self, error: &str) {
        self.publish(|s| {
            s.state = HostState::Error;
            s.error = Some(error.to_string());
        });
    }

    fn set_stopped(&self) {
        self.pid.store(0, Ordering::SeqCst);
        if let Ok(mut guard) = self.expected_origin.write() {
            *guard = None;
        }
        if let Ok(mut guard) = self.ready_url.write() {
            *guard = None;
        }
        self.publish(|s| {
            *s = HostStatus {
                state: HostState::Stopped,
                port: None,
                url: None,
                error: None,
                started_at: None,
            };
        });
    }

    fn ready_url_write(&self, url: String) {
        if let Ok(mut guard) = self.ready_url.write() {
            *guard = Some(url);
        }
    }

    fn bump_generation(&self) -> u64 {
        self.generation.fetch_add(1, Ordering::SeqCst) + 1
    }
}

// ---------------------------------------------------------------------------
// DshSidecar
// ---------------------------------------------------------------------------

/// Owns the sidecar child process. Re-entrancy: the spawn decision is
/// serialized by an async mutex; the ready wait is NOT — a concurrent stop()
/// bumps the generation counter and the wait aborts as "superseded".
pub struct DshSidecar {
    shared: Arc<Shared>,
    sink: EventSink,
    op_lock: tokio::sync::Mutex<()>,
}

impl DshSidecar {
    pub(crate) fn new(shared: Arc<Shared>, sink: EventSink) -> Self {
        Self {
            shared,
            sink,
            op_lock: tokio::sync::Mutex::new(()),
        }
    }

    pub fn status(&self) -> HostStatus {
        self.shared.status()
    }

    /// Spawn the sidecar and wait (bounded) for the ready line.
    ///
    /// Idempotent: returns the live endpoint when already Running; concurrent
    /// callers get a "already starting" error instead of a duplicate process.
    pub async fn start(&self) -> Result<HostEndpoint, String> {
        let generation = {
            let _guard = self.op_lock.lock().await;
            match self.shared.status().state {
                HostState::Running => {
                    return self
                        .shared
                        .ready_endpoint()
                        .ok_or_else(|| "host is running but has no ready endpoint".to_string());
                }
                HostState::Starting => {
                    return Err("dsh host is already starting".to_string());
                }
                HostState::Stopped | HostState::Error => {}
            }
            let profile = self.shared.current_profile();
            self.spawn_process(&profile).map_err(|err| {
                self.shared.set_error(&err);
                self.emit_state();
                err
            })?;
            self.shared.bump_generation()
        };
        // Outside the spawn lock: stop() does not wait for this wait loop —
        // it invalidates the generation instead.
        self.wait_ready(generation).await
    }

    fn spawn_process(&self, profile: &str) -> Result<(), String> {
        let dsh_home = launcher::dsh_home();
        std::fs::create_dir_all(&dsh_home)
            .map_err(|err| format!("cannot create DSH_HOME {}: {err}", dsh_home.display()))?;
        let patch = resolve_patch_yml()?;
        let command = resolve_dsh_command()?;

        let mut cmd = tokio::process::Command::new(&command.program);
        cmd.args(&command.args)
            .args(["--profile", profile, "--patch"])
            .arg(&patch)
            .args(["--port", "0", "--no-open"])
            .env("DSH_HOME", &dsh_home)
            .env("DSH_PROFILE_NAME", profile)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        if let Some(channel) = self.shared.control_channel() {
            cmd.env(control_server::CONTROL_URL_ENV, &channel.base_url)
                .env(control_server::CONTROL_TOKEN_ENV, &channel.token);
        }
        #[cfg(windows)]
        cmd.creation_flags(proc_kill::CREATE_NO_WINDOW);
        #[cfg(unix)]
        cmd.process_group(0);

        tracing::info!(
            "spawning dsh sidecar: {} {} --profile {profile} --port 0 --no-open",
            command.program,
            command.args.join(" ")
        );
        let mut child = cmd.spawn().map_err(|err| format!("dsh spawn failed: {err}"))?;
        let pid = child.id().unwrap_or(0);
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        // Windows: put the child into a kill-on-close job object so even a
        // leaked handle cannot orphan the tree (see proc_kill::JobObject).
        // NOTE: the JobObject must survive into shared state — dropping it
        // closes the job handle, and kill-on-close would terminate the child.
        #[cfg(windows)]
        match child.raw_handle() {
            Some(raw) => match proc_kill::JobObject::create() {
                Ok(job) => {
                    if let Err(err) = job.assign_handle(raw) {
                        tracing::warn!(
                            "job object assignment failed, tree kill degrades to taskkill: {err}"
                        );
                    } else if let Ok(mut slot) = self.shared.job.0.lock() {
                        *slot = Some(job);
                    } else {
                        tracing::error!("job slot lock poisoned; kill-on-close will reap the tree");
                    }
                }
                Err(err) => {
                    tracing::warn!("job object unavailable, falling back to taskkill only: {err}")
                }
            },
            None => tracing::warn!("child raw handle unavailable; job object not assigned"),
        }

        *self.shared.child.lock().await = Some(child);
        self.shared.set_starting(profile, pid);
        self.emit_state();

        if let Some(out) = stdout {
            let shared = self.shared.clone();
            let sink = self.sink.clone();
            tokio::spawn(async move {
                pump_stdout(shared, sink, out).await;
            });
        }
        if let Some(err_stream) = stderr {
            let shared = self.shared.clone();
            let sink = self.sink.clone();
            tokio::spawn(async move {
                pump_stderr(sink, err_stream).await;
            });
        }
        Ok(())
    }

    /// Poll until the ready line flips the status to Running (or the child
    /// dies / a newer generation supersedes this wait).
    async fn wait_ready(&self, generation: u64) -> Result<HostEndpoint, String> {
        let deadline = Instant::now() + READY_DEADLINE;
        loop {
            if self.shared.generation.load(Ordering::SeqCst) != generation {
                return Err("spawn superseded by stop/restart".to_string());
            }
            if let Some(endpoint) = self.shared.ready_endpoint() {
                return Ok(endpoint);
            }
            if Instant::now() >= deadline {
                let msg = "timed out waiting for the dsh ready line (90s)".to_string();
                self.shared.set_error(&msg);
                self.emit_state();
                return Err(msg);
            }
            {
                let mut guard = self.shared.child.lock().await;
                if let Some(child) = guard.as_mut() {
                    match child.try_wait() {
                        Ok(Some(exit)) => {
                            let msg = format!("dsh exited before becoming ready: {exit}");
                            self.shared.set_error(&msg);
                            self.emit_state();
                            return Err(msg);
                        }
                        Ok(None) => {}
                        Err(err) => {
                            let msg = format!("failed to poll dsh process: {err}");
                            self.shared.set_error(&msg);
                            self.emit_state();
                            return Err(msg);
                        }
                    }
                } else {
                    return Err("dsh child handle disappeared before ready".to_string());
                }
            }
            tokio::time::sleep(POLL_INTERVAL).await;
        }
    }

    /// Stop the sidecar (graceful first, forced kill as fallback).
    ///
    /// Deliberately lock-free on the spawn mutex: stopping must never be
    /// blocked by an in-flight ready wait; the generation bump makes that
    /// wait abort instead.
    pub async fn stop(&self) -> Result<(), String> {
        self.shared.bump_generation();
        let child = self.shared.child.lock().await.take();
        let pid = self.shared.pid();
        if pid > 0 {
            let job = self.take_job();
            proc_kill::kill_process_tree(pid, job.as_ref()).await;
        }
        if let Some(mut child) = child {
            // Reap so the tokio runtime does not leave a zombie on unix.
            let _ = child.wait().await;
        }
        self.shared.set_stopped();
        self.emit_state();
        Ok(())
    }

    /// Restart = stop + spawn; returns the fresh endpoint after the new ready
    /// line. This is also what POST /v0/host/restart resolves to.
    pub async fn restart(&self) -> Result<HostEndpoint, String> {
        self.stop().await?;
        // Give the OS a beat to release the old listening socket.
        tokio::time::sleep(Duration::from_millis(300)).await;
        self.start().await
    }

    /// Restart only when a host is currently running (profile switch path).
    pub async fn restart_if_running(&self) -> Result<(), String> {
        if self.status().state == HostState::Running {
            self.restart().await.map(|_| ())
        } else {
            Ok(())
        }
    }

    /// Synchronous best-effort teardown for exit paths (RunEvent::Exit,
    /// tray Quit). The kernel-side kill-on-close job object covers anything
    /// this misses once our process dies.
    pub fn shutdown_now(&self) {
        self.shared.bump_generation();
        let child = match self.shared.child.try_lock() {
            Ok(mut guard) => guard.take(),
            Err(_) => None,
        };
        let pid = self.shared.pid();
        if pid > 0 {
            let job = self.take_job();
            proc_kill::kill_process_tree_blocking(pid, job.as_ref());
        }
        if let Some(mut child) = child {
            let _ = child.start_kill();
        }
        self.shared.set_stopped();
    }

    #[cfg(windows)]
    fn take_job(&self) -> Option<proc_kill::JobObject> {
        self.shared.job.0.lock().ok().and_then(|mut slot| slot.take())
    }

    #[cfg(not(windows))]
    fn take_job(&self) -> Option<proc_kill::JobObject> {
        None
    }

    fn emit_state(&self) {
        (self.sink)(SidecarEvent::State(self.shared.status()));
    }
}

/// stdout pump: every line becomes a `dsh:log` event; the official ready line
/// additionally flips the sidecar to Running.
async fn pump_stdout(shared: Arc<Shared>, sink: EventSink, stream: impl tokio::io::AsyncRead + Unpin) {
    let reader = BufReader::new(stream);
    let mut lines = reader.lines();
    loop {
        match lines.next_line().await {
            Ok(Some(line)) => {
                if let Some(info) = parse_ready_line(&line) {
                    tracing::info!("dsh ready: {} (port {})", info.url, info.port);
                    shared.set_running(&info);
                    (sink)(SidecarEvent::State(shared.status()));
                } else {
                    (sink)(SidecarEvent::Log {
                        level: "info".to_string(),
                        line,
                    });
                }
            }
            Ok(None) => return,
            Err(err) => {
                tracing::warn!("reading sidecar stdout failed: {err}");
                return;
            }
        }
    }
}

/// stderr pump: sidecar errors surface as `dsh:log` error events.
async fn pump_stderr(sink: EventSink, stream: impl tokio::io::AsyncRead + Unpin) {
    let reader = BufReader::new(stream);
    let mut lines = reader.lines();
    loop {
        match lines.next_line().await {
            Ok(Some(line)) => {
                tracing::error!(target: "dsh_sidecar", "{line}");
                (sink)(SidecarEvent::Log {
                    level: "error".to_string(),
                    line,
                });
            }
            Ok(None) => return,
            Err(err) => {
                tracing::warn!("reading sidecar stderr failed: {err}");
                return;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// AppState (Tauri-managed)
// ---------------------------------------------------------------------------

/// The single managed state object. Cheap to clone; every handle sees the
/// same shared state.
#[derive(Clone)]
pub struct AppState {
    pub shared: Arc<Shared>,
    pub sidecar: Arc<DshSidecar>,
}

impl AppState {
    pub fn new(sink: EventSink) -> Self {
        let shared = Arc::new(Shared::default());
        let sidecar = Arc::new(DshSidecar::new(shared.clone(), sink));
        Self { shared, sidecar }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // -- parse_ready_line (mirrors packages/protocol/test/contract.test.ts) --

    #[test]
    fn parses_the_official_ready_line() {
        let info = parse_ready_line("dsh web: http://127.0.0.1:3080/?token=abcDEF-_123").expect("parses");
        assert_eq!(info.url, "http://127.0.0.1:3080/?token=abcDEF-_123");
        assert_eq!(info.origin, "http://127.0.0.1:3080");
        assert_eq!(info.port, 3080);
    }

    #[test]
    fn parses_random_port_and_strips_lan_suffix() {
        let line = "dsh web: http://127.0.0.1:49152/?token=x_y-z9 (LAN: http://192.168.1.4:49152/?token=x_y-z9)";
        let info = parse_ready_line(line).expect("parses");
        assert_eq!(info.port, 49152);
        assert_eq!(info.url, "http://127.0.0.1:49152/?token=x_y-z9");
        assert_eq!(info.origin, "http://127.0.0.1:49152");
    }

    #[test]
    fn rejects_non_ready_lines_and_malformed_ports() {
        assert_eq!(parse_ready_line("dsh web: opening the default browser"), None);
        assert_eq!(parse_ready_line("listening on port 3080"), None);
        assert_eq!(parse_ready_line("dsh web: http://127.0.0.1:0/?token=abc"), None);
        assert_eq!(parse_ready_line("dsh web: http://127.0.0.1:70000/?token=abc"), None);
        assert_eq!(parse_ready_line("dsh web: http://127.0.0.1:3080/?token="), None);
    }

    #[test]
    fn rejects_missing_token_and_wrong_scheme() {
        // token must not be stripped — it is the credential
        assert_eq!(parse_ready_line("dsh web: http://127.0.0.1:3080/"), None);
        assert_eq!(parse_ready_line("dsh web: https://127.0.0.1:3080/?token=abc"), None);
        assert_eq!(parse_ready_line("dsh web: http://0.0.0.0:3080/?token=abc"), None);
    }

    #[test]
    fn tolerates_surrounding_whitespace_and_crlf() {
        let info = parse_ready_line("  dsh web: http://127.0.0.1:3080/?token=abc\r\n").expect("parses");
        assert_eq!(info.port, 3080);
        assert_eq!(info.url, "http://127.0.0.1:3080/?token=abc");
    }

    #[test]
    fn rejects_invalid_token_characters() {
        assert_eq!(parse_ready_line("dsh web: http://127.0.0.1:3080/?token=abc def"), None);
        assert_eq!(parse_ready_line("dsh web: http://127.0.0.1:3080/?token=ab+c"), None);
    }

    // -- resolve_dsh_command --

    fn no_finder(_: &str) -> Option<String> {
        None
    }

    fn finder(name: &'static str) -> impl Fn(&str) -> Option<String> {
        move |wanted: &str| if wanted == name { Some(format!("/usr/bin/{name}")) } else { None }
    }

    #[test]
    fn resolves_script_bin_through_node() {
        let cmd = resolve_dsh_command_from(Some("cli/dsh.mjs"), Some("node24"), &no_finder)
            .expect("resolves");
        assert_eq!(cmd.program, "node24");
        assert_eq!(cmd.args, vec!["cli/dsh.mjs"]);
    }

    #[test]
    fn resolves_script_bin_through_path_node() {
        let cmd = resolve_dsh_command_from(Some("dsh.cjs"), None, &finder("node")).expect("resolves");
        assert_eq!(cmd.program, "/usr/bin/node");
        assert_eq!(cmd.args, vec!["dsh.cjs"]);
    }

    #[test]
    fn passes_plain_binaries_through() {
        let cmd = resolve_dsh_command_from(Some("/opt/dsh/bin/dsh"), None, &no_finder).expect("resolves");
        assert_eq!(cmd.program, "/opt/dsh/bin/dsh");
        assert!(cmd.args.is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn wraps_cmd_shims_in_cmd_exe() {
        let cmd =
            resolve_dsh_command_from(Some(r"C:\Users\me\.dsh\bin\dsh.cmd"), None, &no_finder)
                .expect("resolves");
        assert_eq!(cmd.program, "cmd.exe");
        assert_eq!(cmd.args, vec!["/d", "/s", "/c", r"C:\Users\me\.dsh\bin\dsh.cmd"]);
    }

    #[test]
    fn reports_missing_binary_with_install_hint() {
        let err = resolve_dsh_command_from(None, None, &no_finder).expect_err("must fail");
        assert_eq!(
            err,
            "dsh binary not found: install @deepseek-ai/dsh or set DSH_BIN"
        );
    }

    #[test]
    fn finds_shim_on_path_when_unset() {
        let shim = if cfg!(windows) { "dsh.cmd" } else { "dsh" };
        let cmd = resolve_dsh_command_from(None, None, &finder(shim)).expect("resolves");
        assert_eq!(cmd.program, format!("/usr/bin/{shim}"));
        assert!(cmd.args.is_empty());
    }

    // -- find_upward_from --

    #[test]
    fn finds_file_upward_and_reports_misses() {
        let base = std::env::temp_dir().join(format!("dsh-sidecar-test-{}", std::process::id()));
        let pkg = base.join("repo/packages/desktop-shell");
        std::fs::create_dir_all(&pkg).expect("mkdir");
        std::fs::write(pkg.join("cordis.patch.yml"), "- insert: []\n").expect("write");
        let exe = base.join("repo/target/debug/deps/dsh-test.exe");
        std::fs::write(&exe, b"").expect("write exe placeholder");

        let found = find_upward_from(
            &exe,
            Path::new("packages").join("desktop-shell").join("cordis.patch.yml").as_path(),
        )
        .expect("found");
        assert!(found.ends_with("packages/desktop-shell/cordis.patch.yml"));

        let missing =
            find_upward_from(&base.join("nowhere"), Path::new("packages/desktop-shell/nope.yml"));
        assert_eq!(missing, None);

        let _ = std::fs::remove_dir_all(&base);
    }
}
