//! DesktopBridge IPC commands — the Tauri half of packages/protocol/src/
//! bridge.ts. The 14 command names, parameters and result types must match
//! `DESKTOP_BRIDGE_METHODS` verbatim; scripts/audit-contract.mjs diffs this
//! file's `#[tauri::command]` set against the protocol list.

use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

use crate::diagnostics;
use crate::launcher::{self, Profile};
use crate::plugin_inventory;
use crate::settings;
use crate::settings_window;
use crate::sidecar::{AppState, HostEndpoint, HostStatus};

// -- 生命周期 ----------------------------------------------------------------

/// Spawn the sidecar and wait for the ready line.
/// Idempotent: returns the live endpoint when already running.
#[tauri::command]
pub async fn host_start(state: tauri::State<'_, AppState>) -> Result<HostEndpoint, String> {
    state.sidecar.start().await
}

/// Kill the sidecar process tree.
#[tauri::command]
pub async fn host_stop(state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.sidecar.stop().await
}

/// Stop, then spawn again; resolves with the fresh endpoint.
#[tauri::command]
pub async fn host_restart(state: tauri::State<'_, AppState>) -> Result<HostEndpoint, String> {
    state.sidecar.restart().await
}

/// Current status snapshot (no waiting).
#[tauri::command]
pub fn host_status(state: tauri::State<'_, AppState>) -> Result<HostStatus, String> {
    Ok(state.sidecar.status())
}

// -- 窗口 --------------------------------------------------------------------

fn main_window(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    app.get_webview_window("main")
        .ok_or_else(|| "main window is not available".to_string())
}

#[tauri::command]
pub fn window_show(app: AppHandle) -> Result<(), String> {
    let window = main_window(&app)?;
    let _ = window.show();
    let _ = window.unminimize();
    Ok(())
}

#[tauri::command]
pub fn window_hide(app: AppHandle) -> Result<(), String> {
    let window = main_window(&app)?;
    let _ = window.hide();
    Ok(())
}

#[tauri::command]
pub fn window_focus(app: AppHandle) -> Result<(), String> {
    let window = main_window(&app)?;
    let _ = window.unminimize();
    let _ = window.set_focus();
    Ok(())
}

/// Open (or focus) the dedicated settings window.
#[tauri::command]
pub fn window_open_settings(app: AppHandle) -> Result<(), String> {
    settings_window::open_settings(&app)
}

// -- Profile ------------------------------------------------------------------

#[tauri::command]
pub fn profile_list() -> Result<Vec<Profile>, String> {
    Ok(launcher::list_profiles())
}

#[tauri::command]
pub fn profile_current() -> Result<Profile, String> {
    Ok(launcher::profile_detail(&launcher::current_profile()))
}

/// Persist the selection and apply it immediately: a running host restarts on
/// the new profile (`--profile` is a launcher flag, fixed at spawn time).
#[tauri::command]
pub async fn profile_switch(
    name: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    launcher::switch_profile(&name).map_err(|err| err.to_string())?;
    state.sidecar.restart_if_running().await
}

// -- 系统 ---------------------------------------------------------------------

/// Shared with the tray menu (ipc::open_data_dir_impl).
pub(crate) fn open_data_dir_impl(app: &AppHandle) -> Result<(), String> {
    let dir = launcher::dsh_home();
    std::fs::create_dir_all(&dir).map_err(|err| format!("cannot create data dir: {err}"))?;
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|err| format!("failed to open data dir: {err}"))
}

#[tauri::command]
pub fn open_data_dir(app: AppHandle) -> Result<(), String> {
    open_data_dir_impl(&app)
}

/// Open a URL in the system browser / mail client. Only http, https and
/// mailto are allowed — everything else (file:, javascript:, ...) is refused.
#[tauri::command]
pub fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    let parsed = tauri::Url::parse(&url).map_err(|_| format!("invalid url: {url}"))?;
    match parsed.scheme() {
        "http" | "https" | "mailto" => {}
        _ => {
            return Err(format!(
                "only http, https and mailto urls may be opened externally (got {})",
                parsed.scheme()
            ))
        }
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|err| format!("failed to open external url: {err}"))
}

#[tauri::command]
pub fn get_app_version() -> Result<String, String> {
    Ok(env!("CARGO_PKG_VERSION").to_string())
}

// -- v1.1：设置 / 插件清单 / 诊断 ------------------------------------------

/// Load shell settings (defaults when the file is missing or corrupt).
#[tauri::command]
pub fn settings_get() -> Result<settings::DesktopSettings, String> {
    Ok(settings::load_from(&settings::settings_path()))
}

/// Validate → persist → apply. Zoom lands on the live webContents immediately;
/// close/start keys are read at close/mount time.
#[tauri::command]
pub fn settings_set(patch: serde_json::Value) -> Result<settings::DesktopSettings, String> {
    let current = settings::load_from(&settings::settings_path());
    let next = settings::apply_patch(&current, &patch).map_err(|err| err.0)?;
    settings::save_to(&settings::settings_path(), &next).map_err(|err| err.0)?;
    // TODO(verify-with-cargo): WebviewWindow::set_zoom exists in tauri 2.x but
    // is not exercised by the local reference crate — CI compiles this.
    if let Some(app) = crate::APP.get() {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.set_zoom(next.zoom_factor);
        }
    }
    Ok(next)
}

/// Read-only inventory of DSH plugins in the current profile.
#[tauri::command]
pub fn plugin_list() -> Result<Vec<plugin_inventory::InstalledPlugin>, String> {
    let profile = launcher::current_profile();
    Ok(plugin_inventory::list_profile_plugins(&launcher::profiles_dir().join(profile)))
}

/// Collect + write the diagnostics report to the desktop dir, reveal it.
#[tauri::command]
pub fn diagnostics_export(app: AppHandle, state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    let host_status = serde_json::to_value(state.shared.status()).map_err(|err| err.to_string())?;
    let host_hello = state
        .shared
        .hello_info()
        .and_then(|hello| serde_json::to_value(hello).ok())
        .unwrap_or(serde_json::Value::Null);
    let profiles = serde_json::to_value(launcher::list_profiles()).map_err(|err| err.to_string())?;
    let current = settings::load_from(&settings::settings_path());
    let settings_value = serde_json::to_value(current).map_err(|err| err.to_string())?;
    let desktop_state = std::fs::read_to_string(launcher::desktop_state_path())
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .unwrap_or(serde_json::Value::Null);

    let logs_dir = app.path().app_data_dir().ok().map(|dir| dir.join("logs"));
    let dsh_home = launcher::dsh_home();
    let input = diagnostics::DiagnosticsInput {
        app_version: env!("CARGO_PKG_VERSION"),
        platform: std::env::consts::OS,
        dsh_home: &dsh_home.to_string_lossy(),
        logs_dir: logs_dir.as_deref().unwrap_or(std::path::Path::new(".")),
        host_status,
        host_hello,
        profiles,
        settings: settings_value,
        desktop_state,
    };
    let report = diagnostics::collect(&input);
    let dir = dirs::desktop_dir().or_else(dirs::data_dir).unwrap_or_else(std::env::temp_dir);
    let file = diagnostics::write_report(&dir, &report)?;
    Ok(serde_json::json!({ "path": file.to_string_lossy() }))
}
