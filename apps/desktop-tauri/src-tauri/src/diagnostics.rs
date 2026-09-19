//! Diagnostics export (desktop-diagnostics analog, slimmed): a masked,
//! read-only JSON snapshot of shell state + recent log tail, written to the
//! user's desktop and revealed in the file manager. No runtime file is
//! modified.

use std::fs;
use std::path::{Path, PathBuf};

use crate::settings::unix_ts;

/// `token=<base64url>` is a credential; it must never leave the machine.
pub fn mask_tokens(text: &str) -> String {
    // Rust std has no regex; the token alphabet is exactly [A-Za-z0-9_-].
    // Scan for "token=" and cut the run of alphabet characters after it.
    let mut result = String::with_capacity(text.len());
    let bytes = text.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if text[index..].starts_with("token=") {
            result.push_str("token=***");
            index += "token=".len();
            while index < bytes.len() {
                let b = bytes[index];
                let keep = b.is_ascii_alphanumeric() || b == b'_' || b == b'-';
                if !keep {
                    break;
                }
                index += 1;
            }
            continue;
        }
        // copy the next full UTF-8 scalar
        let ch_len = text[index..].chars().next().map(char::len_utf8).unwrap_or(1);
        result.push_str(&text[index..index + ch_len]);
        index += ch_len;
    }
    result
}

/// Newest log file in `logs_dir`, tail `lines`, every line masked.
pub fn recent_log_tail(logs_dir: &Path, lines: usize) -> Vec<String> {
    let newest = newest_log_file(logs_dir);
    let Some(file) = newest else { return Vec::new() };
    let Ok(content) = fs::read_to_string(file) else { return Vec::new() };
    content
        .lines()
        .filter(|line| !line.trim().is_empty())
        .rev()
        .take(lines)
        .rev()
        .map(mask_tokens)
        .collect()
}

fn newest_log_file(logs_dir: &Path) -> Option<PathBuf> {
    let mut newest: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in fs::read_dir(logs_dir).ok()?.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let modified = meta.modified().ok()?;
        if newest.as_ref().map_or(true, |(time, _)| modified > *time) {
            newest = Some((modified, path));
        }
    }
    newest.map(|(_, path)| path)
}

pub struct DiagnosticsInput<'a> {
    pub app_version: &'a str,
    pub platform: &'a str,
    pub dsh_home: &'a str,
    pub logs_dir: &'a Path,
    pub host_status: serde_json::Value,
    pub host_hello: serde_json::Value,
    pub profiles: serde_json::Value,
    pub settings: serde_json::Value,
    pub desktop_state: serde_json::Value,
}

pub fn collect(input: &DiagnosticsInput<'_>) -> serde_json::Value {
    serde_json::json!({
        "generatedAt": chrono_less_timestamp(),
        "appVersion": input.app_version,
        "platform": input.platform,
        "dshHome": input.dsh_home,
        "hostStatus": input.host_status,
        "hostHello": input.host_hello,
        "profiles": input.profiles,
        "settings": input.settings,
        "desktopState": input.desktop_state,
        "recentLog": recent_log_tail(input.logs_dir, 200),
    })
}

fn chrono_less_timestamp() -> String {
    // ISO-8601-lite without a chrono dependency; ordering is what matters.
    let secs = unix_ts();
    format!("{secs}Z")
}

/// Write the report as `dsh-desktop-diagnostics-<ts>.json` under `dir`.
pub fn write_report(dir: &Path, report: &serde_json::Value) -> Result<PathBuf, String> {
    fs::create_dir_all(dir).map_err(|err| format!("create dir: {err}"))?;
    let file = dir.join(format!("dsh-desktop-diagnostics-{}.json", unix_ts()));
    let payload = serde_json::to_string_pretty(report).map_err(|err| format!("serialize: {err}"))?;
    fs::write(&file, payload).map_err(|err| format!("write: {err}"))?;
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masks_tokens_without_a_regex_dependency() {
        assert_eq!(mask_tokens("dsh web: http://127.0.0.1:3080/?token=abcDEF-_123"), "dsh web: http://127.0.0.1:3080/?token=***");
        assert_eq!(mask_tokens("plain line"), "plain line");
        assert_eq!(mask_tokens("token=abc (LAN: http://x/?token=zzz)"), "token=*** (LAN: http://x/?token=***)");
        assert_eq!(mask_tokens("keep unicode √ token=secret!"), "keep unicode √ token=***!");
    }

    #[test]
    fn write_report_lands_on_disk() {
        let dir = std::env::temp_dir().join(format!("dsh-diag-test-{}", std::process::id()));
        let report = serde_json::json!({"appVersion": "0.1.0"});
        let file = write_report(&dir, &report).expect("write");
        assert!(file.exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
