//! Desktop control channel — the ONLY crossing between the platform shell and
//! the `dsh-desktop-shell` Cordis plugin running inside the DSH host.
//!
//! Loopback-only HTTP server (random port, random per-launch token) started
//! before the sidecar is spawned; the child receives the coordinates via
//! `DSH_DESKTOP_CONTROL_URL` / `DSH_DESKTOP_CONTROL_TOKEN` and the plugin
//! calls the endpoints below. Contract: packages/protocol/src/control.ts.
//!
//! Threading: four worker threads share one `Arc<tiny_http::Server>`; a
//! worker may block up to 25s on the `/v0/events` long-poll while the others
//! keep serving the remaining routes.

use std::io::Read;
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::{AppHandle, Manager};
use tiny_http::{Header, Method, Request, Response};

use crate::launcher;
use crate::nav_policy;
use crate::sidecar::{AppState, ControlChannel, HelloInfo};

/// Env coordinates forwarded to the sidecar child. Names must stay identical
/// with CONTROL_URL_ENV / CONTROL_TOKEN_ENV in
/// packages/protocol/src/control.ts.
pub const CONTROL_URL_ENV: &str = "DSH_DESKTOP_CONTROL_URL";
pub const CONTROL_TOKEN_ENV: &str = "DSH_DESKTOP_CONTROL_TOKEN";

/// Token header — CONTROL_TOKEN_HEADER in packages/protocol/src/control.ts.
const CONTROL_TOKEN_HEADER: &str = "x-dsh-desktop-control";

/// CONTROL_EVENTS_LONGPOLL_MS in packages/protocol/src/control.ts.
const EVENTS_LONGPOLL: Duration = Duration::from_millis(25_000);

/// Route strings — CONTROL_ENDPOINTS in packages/protocol/src/control.ts.
const ROUTE_HELLO: &str = "/v0/hello";
const ROUTE_WEBVIEW_ATTACH: &str = "/v0/webview/attach";
const ROUTE_HOST_STOP: &str = "/v0/host/stop";
const ROUTE_HOST_RESTART: &str = "/v0/host/restart";
const ROUTE_EVENTS: &str = "/v0/events";

const MAX_BODY_BYTES: usize = 64 * 1024;
/// Worker count: one in-flight long-poll must not starve the other routes.
const WORKER_THREADS: usize = 4;

/// Handle for the running control channel. Keep it alive for the app
/// lifetime; `release` stops the workers and frees the socket.
pub struct ControlHandle {
    pub port: u16,
    pub channel: ControlChannel,
    server: Arc<tiny_http::Server>,
    shutdown: Arc<AtomicBool>,
}

impl ControlHandle {
    /// Stop accepting new requests and wake workers blocked in recv.
    /// Long-poll handlers finish their current iteration on their own; the
    /// process is exiting at this point, so no join is attempted.
    pub fn release(&self) {
        self.shutdown.store(true, Ordering::SeqCst);
        self.server.unblock();
    }
}

/// 32 random bytes, base64url-encoded without padding (43 chars).
fn generate_token() -> String {
    use rand::RngCore;
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    let mut out = String::with_capacity(43);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[(triple >> 18) as usize & 63] as char);
        out.push(TABLE[(triple >> 12) as usize & 63] as char);
        if chunk.len() > 1 {
            out.push(TABLE[(triple >> 6) as usize & 63] as char);
        }
        if chunk.len() > 2 {
            out.push(TABLE[triple as usize & 63] as char);
        }
    }
    out
}

/// Bind a loopback listener on an OS-assigned port and spawn the workers.
pub fn start(app: AppHandle, state: AppState) -> Result<ControlHandle, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|err| format!("control channel bind failed: {err}"))?;
    let port = listener
        .local_addr()
        .map_err(|err| format!("control channel local_addr failed: {err}"))?
        .port();
    // Hand the pre-bound listener to tiny_http so the port we report is the
    // port that is actually served (no bind race).
    let server = tiny_http::Server::from_listener(listener, None)
        .map_err(|err| format!("control channel server init failed: {err}"))?;
    let server = Arc::new(server);
    let shutdown = Arc::new(AtomicBool::new(false));

    for _ in 0..WORKER_THREADS {
        let server = server.clone();
        let shutdown = shutdown.clone();
        let app = app.clone();
        let state = state.clone();
        std::thread::Builder::new()
            .name("dsh-control".to_string())
            .spawn(move || worker_loop(server, shutdown, app, state))
            .map_err(|err| format!("control channel worker spawn failed: {err}"))?;
    }

    let channel = ControlChannel {
        base_url: format!("http://127.0.0.1:{port}"),
        token: generate_token(),
    };
    tracing::info!("control channel listening on {} (token gated)", channel.base_url);
    Ok(ControlHandle {
        port,
        channel,
        server,
        shutdown,
    })
}

fn worker_loop(
    server: Arc<tiny_http::Server>,
    shutdown: Arc<AtomicBool>,
    app: AppHandle,
    state: AppState,
) {
    loop {
        if shutdown.load(Ordering::SeqCst) {
            return;
        }
        match server.recv_timeout(Duration::from_millis(250)) {
            Ok(Some(request)) => handle_request(request, &app, &state),
            Ok(None) => {} // poll tick; re-check the shutdown flag
            Err(err) => {
                if shutdown.load(Ordering::SeqCst) {
                    return;
                }
                tracing::debug!("control channel recv error: {err}");
                std::thread::sleep(Duration::from_millis(10));
            }
        }
    }
}

fn handle_request(mut request: Request, app: &AppHandle, state: &AppState) {
    // Route (path without query) and method, copied out before the body is
    // consumed by the handlers.
    let path = request.url().split('?').next().unwrap_or("").to_string();
    let is_get = matches!(request.method(), Method::Get);
    let is_post = matches!(request.method(), Method::Post);

    if !request_is_authorized(&request, state) {
        respond_json(
            request,
            403,
            serde_json::json!({ "error": "invalid or missing control token" }),
        );
        return;
    }

    if is_post {
        match path.as_str() {
            ROUTE_HELLO => handle_hello(request, state),
            ROUTE_WEBVIEW_ATTACH => handle_webview_attach(request, app, state),
            ROUTE_HOST_STOP => handle_host_stop(request, state),
            ROUTE_HOST_RESTART => handle_host_restart(request, state),
            _ => respond_json(request, 404, serde_json::json!({ "error": "unknown route" })),
        }
    } else if is_get {
        match path.as_str() {
            ROUTE_HELLO => respond_json(request, 200, current_profile_json(state)),
            ROUTE_EVENTS => handle_events(request, state),
            _ => respond_json(request, 404, serde_json::json!({ "error": "unknown route" })),
        }
    } else {
        respond_json(request, 405, serde_json::json!({ "error": "method not allowed" }));
    }
}

/// Every route (GET and POST) is gated on the per-launch token header.
fn request_is_authorized(request: &Request, state: &AppState) -> bool {
    let Some(channel) = state.shared.control_channel() else {
        return false;
    };
    request.headers().iter().any(|header| {
        header.field.equiv(CONTROL_TOKEN_HEADER) && header.value.as_str() == channel.token
    })
}

fn handle_hello(mut request: Request, state: &AppState) {
    let body = match read_body(&mut request) {
        Ok(body) => body,
        Err(status) => {
            respond_json(request, status, serde_json::json!({ "error": "unreadable body" }));
            return;
        }
    };
    match serde_json::from_str::<HelloBody>(&body) {
        Ok(hello) if hello.protocol_version == 1 => {
            tracing::info!(
                "control: hello from pid {} (web port {}, profile {})",
                hello.pid,
                hello.web_port,
                hello.profile
            );
            state.shared.record_hello(HelloInfo {
                pid: hello.pid,
                web_port: hello.web_port,
                profile: hello.profile,
            });
            respond_json(request, 200, serde_json::json!({ "ok": true }));
        }
        Ok(_) => respond_json(
            request,
            400,
            serde_json::json!({ "error": "unsupported protocol version" }),
        ),
        Err(err) => respond_json(
            request,
            400,
            serde_json::json!({ "error": format!("malformed hello body: {err}") }),
        ),
    }
}

fn handle_webview_attach(mut request: Request, app: &AppHandle, state: &AppState) {
    let body = match read_body(&mut request) {
        Ok(body) => body,
        Err(status) => {
            respond_json(request, status, serde_json::json!({ "error": "unreadable body" }));
            return;
        }
    };
    let attach = match serde_json::from_str::<AttachBody>(&body) {
        Ok(attach) => attach,
        Err(err) => {
            respond_json(
                request,
                400,
                serde_json::json!({ "error": format!("malformed attach body: {err}") }),
            );
            return;
        }
    };
    // Origin EQUALITY against the ready-line origin — the same rule the
    // navigation fence applies (never prefix matching).
    let expected = state.shared.expected_origin();
    let same_origin = tauri::Url::parse(&attach.url)
        .map(|parsed| Some(nav_policy::url_origin(&parsed)) == expected)
        .unwrap_or(false);
    if !same_origin {
        tracing::warn!(
            "control: rejected webview attach for non-ready origin {}",
            attach.url
        );
        respond_json(request, 403, serde_json::json!({ "error": "url is not same-origin with the ready line" }));
        return;
    }

    let app = app.clone();
    let url = attach.url;
    // Navigation must happen on the main thread; run_on_main_thread queues it.
    let _ = app.run_on_main_thread(move || {
        let Some(window) = app.get_webview_window("main") else {
            return;
        };
        let state = app.state::<AppState>();
        // Skip a redundant reload when the shell already navigated to the
        // exact same URL on the ready line.
        if state.shared.ready_url().as_deref() != Some(url.as_str()) {
            if let Ok(parsed) = tauri::Url::parse(&url) {
                let _ = window.navigate(parsed);
            }
        }
        state.shared.set_webview_attached();
    });
    respond_json(request, 200, serde_json::json!({ "ok": true }));
}

fn handle_host_stop(request: Request, state: &AppState) {
    let result = tauri::async_runtime::block_on(state.sidecar.stop());
    match result {
        Ok(()) => respond_json(request, 200, serde_json::json!({ "ok": true })),
        Err(err) => respond_json(request, 500, serde_json::json!({ "error": err })),
    }
}

fn handle_host_restart(request: Request, state: &AppState) {
    let result = tauri::async_runtime::block_on(state.sidecar.restart());
    match result {
        Ok(endpoint) => respond_json(
            request,
            200,
            serde_json::json!({ "port": endpoint.port, "url": endpoint.url }),
        ),
        Err(err) => respond_json(request, 500, serde_json::json!({ "error": err })),
    }
}

/// Long-poll: return as soon as an event is queued, or an empty batch after
/// ≤25s. One worker is occupied per in-flight poll (see WORKER_THREADS).
fn handle_events(request: Request, state: &AppState) {
    let deadline = Instant::now() + EVENTS_LONGPOLL;
    loop {
        let batch = state.shared.drain_events();
        if !batch.is_empty() {
            respond_json(request, 200, serde_json::json!({ "events": batch }));
            return;
        }
        if Instant::now() >= deadline {
            respond_json(request, 200, serde_json::json!({ "events": [] }));
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn current_profile_json(state: &AppState) -> serde_json::Value {
    let profile = launcher::profile_detail(&state.shared.current_profile());
    serde_json::json!({ "name": profile.name, "path": profile.path, "bundles": profile.bundles })
}

// ---------------------------------------------------------------------------
// tiny_http plumbing
// ---------------------------------------------------------------------------

/// Read the request body with a hard size cap. Borrows the request mutably so
/// the caller can still respond on failure.
fn read_body(request: &mut Request) -> Result<String, u16> {
    let len = request.body_length().unwrap_or(0);
    if len > MAX_BODY_BYTES {
        return Err(413);
    }
    let mut body = String::new();
    request
        .as_reader()
        .take(len)
        .read_to_string(&mut body)
        .map_err(|_| 400u16)?;
    Ok(body)
}

fn respond_json(request: Request, status: u16, body: serde_json::Value) {
    let content_type = Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
        .expect("static header is always valid");
    let mut response = Response::from_string(body.to_string()).with_status_code(status);
    response.add_header(content_type);
    let _ = request.respond(response);
}

// ---------------------------------------------------------------------------
// Wire types (shapes from packages/protocol/src/control.ts)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct HelloBody {
    pid: u32,
    #[serde(rename = "webPort")]
    web_port: u16,
    profile: String,
    #[serde(rename = "protocolVersion")]
    protocol_version: i64,
}

#[derive(Debug, Deserialize)]
struct AttachBody {
    url: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_is_43_chars_of_base64url() {
        for _ in 0..8 {
            let token = generate_token();
            assert_eq!(token.len(), 43, "32 bytes => 43 base64url chars");
            assert!(token.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'));
            // Extremely unlikely to repeat, but the loop makes regressions loud.
            assert_ne!(token, generate_token());
        }
    }
}
