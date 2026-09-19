//! dsh-desktop-tauri — the Tauri 2 platform shell for DSH Desktop.
//!
//! Architecture (PLAN.md §3): this crate owns the three platform primitives —
//! spawnHost / killHost (sidecar.rs + proc_kill.rs) and attachWebView
//! (lib.rs navigation + control_server.rs) — while all business logic lives
//! in the DSH host as the `dsh-desktop-shell` Cordis plugin, reached over the
//! loopback control channel. The renderer talks to this shell through the 14
//! `#[tauri::command]`s in ipc.rs, which mirror packages/protocol/src/bridge.ts.

pub mod control_server;
pub mod diagnostics;
pub mod ipc;
pub mod launcher;
pub mod nav_policy;
pub mod plugin_inventory;
pub mod proc_kill;
pub mod settings;
pub mod settings_window;
pub mod sidecar;
pub mod smoke;
pub mod supervisor;
pub mod terminal;
pub mod tray;

use std::sync::{Arc, OnceLock};

use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent};

use sidecar::{AppState, EventSink, HostState, SidecarEvent, EVENT_LOG, EVENT_STATE};

/// AppHandle once setup ran; the event sink needs it before any struct can
/// hold both.
static APP: OnceLock<AppHandle> = OnceLock::new();
/// Control channel handle; released on exit so the loopback socket frees.
static CONTROL: OnceLock<control_server::ControlHandle> = OnceLock::new();
/// Keeps the tracing non-blocking writer's worker alive for process lifetime.
static LOG_GUARD: OnceLock<tracing_appender::non_blocking::WorkerGuard> = OnceLock::new();
/// Settings snapshot loaded once at setup (close-to-tray, start-minimized, zoom).
static SETTINGS: OnceLock<settings::DesktopSettings> = OnceLock::new();

pub fn run() {
    init_tracing();

    let state = AppState::new(build_event_sink());

    let builder = tauri::Builder::default()
        // single-instance MUST be the first plugin (per its docs): a second
        // launch forwards argv here and dies immediately.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            tray::show_main_window(app);
        }))
        // Restore size/position only: restoring VISIBLE would pop the window
        // before the sidecar is ready (we show it on the ready line instead).
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        // TODO(updater): wire a real feed (GitHub Releases) once this project
        // has one; the plugin is inert without plugins.updater config, and
        // update delivery cannot be verified on this machine.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(state.clone())
        .on_window_event(|window, event| {
            // Main-window close behavior follows the closeToTray setting:
            // true (default) hides to tray and queues a window-close control
            // event; false lets the window close, which exits the app and
            // runs the full teardown.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    let close_to_tray = SETTINGS.get().map(|s| s.close_to_tray).unwrap_or(true);
                    if !close_to_tray {
                        return;
                    }
                    api.prevent_close();
                    let _ = window.hide();
                    if let Some(state) = window.try_state::<AppState>() {
                        state
                            .shared
                            .enqueue_event(sidecar::ShellControlEvent::WindowClose);
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            ipc::host_start,
            ipc::host_stop,
            ipc::host_restart,
            ipc::host_status,
            ipc::window_show,
            ipc::window_hide,
            ipc::window_focus,
            ipc::window_open_settings,
            ipc::profile_list,
            ipc::profile_current,
            ipc::profile_switch,
            ipc::open_data_dir,
            ipc::open_external,
            ipc::get_app_version,
            ipc::settings_get,
            ipc::settings_set,
            ipc::plugin_list,
            ipc::diagnostics_export
        ]);

    let app = match builder
        .setup(move |app| {
            let _ = APP.set(app.handle().clone());

            // Settings first: close/start/zoom behavior reads the snapshot.
            let loaded_settings = settings::load_from(&settings::settings_path());
            let _ = SETTINGS.set(loaded_settings);

            tray::setup(app.handle())?;

            // Control channel BEFORE the sidecar spawn: its coordinates go
            // into the child env.
            let control = control_server::start(app.handle().clone(), state.clone())?;
            state.shared.set_control_channel(control.channel.clone());
            let _ = CONTROL.set(control);

            // Main window: declared in tauri.conf.json with "create": false so
            // it is NOT auto-created — only the builder path lets us attach
            // the navigation fence (Builder::on_navigation does not exist in
            // tauri 2; WebviewWindowBuilder::on_navigation does).
            let main_config = app
                .config()
                .app
                .windows
                .iter()
                .find(|window| window.label == "main")
                .cloned()
                .ok_or("tauri.conf.json is missing the main window definition")?;
            let shared_for_nav = state.shared.clone();
            tauri::WebviewWindowBuilder::from_config(app.handle(), &main_config)?
                .on_navigation(move |url| {
                    nav_policy::navigation_allowed(url.as_str(), shared_for_nav.expected_origin().as_deref())
                })
                .build()?;
            // Start hidden (visible:false in the config); the ready-line
            // handler shows it.

            // Spawn the sidecar on the async runtime; smoke mode rides on the
            // same real code path.
            let state_for_start = state.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(err) = state_for_start.sidecar.start().await {
                    tracing::error!("dsh sidecar auto start failed: {err}");
                }
            });
            smoke::run_if_requested(app.handle().clone(), state);

            tracing::info!("DSH Desktop (Tauri) v{} started", env!("CARGO_PKG_VERSION"));
            Ok(())
        })
        .build(tauri::generate_context!())
    {
        Ok(app) => app,
        Err(err) => {
            tracing::error!("Tauri application failed to build: {err}");
            eprintln!("fatal: {err}");
            std::process::exit(1);
        }
    };

    app.run(|app, event| match event {
        // Both exit phases funnel into the same idempotent teardown:
        // kill the sidecar tree first, then release the control channel.
        RunEvent::ExitRequested { .. } => shutdown_all(app),
        RunEvent::Exit => shutdown_all(app),
        _ => {}
    });
}

/// Bridge sidecar events into the Tauri world: every state change is emitted
/// to the renderer (`dsh:state` / `dsh:log` — channel names from
/// packages/protocol/src/events.ts), and the first Running transition navigates
/// the main window to the ready URL and shows it.
fn build_event_sink() -> EventSink {
    Arc::new(move |event| match event {
        SidecarEvent::State(status) => {
            let Some(app) = APP.get() else { return };
            let _ = app.emit(EVENT_STATE, status.clone());
            // Crash self-healing: unexpected exits restart with backoff.
            if status.state == HostState::Error {
                let app = app.clone();
                let error = status.error.clone();
                supervisor::handle_state(false, error.as_deref(), move || {
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let state = app.state::<AppState>();
                        if let Err(err) = state.sidecar.restart().await {
                            tracing::error!("supervisor restart failed: {err}");
                        }
                    });
                });
            }
            if status.state == HostState::Running {
                supervisor::handle_state(true, None, || {});
                if let Some(url) = status.url.clone() {
                    let runner = app.clone();
                    let target = app.clone();
                    // Window operations must run on the main thread; the
                    // receiver borrows one clone, the closure owns another
                    // (moving the borrowed binding is E0505).
                    let _ = runner.run_on_main_thread(move || {
                        attach_main_window(&target, &url);
                    });
                }
            }
        }
        SidecarEvent::Log { level, line } => {
            let Some(app) = APP.get() else { return };
            let _ = app.emit(
                EVENT_LOG,
                serde_json::json!({ "level": level, "line": line }),
            );
        }
    })
}

/// Navigate the main window to the ready URL (token included) and reveal it.
/// Also marks webview_attached — the smoke report's third signal — because
/// from the shell's point of view the web view is now attached to the ready
/// origin. A later plugin-driven attach for the same URL is a no-op.
fn attach_main_window(app: &AppHandle, url: &str) {
    let Some(window) = app.get_webview_window("main") else {
        tracing::warn!("main window not available; cannot attach ready url");
        return;
    };
    match tauri::Url::parse(url) {
        Ok(parsed) => {
            let _ = window.navigate(parsed);
        }
        Err(err) => {
            tracing::error!("ready url {url} failed to parse: {err}");
            return;
        }
    }
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
    // startMinimized setting keeps the window in the tray on the ready line.
    if SETTINGS.get().is_some_and(|s| s.start_minimized) {
        let _ = window.hide();
    }
    // Zoom from settings applies to the host page for this webview.
    if let Some(s) = SETTINGS.get() {
        // TODO(verify-with-cargo): same set_zoom note as ipc::settings_set.
        let _ = window.set_zoom(s.zoom_factor);
    }
    if let Some(state) = app.try_state::<AppState>() {
        state.shared.set_webview_attached();
    }
}

/// Idempotent teardown (the reference's `shutdown_all`): best-effort sidecar
/// tree kill, then release the control channel socket. Called on both
/// RunEvent::ExitRequested and RunEvent::Exit (and by the tray Quit).
pub fn shutdown_all(app: &AppHandle) {
    tracing::info!("dsh desktop shutting down");
    if let Some(state) = app.try_state::<AppState>() {
        // Last chance for the in-host plugin to observe the shutdown event.
        state.shared.enqueue_event(sidecar::ShellControlEvent::Shutdown);
        state.sidecar.shutdown_now();
    }
    if let Some(control) = CONTROL.get() {
        control.release();
    }
}

/// tracing → `<app data dir>/logs/dsh-desktop.log.<date>` (daily rolling,
/// non-blocking writer). Falls back to stdout when the data dir is
/// unavailable (e.g. tests). `RUST_LOG` overrides the filter.
fn init_tracing() {
    static INIT: OnceLock<()> = OnceLock::new();
    if INIT.set(()).is_err() {
        return;
    }
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info,tauri=warn"));

    let logs_dir = dirs::data_dir().map(|dir| dir.join("org.dsh-desktop.tauri").join("logs"));
    let (writer, guard) = match logs_dir.filter(|dir| std::fs::create_dir_all(dir).is_ok()) {
        Some(dir) => {
            let appender = tracing_appender::rolling::daily(&dir, "dsh-desktop.log");
            tracing_appender::non_blocking(appender)
        }
        None => tracing_appender::non_blocking(std::io::stdout()),
    };
    let _ = LOG_GUARD.set(guard);

    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_ansi(false)
        .with_writer(writer)
        .try_init();
}
