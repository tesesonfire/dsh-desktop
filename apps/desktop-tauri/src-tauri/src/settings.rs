//! Shell settings (contract v1.1): persistence + validation for
//! DesktopSettings { closeToTray, startMinimized, zoomFactor }.
//!
//! Stored as `<data dir>/org.dsh-desktop.tauri/settings.json` (same root as
//! the tracing logs). Writes are atomic (tmp+rename). Unknown keys and
//! out-of-range zoom are rejected — renderer bugs must surface, not hide.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

pub const ZOOM_MIN: f64 = 0.5;
pub const ZOOM_MAX: f64 = 2.0;

/// camelCase on the wire to match packages/protocol/src/bridge.ts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DesktopSettings {
    pub close_to_tray: bool,
    pub start_minimized: bool,
    pub zoom_factor: f64,
}

impl Default for DesktopSettings {
    fn default() -> Self {
        // DESKTOP_SETTINGS_DEFAULTS
        Self {
            close_to_tray: true,
            start_minimized: false,
            zoom_factor: 1.0,
        }
    }
}

#[derive(Debug)]
pub struct SettingsError(pub String);

impl std::fmt::Display for SettingsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

pub fn settings_path() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("org.dsh-desktop.tauri")
        .join("settings.json")
}

/// Validate a patch against the current settings (serde_json::Value in, since
/// the renderer controls the shape). Unknown keys are rejected.
pub fn apply_patch(current: &DesktopSettings, patch: &serde_json::Value) -> Result<DesktopSettings, SettingsError> {
    let Some(object) = patch.as_object() else {
        return Err(SettingsError("settings patch must be a JSON object".into()));
    };
    let mut next = current.clone();
    for (key, value) in object {
        match key.as_str() {
            "closeToTray" => {
                next.close_to_tray = value.as_bool().ok_or_else(|| SettingsError("closeToTray must be a boolean".into()))?;
            }
            "startMinimized" => {
                next.start_minimized = value.as_bool().ok_or_else(|| SettingsError("startMinimized must be a boolean".into()))?;
            }
            "zoomFactor" => {
                let zoom = value.as_f64().ok_or_else(|| SettingsError("zoomFactor must be a number".into()))?;
                if !(ZOOM_MIN..=ZOOM_MAX).contains(&zoom) {
                    return Err(SettingsError(format!("zoomFactor must be within [{ZOOM_MIN}, {ZOOM_MAX}]")));
                }
                next.zoom_factor = zoom;
            }
            other => return Err(SettingsError(format!("unknown settings key: {other}"))),
        }
    }
    Ok(next)
}

/// Load settings, falling back to defaults for a missing or corrupt file.
pub fn load_from(path: &PathBuf) -> DesktopSettings {
    match std::fs::read_to_string(path) {
        Ok(text) => match serde_json::from_str::<serde_json::Value>(&text) {
            Ok(value) => apply_patch(&DesktopSettings::default(), &value).unwrap_or_default(),
            Err(_) => DesktopSettings::default(),
        },
        Err(_) => DesktopSettings::default(),
    }
}

/// Atomic write (tmp + rename in the same directory).
pub fn save_to(path: &PathBuf, settings: &DesktopSettings) -> Result<(), SettingsError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| SettingsError(format!("create settings dir: {err}")))?;
    }
    let tmp = path.with_extension(format!("json.tmp-{}", unix_ts()));
    let payload = serde_json::to_string_pretty(settings).map_err(|err| SettingsError(format!("serialize: {err}")))?;
    std::fs::write(&tmp, payload).map_err(|err| SettingsError(format!("write settings: {err}")))?;
    std::fs::rename(&tmp, path).map_err(|err| SettingsError(format!("rename settings: {err}")))?;
    Ok(())
}

pub fn unix_ts() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patch_validation_rejects_bad_input() {
        let base = DesktopSettings::default();
        assert!(apply_patch(&base, &serde_json::json!({"theme": "dark"})).is_err());
        assert!(apply_patch(&base, &serde_json::json!({"zoomFactor": 0.4})).is_err());
        assert!(apply_patch(&base, &serde_json::json!({"zoomFactor": 3.0})).is_err());
        assert!(apply_patch(&base, &serde_json::json!({"closeToTray": "yes"})).is_err());
        assert!(apply_patch(&base, &serde_json::Value::Null).is_err());
    }

    #[test]
    fn patch_validation_accepts_good_input() {
        let base = DesktopSettings::default();
        let next = apply_patch(&base, &serde_json::json!({"startMinimized": true, "zoomFactor": 1.5}))
            .expect("valid patch");
        assert!(next.start_minimized);
        assert_eq!(next.zoom_factor, 1.5);
        assert!(next.close_to_tray);
    }

    #[test]
    fn round_trips_through_disk_and_recovers_from_corruption() {
        let dir = std::env::temp_dir().join(format!("dsh-settings-test-{}", std::process::id()));
        let path = dir.join("settings.json");
        let _ = std::fs::remove_dir_all(&dir);
        let saved = DesktopSettings { close_to_tray: false, start_minimized: true, zoom_factor: 1.4 };
        save_to(&path, &saved).expect("save");
        assert_eq!(load_from(&path), saved);
        std::fs::write(&path, "{broken").expect("corrupt");
        assert_eq!(load_from(&path), DesktopSettings::default());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
