//! Smoke mode (`DSH_SMOKE=1`): run the REAL app code path (window, tray,
//! control channel, sidecar spawn), wait for the full plugin handshake —
//! running + helloSeen + webviewAttached — then write a JSON report and exit.
//!
//! Report contract (consumed by scripts/smoke-clean-boot.mjs):
//! `{"framework":"tauri","profile":string,"pid":number,
//!   "readyLine":{"port":number,"url":string}|null,
//!   "helloReceived":bool,"webviewAttached":bool,"errors":[...]}`

use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::sidecar::{AppState, HostState};

/// 90s budget, same as the reference health-check deadline.
const SMOKE_DEADLINE: Duration = Duration::from_secs(90);
const POLL_INTERVAL: Duration = Duration::from_millis(250);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReadyLineReport {
    port: u16,
    url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SmokeReport {
    framework: &'static str,
    profile: String,
    pid: u32,
    ready_line: Option<ReadyLineReport>,
    hello_received: bool,
    webview_attached: bool,
    settings: crate::settings::DesktopSettings,
    errors: Vec<String>,
}

/// Spawn the smoke observer when DSH_SMOKE=1. Returns true when smoke mode is
/// active. The main window/tray/control-channel code path runs regardless —
/// that is the point of the smoke run.
pub fn run_if_requested(app: AppHandle, state: AppState) -> bool {
    if std::env::var("DSH_SMOKE").ok().as_deref() != Some("1") {
        return false;
    }
    tauri::async_runtime::spawn(async move {
        run(app, state).await;
    });
    true
}

async fn run(app: AppHandle, state: AppState) {
    let deadline = Instant::now() + SMOKE_DEADLINE;
    let mut errors: Vec<String> = Vec::new();

    loop {
        let status = state.sidecar.status();
        if status.state == HostState::Error {
            errors.push(format!(
                "host entered error state: {}",
                status.error.unwrap_or_else(|| "unknown".to_string())
            ));
            break;
        }
        if status.state == HostState::Running
            && state.shared.hello_seen()
            && state.shared.webview_attached()
        {
            break;
        }
        if Instant::now() >= deadline {
            errors.push(
                "timed out after 90s waiting for running+helloSeen+webviewAttached".to_string(),
            );
            break;
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }

    let status = state.sidecar.status();
    let report = SmokeReport {
        framework: "tauri",
        profile: state.shared.current_profile(),
        pid: state.shared.pid(),
        ready_line: match (&status.port, &status.url) {
            (Some(port), Some(url)) => Some(ReadyLineReport {
                port: *port,
                url: url.clone(),
            }),
            _ => None,
        },
        hello_received: state.shared.hello_seen(),
        webview_attached: state.shared.webview_attached(),
        settings: crate::settings::load_from(&crate::settings::settings_path()),
        errors,
    };

    match write_report(&app, &report) {
        Ok(path) => eprintln!("dsh-smoke: report written to {}", path.display()),
        Err(err) => eprintln!("dsh-smoke: FAILED to write report: {err}"),
    }

    if report.errors.is_empty() {
        tracing::info!("dsh smoke ok");
        app.exit(0);
    } else {
        tracing::error!("dsh smoke failed: {:?}", report.errors);
        app.exit(1);
    }
}

/// Write the report to DSH_SMOKE_OUT, defaulting to
/// `<app data dir>/smoke-report.json` (temp dir as last resort).
fn write_report(app: &AppHandle, report: &SmokeReport) -> Result<PathBuf, String> {
    let path = report_path(app);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("cannot create {}: {err}", parent.display()))?;
    }
    let body = serde_json::to_string_pretty(report).map_err(|err| err.to_string())?;
    std::fs::write(&path, body).map_err(|err| format!("cannot write {}: {err}", path.display()))?;
    Ok(path)
}

fn report_path(app: &AppHandle) -> PathBuf {
    if let Some(out) = std::env::var("DSH_SMOKE_OUT").ok().map(PathBuf::from).filter(|p| !p.as_os_str().is_empty()) {
        return out;
    }
    let fallback = || std::env::temp_dir().join("dsh-desktop-smoke-report.json");
    match app.path().app_data_dir() {
        Ok(dir) => dir.join("smoke-report.json"),
        Err(_) => fallback(),
    }
}
