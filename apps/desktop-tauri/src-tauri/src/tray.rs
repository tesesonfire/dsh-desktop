//! System tray: show/hide the main window, open the data dir, restart the
//! host and quit (running the sidecar teardown first). Menu shape mirrors the
//! Electron shell's tray (apps/desktop-electron/src/main/tray.ts).

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

use crate::ipc;
use crate::sidecar::AppState;

/// Create the tray icon. Called once from setup; the icon falls back to the
/// system default when no window icon is bundled.
pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show Window", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "hide", "Hide Window", true, None::<&str>)?;
    let open_data_dir = MenuItem::with_id(app, "open-data-dir", "Open Data Dir", true, None::<&str>)?;
    let restart_host = MenuItem::with_id(app, "restart-host", "Restart Host", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &hide, &open_data_dir, &restart_host, &quit])?;

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
            _ => {}
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
