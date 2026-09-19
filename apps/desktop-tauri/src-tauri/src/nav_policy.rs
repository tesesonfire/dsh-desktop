//! Navigation fence — a pure predicate deciding which URLs the main web view
//! may load. Two modes:
//!
//! - **pre-ready** (`expected_origin == None`): only shell-owned origins are
//!   allowed (the frontend bundle itself).
//! - **post-ready** (`expected_origin == Some(..)`): only the exact origin
//!   parsed from the sidecar's ready line. Origin EQUALITY, never prefix
//!   matching — `http://127.0.0.1:3080.evil.com` must not pass a fence for
//!   `http://127.0.0.1:3080`. This mirrors `isSameOrigin` in
//!   packages/protocol/src/readyline.ts.

use tauri::Url;

/// Origins the web view may sit on before the sidecar published its ready
/// origin. `tauri://localhost` is the production frontend on macOS/Linux,
/// `http://tauri.localhost` the production frontend on Windows (WebView2 has
/// no custom-scheme support — see .refs/dsh-tauri-desktop
/// src-tauri/src/lib.rs:112 for the `.localhost` URL form) and
/// `http://localhost:1420` is the vite dev server (tauri.conf.json devUrl).
pub const SHELL_ORIGINS: [&str; 3] = [
    "tauri://localhost",
    "http://tauri.localhost",
    "http://localhost:1420",
];

/// Compute the comparable origin string of a parsed URL.
///
/// `url::Url::origin` renders non-special schemes as opaque (`null`), which
/// would reject `tauri://localhost/index.html`; the shell scheme is therefore
/// reconstructed explicitly. Everything else (http/https/...) uses the
/// standard WHATWG origin serialization.
pub fn url_origin(url: &Url) -> String {
    let scheme = url.scheme();
    if scheme == "tauri" {
        return format!("{}://{}", scheme, url.host_str().unwrap_or("localhost"));
    }
    url.origin().ascii_serialization()
}

/// True when the web view is allowed to navigate to `url`.
pub fn navigation_allowed(url: &str, expected_origin: Option<&str>) -> bool {
    let parsed = match Url::parse(url) {
        Ok(parsed) => parsed,
        Err(_) => return false,
    };
    let origin = url_origin(&parsed);
    match expected_origin {
        Some(expected) => origin == expected,
        None => SHELL_ORIGINS.contains(&origin.as_str()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_exact_ready_origin_only() {
        let expected = "http://127.0.0.1:49152";
        assert!(navigation_allowed(
            "http://127.0.0.1:49152/?token=x_y-z9",
            Some(expected)
        ));
        // same origin, different path still allowed (origin equality)
        assert!(navigation_allowed("http://127.0.0.1:49152/api", Some(expected)));
    }

    #[test]
    fn rejects_lookalike_origins() {
        let expected = "http://127.0.0.1:3080";
        // adjacent port value — prefix matching must not let it through
        assert!(!navigation_allowed(
            "http://127.0.0.1:30801/?token=x",
            Some(expected)
        ));
        // host that merely starts with the trusted string
        assert!(!navigation_allowed(
            "http://127.0.0.1:3080.evil.com/",
            Some(expected)
        ));
        // a different loopback host
        assert!(!navigation_allowed("http://localhost:3080/", Some(expected)));
    }

    #[test]
    fn pre_ready_allows_only_shell_origins() {
        assert!(navigation_allowed("tauri://localhost/index.html", None));
        assert!(navigation_allowed("http://tauri.localhost/index.html", None));
        assert!(navigation_allowed("http://localhost:1420/", None));
        assert!(!navigation_allowed("http://evil.example.com/", None));
        // once ready, the dev server is no longer a valid destination
        assert!(!navigation_allowed(
            "http://localhost:1420/",
            Some("http://127.0.0.1:3080")
        ));
    }

    #[test]
    fn unparseable_urls_are_rejected() {
        assert!(!navigation_allowed("not a url", None));
        assert!(!navigation_allowed("", Some("http://127.0.0.1:3080")));
    }
}
