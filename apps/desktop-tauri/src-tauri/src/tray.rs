//! System tray v2 — three-group structure aligned with the official desktop
//! runtime: window group, profiles group (radio switch), tools group (data
//! dir, terminal, restart host, diagnostics) and Quit. The menu is rebuilt
//! after profile switches so radio states stay honest. Menu shape mirrors
//! apps/desktop-electron/src/main/tray.ts.

use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

use crate::ipc;
use crate::launcher;
use crate::sidecar::AppState;

const MAX_PROFILE_ITEMS: usize = 10;

/// Create the tray icon. Called once from setup; the icon falls back to the
/// system default when no window icon is bundled.
pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let menu = build_menu(app)?;

    let mut builder = TrayIconBuilder::with_id("dsh-desktop-tray")
        .tooltip("DSH Desktop")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main_window(app),
            "hide" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }
            "open-data-dir" => {
                if let Err(err) = ipc::open_data_dir_impl(app) {
                    tracing::error!("tray open-data-dir failed: {err}");
                }
            }
            "open-terminal" => {
                let dir = app
                    .path()
                    .app_data_dir()
                    .map(|path| path.to_string_lossy().to_string())
                    .unwrap_or_else(|_| std::env::temp_dir().to_string_lossy().to_string());
                if let Err(err) = crate::terminal::open_terminal_in(&dir) {
                    tracing::error!("tray open-terminal failed: {err}");
                }
            }
            "export-diagnostics" => {
                if let Err(err) = ipc::diagnostics_export(app.clone(), app.state::<AppState>()) {
                    tracing::error!("tray export-diagnostics failed: {err}");
                }
            }
            // Restart is long-running (waits for the new ready line); fire and
            // forget so the menu handler returns immediately.
            "restart-host" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let state = app.state::<AppState>();
                    if let Err(err) = state.sidecar.restart().await {
                        tracing::error!("tray restart-host failed: {err}");
                    }
                });
            }
            "quit" => {
                crate::shutdown_all(app);
                app.exit(0);
            }
            other => {
                if let Some(name) = other.strip_prefix("profile:") {
                    if let Err(err) = launcher::switch_profile(name) {
                        tracing::error!("tray profile switch to {name} failed: {err:?}");
                    } else if let Err(err) = replace_menu(app) {
                        tracing::error!("tray menu rebuild after profile switch failed: {err}");
                    }
                }
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    } else {
        tracing::warn!("no default window icon found; tray will use the system default");
    }

    builder.build(app)?;
    Ok(())
}

/// Build the full menu from the current profile list. Profiles are radio
/// items (≤10; unavailable profiles are simply not listed).
fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "hide", "隐藏主窗口", true, None::<&str>)?;
    let sep0 = PredefinedMenuItem::separator(app)?;
    let open_data_dir = MenuItem::with_id(app, "open-data-dir", "打开数据目录", true, None::<&str>)?;
    let open_terminal = MenuItem::with_id(app, "open-terminal", "打开终端", true, None::<&str>)?;
    let restart_host = MenuItem::with_id(app, "restart-host", "重启 Host", true, None::<&str>)?;
    let export_diagnostics = MenuItem::with_id(app, "export-diagnostics", "导出诊断", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;

    let profiles = launcher::list_profiles();
    let current = launcher::current_profile();
    let mut profile_items: Vec<CheckMenuItem<tauri::Wry>> = Vec::new();
    for profile in profiles.iter().take(MAX_PROFILE_ITEMS) {
        profile_items.push(CheckMenuItem::with_id(
            app,
            format!("profile:{}", profile.name),
            profile.name.clone(),
            true,
            profile.name == current,
            None::<&str>,
        )?);
    }
    let profiles_refs: Vec<&dyn IsMenuItem<tauri::Wry>> =
        profile_items.iter().map(|item| item as &dyn IsMenuItem<tauri::Wry>).collect();
    let profiles_menu = Submenu::with_items(app, "Profile", true, &profiles_refs)?;

    let items: Vec<&dyn IsMenuItem<tauri::Wry>> = vec![
        &show,
        &hide,
        &sep0,
        &profiles_menu,
        &open_data_dir,
        &open_terminal,
        &restart_host,
        &export_diagnostics,
        &sep1,
        &quit,
    ];
    Menu::with_items(app, &items)
}

/// Swap the tray menu for a freshly built one (profile switches).
fn replace_menu(app: &AppHandle) -> tauri::Result<()> {
    let menu = build_menu(app)?;
    if let Some(tray) = app.tray_by_id("dsh-desktop-tray") {
        let _ = tray.set_menu(Some(menu));
    }
    Ok(())
}

/// Show, unminimize and focus the main window (tray click + single-instance
/// second-launch + window_show IPC all share this).
pub fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    } else {
        tracing::warn!("main window not available; cannot show");
    }
}
