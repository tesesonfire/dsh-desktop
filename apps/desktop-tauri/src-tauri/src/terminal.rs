//! "Open terminal" (desktop-terminal analog, slimmed): resolve the platform's
//! terminal launcher and start a visible console in a directory. Command
//! resolution is a pure, unit-tested function; the real spawn happens only on
//! user action. The terminal is an independent process — nothing is injected
//! into any web surface.

use std::path::{Path, PathBuf};

/// On Windows the broker itself may need CREATE_NO_WINDOW while the child
/// console must be visible.
#[derive(Debug, PartialEq)]
pub struct TerminalCommand {
    pub program: String,
    pub args: Vec<String>,
}

type ExistsProbe = dyn Fn(&Path) -> bool;

/// Windows: Windows Terminal → pwsh → powershell → cmd broker (`start`).
pub fn resolve_windows_terminal(
    dir: &str,
    path_env: &str,
    exists: &ExistsProbe,
) -> TerminalCommand {
    let names = ["wt.exe", "pwsh.exe", "powershell.exe"];
    for name in names {
        for dir_entry in path_env.split(';') {
            if dir_entry.is_empty() {
                continue;
            }
            let candidate = PathBuf::from(dir_entry).join(name);
            if exists(&candidate) {
                return TerminalCommand { program: name.to_string(), args: vec!["-d".into(), dir.to_string()] };
            }
        }
    }
    TerminalCommand {
        program: "cmd.exe".into(),
        args: vec!["/c".into(), "start".into(), "".into(), "cmd.exe".into(), "/k".into(), format!("cd /d \"{dir}\"")],
    }
}

/// Linux: x-terminal-emulator → gnome-terminal → konsole → xfce4-terminal.
fn resolve_linux_terminal(dir: &str, path_env: &str, exists: &ExistsProbe) -> Option<TerminalCommand> {
    let candidates: [(&str, &str); 4] = [
        ("x-terminal-emulator", "-T"),
        ("gnome-terminal", "--working-directory"),
        ("konsole", "--workdir"),
        ("xfce4-terminal", "--default-working-directory"),
    ];
    for (name, flag) in candidates {
        for dir_entry in path_env.split(':') {
            if dir_entry.is_empty() {
                continue;
            }
            let candidate = PathBuf::from(dir_entry).join(name);
            if exists(&candidate) {
                return Some(TerminalCommand {
                    program: name.to_string(),
                    args: vec![flag.to_string(), dir.to_string()],
                });
            }
        }
    }
    None
}

pub fn resolve_terminal_command(
    dir: &str,
    platform: &str,
    path_env: &str,
    exists: &ExistsProbe,
) -> Result<TerminalCommand, String> {
    match platform {
        "windows" => Ok(resolve_windows_terminal(dir, path_env, exists)),
        "macos" => Ok(TerminalCommand { program: "open".into(), args: vec!["-a".into(), "Terminal".into(), dir.to_string()] }),
        "linux" => {
            resolve_linux_terminal(dir, path_env, exists)
                .ok_or_else(|| "no terminal emulator found on PATH".to_string())
        }
        other => Err(format!("unsupported platform for terminals: {other}")),
    }
}

/// Spawn a visible terminal in `dir` (the app data dir in practice). Fire and
/// forget: the child outlives the shell on purpose.
pub fn open_terminal_in(dir: &str) -> Result<(), String> {
    let path_env = std::env::var("PATH").unwrap_or_default();
    let exists = |path: &Path| path.exists();
    let resolved = resolve_terminal_command(dir, std::env::consts::OS, &path_env, &exists)?;
    let program = resolved.program.clone();
    let mut command = std::process::Command::new(&program);
    command.args(&resolved.args);
    #[cfg(windows)]
    {
        // The broker (cmd.exe) must not flash a console; the terminal it
        // starts creates its own visible window.
        use std::os::windows::process::CommandExt;
        if program == "cmd.exe" {
            command.creation_flags(0x0800_0000);
        }
    }
    command
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("spawn {program}: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn probe_present(names: &[&str]) -> Box<ExistsProbe> {
        Box::new(move |path: &Path| {
            names.iter().any(|name| path.ends_with(name))
        })
    }

    #[test]
    fn windows_prefers_wt_then_falls_back_to_cmd_broker() {
        let resolved = resolve_windows_terminal("C:\\data", "C:\\bin", &|path| path.ends_with("wt.exe"));
        assert_eq!(resolved.program, "wt.exe");
        assert_eq!(resolved.args, vec!["-d", "C:\\data"]);

        let bare = resolve_windows_terminal("C:\\data", "C:\\bin", &|_| false);
        assert_eq!(bare.program, "cmd.exe");
        assert_eq!(bare.args[0], "/c");
        assert!(bare.args.contains(&"start".to_string()));
    }

    #[test]
    fn macos_uses_open_terminal() {
        let resolved = resolve_terminal_command("/tmp/d", "macos", "", &|_| false).expect("macos");
        assert_eq!(resolved.program, "open");
        assert_eq!(resolved.args, vec!["-a", "Terminal", "/tmp/d"]);
    }

    #[test]
    fn linux_picks_first_emulator_and_errors_without_any() {
        let resolved =
            resolve_terminal_command("/tmp/d", "linux", "/usr/bin:/usr/local/bin", &probe_present(&["gnome-terminal"]))
                .expect("gnome-terminal present");
        assert_eq!(resolved.program, "gnome-terminal");
        assert_eq!(resolved.args, vec!["--working-directory", "/tmp/d"]);
        assert!(resolve_terminal_command("/tmp/d", "linux", "/usr/bin", &|_| false).is_err());
    }
}
