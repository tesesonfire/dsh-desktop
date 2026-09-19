//! DesktopBridge IPC commands — the Tauri half of packages/protocol/src/
//! bridge.ts. The 14 command names, parameters and result types must match
//! `DESKTOP_BRIDGE_METHODS` verbatim; scripts/audit-contract.mjs diffs this
//! file's `#[tauri::command]` set against the protocol list.

use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

use crate::launcher::{self, Profile};
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
