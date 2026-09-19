//! Settings window: a second web view on the same frontend bundle. Existing
//! instance wins — re-opening focuses it instead of stacking duplicates.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::nav_policy;

/// Open (or focus) the `settings` window. The label is also listed in
/// capabilities/default.json so the bundled frontend can talk to the shell.
pub fn open_settings(app: &AppHandle) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window("settings") {
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }
    let window = WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("index.html".into()))
        .title("DSH Desktop — Settings")
        .inner_size(760.0, 560.0)
        .min_inner_size(480.0, 360.0)
        .center()
        .resizable(true)
        // The settings window only ever shows the shell's own frontend:
        // pre-ready allowlist, everything else (including the DSH origin) is
        // rejected.
        .on_navigation(|url| nav_policy::navigation_allowed(url.as_str(), None))
        .build()
        .map_err(|err| format!("settings window build failed: {err}"))?;
    let _ = window.set_focus();
    Ok(())
}
