//! Profile discovery and desktop-state persistence.
//!
//! A DSH profile lives at `$DSH_HOME/profiles/<name>/` with a `package.json`
//! manifest whose `dsh.profile.bundles` array lists the composed bundles
//! (see PLAN.md §1.3). The shell's own state (current profile + a
//! last-known-good rollback pointer) persists atomically to
//! `desktop-state.json` inside the same DSH home.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The CLI rejects `--profile desktop` (official Electron's own), so the
/// shell ships its own profile name (PLAN.md §1.1).
pub const DEFAULT_PROFILE: &str = "dsh-desktop-tauri";

/// Mirrors `Profile` in packages/protocol/src/bridge.ts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Profile {
    pub name: String,
    pub path: String,
    pub bundles: Vec<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum LauncherError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("serialization error: {0}")]
    Serde(#[from] serde_json::Error),
    #[error("desktop state file is invalid: {0}")]
    InvalidState(String),
    #[error("invalid profile name: {0}")]
    InvalidName(String),
}

/// Shell-local persistence: current profile + last-known-good rollback target.
/// Serialized keys are camelCase (`currentProfile` / `lastKnownGood`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopState {
    pub current_profile: String,
    pub last_known_good: Option<String>,
}

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

/// `DSH_HOME` env override, else `<home>/.dsh` (the CLI's default layout).
pub fn dsh_home() -> PathBuf {
    if let Some(home) = std::env::var_os("DSH_HOME") {
        let path = PathBuf::from(home);
        if !path.as_os_str().is_empty() {
            return path;
        }
    }
    match dirs::home_dir() {
        Some(home) => home.join(".dsh"),
        None => PathBuf::from(".dsh"),
    }
}

pub fn profiles_dir() -> PathBuf {
    dsh_home().join("profiles")
}

pub fn desktop_state_path() -> PathBuf {
    dsh_home().join("desktop-state.json")
}

// ---------------------------------------------------------------------------
// Desktop state persistence (atomic tmp-file + rename)
// ---------------------------------------------------------------------------

/// Read the desktop state file; `None` when it does not exist yet.
pub fn read_desktop_state_at(path: &Path) -> Result<Option<DesktopState>, LauncherError> {
    match std::fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str(&raw)
            .map(Some)
            .map_err(|err| LauncherError::InvalidState(format!("{}: {err}", path.display()))),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err.into()),
    }
}

/// Atomically persist the desktop state (write tmp sibling, then rename —
/// `std::fs::rename` replaces an existing destination on Windows too).
pub fn write_desktop_state_at(path: &Path, state: &DesktopState) -> Result<(), LauncherError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(state)?)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// The profile the shell will spawn (`--profile <name>`).
pub fn current_profile() -> String {
    match read_desktop_state_at(&desktop_state_path()) {
        Ok(Some(state)) if !state.current_profile.trim().is_empty() => state.current_profile,
        _ => DEFAULT_PROFILE.to_string(),
    }
}

/// Switch profiles: the outgoing profile becomes the last-known-good rollback
/// pointer, then the selection is persisted atomically.
pub fn switch_profile(name: &str) -> Result<(), LauncherError> {
    validate_profile_name(name)?;
    let path = desktop_state_path();
    let previous = read_desktop_state_at(&path)?;
    let state = DesktopState {
        current_profile: name.to_string(),
        last_known_good: previous
            .as_ref()
            .map(|s| s.current_profile.clone())
            .filter(|p| p != name),
    };
    write_desktop_state_at(&path, &state)
}

fn validate_profile_name(name: &str) -> Result<(), LauncherError> {
    let trimmed = name.trim();
    if trimmed.is_empty()
        || trimmed.len() > 64
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains("..")
    {
        return Err(LauncherError::InvalidName(trimmed.to_string()));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Profile discovery
// ---------------------------------------------------------------------------

/// Every profile directory under `$DSH_HOME/profiles`, sorted by name.
/// Directories without a readable manifest are listed with empty bundles.
pub fn list_profiles() -> Vec<Profile> {
    let dir = profiles_dir();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut profiles: Vec<Profile> = entries
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.path().is_dir())
        .map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            profile_detail(&name)
        })
        .collect();
    profiles.sort_by(|a, b| a.name.cmp(&b.name));
    profiles
}

/// Describe one profile by name (whether or not the directory exists yet).
pub fn profile_detail(name: &str) -> Profile {
    let path = profiles_dir().join(name);
    Profile {
        name: name.to_string(),
        path: path.to_string_lossy().into_owned(),
        bundles: read_manifest_bundles(&path),
    }
}

/// Extract `dsh.profile.bundles` from the profile's package.json manifest.
fn read_manifest_bundles(profile_dir: &Path) -> Vec<String> {
    let Ok(raw) = std::fs::read_to_string(profile_dir.join("package.json")) else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return Vec::new();
    };
    value
        .get("dsh")
        .and_then(|dsh| dsh.get("profile"))
        .and_then(|profile| profile.get("bundles"))
        .and_then(|bundles| bundles.as_array())
        .map(|bundles| {
            bundles
                .iter()
                .filter_map(|bundle| bundle.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_home(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "dsh-launcher-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.subsec_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).expect("mkdir");
        dir
    }

    #[test]
    fn desktop_state_roundtrip_is_atomic_and_camel_case() {
        let home = temp_home("roundtrip");
        let path = home.join("desktop-state.json");
        assert!(read_desktop_state_at(&path).expect("read missing").is_none());

        let state = DesktopState {
            current_profile: "dsh-desktop-electron".to_string(),
            last_known_good: Some(DEFAULT_PROFILE.to_string()),
        };
        write_desktop_state_at(&path, &state).expect("write");

        // tmp sibling must be gone after the atomic rename
        assert!(!path.with_extension("json.tmp").exists());
        let raw = std::fs::read_to_string(&path).expect("read raw");
        assert!(raw.contains("\"currentProfile\""));
        assert!(raw.contains("\"lastKnownGood\""));

        let reloaded = read_desktop_state_at(&path).expect("read back").expect("some");
        assert_eq!(reloaded.current_profile, "dsh-desktop-electron");
        assert_eq!(reloaded.last_known_good.as_deref(), Some(DEFAULT_PROFILE));

        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn switch_profile_sets_rollback_pointer_and_rejects_traversal() {
        let home = temp_home("switch");
        // SAFETY: this test binary owns DSH_HOME for the duration of the call.
        let previous = std::env::var("DSH_HOME").ok();
        std::env::set_var("DSH_HOME", &home);

        switch_profile("dsh-desktop-tauri").expect("first switch");
        switch_profile("dsh-desktop-electron").expect("second switch");
        let state = read_desktop_state_at(&desktop_state_path())
            .expect("read")
            .expect("some");
        assert_eq!(state.current_profile, "dsh-desktop-electron");
        assert_eq!(state.last_known_good.as_deref(), Some("dsh-desktop-tauri"));
        assert_eq!(current_profile(), "dsh-desktop-electron");

        for bad in ["", "../escape", r"back\slash", "a/b"] {
            assert!(switch_profile(bad).is_err(), "must reject {bad:?}");
        }

        match previous {
            Some(value) => std::env::set_var("DSH_HOME", value),
            None => std::env::remove_var("DSH_HOME"),
        }
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn profile_discovery_reads_manifest_bundles() {
        let home = temp_home("discovery");
        let profile_dir = home.join("profiles/dsh-desktop-tauri");
        std::fs::create_dir_all(&profile_dir).expect("mkdir");
        std::fs::write(
            profile_dir.join("package.json"),
            r#"{ "name": "p", "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-web-app"] } } }"#,
        )
        .expect("write manifest");
        std::fs::create_dir_all(home.join("profiles/empty-profile")).expect("mkdir");

        // SAFETY: this test binary owns DSH_HOME for the duration of the call.
        let previous = std::env::var("DSH_HOME").ok();
        std::env::set_var("DSH_HOME", &home);

        let profiles = list_profiles();
        assert_eq!(profiles.len(), 2);
        let named = profiles.iter().find(|p| p.name == "dsh-desktop-tauri").expect("present");
        assert_eq!(
            named.bundles,
            vec!["@deepseek-ai/dsh-base".to_string(), "dsh-web-app".to_string()]
        );
        let empty = profiles.iter().find(|p| p.name == "empty-profile").expect("present");
        assert!(empty.bundles.is_empty());

        match previous {
            Some(value) => std::env::set_var("DSH_HOME", value),
            None => std::env::remove_var("DSH_HOME"),
        }
        let _ = std::fs::remove_dir_all(&home);
    }
}
