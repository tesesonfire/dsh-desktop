//! Sidecar lifecycle integration test — gated behind `DSH_E2E=1` because it
//! spawns a real node process (`packages/testkit/bin/mock-dsh.mjs`).
//!
//! Unlike the app itself this test does NOT build a Tauri application: it
//! drives `DshSidecar` directly under plain tokio, asserting the full loop —
//! spawn → ready line parsed → running → stop → no orphan process left.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use dsh_desktop_tauri::proc_kill::is_pid_alive;
use dsh_desktop_tauri::sidecar::{AppState, HostState, SidecarEvent};

#[tokio::test(flavor = "multi_thread")]
async fn sidecar_spawns_ready_and_stops_without_orphans() {
    if std::env::var("DSH_E2E").ok().as_deref() != Some("1") {
        eprintln!("skipped: set DSH_E2E=1 to run the sidecar lifecycle test");
        return;
    }

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let mock = manifest_dir
        .join("../../../packages/testkit/bin/mock-dsh.mjs")
        .canonicalize()
        .expect("packages/testkit/bin/mock-dsh.mjs must exist");
    let patch = manifest_dir
        .join("../../../packages/desktop-shell/cordis.patch.yml")
        .canonicalize()
        .expect("packages/desktop-shell/cordis.patch.yml must exist");

    // Isolated DSH_HOME so the test never touches a real user directory.
    let home = std::env::temp_dir().join(format!("dsh-desktop-lifecycle-{}", std::process::id()));
    std::fs::create_dir_all(&home).expect("create temp DSH_HOME");

    // SAFETY: this test binary owns the process env; previous values are
    // restored at the end.
    let previous_home = std::env::var("DSH_HOME").ok();
    let previous_bin = std::env::var("DSH_BIN").ok();
    let previous_patch = std::env::var("DSH_PATCH").ok();
    std::env::set_var("DSH_HOME", &home);
    std::env::set_var("DSH_BIN", &mock);
    std::env::set_var("DSH_PATCH", &patch);
    std::env::remove_var("DSH_NODE");

    let state = AppState::new(Arc::new(|_: SidecarEvent| {}));

    // spawn → ready line (mock-dsh prints the official format on an
    // OS-assigned port; start() resolves only after parsing it).
    let endpoint = tokio::time::timeout(Duration::from_secs(60), state.sidecar.start())
        .await
        .expect("start resolves within 60s")
        .expect("mock-dsh ready line");
    assert!(endpoint.port > 0, "OS-assigned port must be resolved");
    assert!(endpoint.url.contains("/?token="), "ready url must keep the token");

    let status = state.sidecar.status();
    assert_eq!(status.state, HostState::Running);
    assert_eq!(status.port, Some(endpoint.port));
    let expected_origin = format!("http://127.0.0.1:{}", endpoint.port);
    assert_eq!(state.shared.expected_origin().as_deref(), Some(expected_origin.as_str()));

    // No control channel in this test → the plugin cannot announce. That is
    // the documented degradation path (loud-failure stub, no crash).
    assert!(!state.shared.hello_seen(), "hello must not be seen without a control channel");

    let pid = state.shared.pid();
    assert!(pid > 0 && is_pid_alive(pid), "sidecar pid must be alive while running");

    // stop → the process tree must be gone (poll: kill delivery is async).
    tokio::time::timeout(Duration::from_secs(30), state.sidecar.stop())
        .await
        .expect("stop resolves within 30s")
        .expect("stop succeeds");

    let mut gone = false;
    for _ in 0..50 {
        if !is_pid_alive(pid) {
            gone = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(gone, "sidecar process must not survive stop()");

    let status = state.sidecar.status();
    assert_eq!(status.state, HostState::Stopped);
    assert_eq!(state.shared.expected_origin(), None, "nav fence must be released on stop");

    // Restore env and clean the temp home (best effort).
    match previous_home {
        Some(value) => std::env::set_var("DSH_HOME", value),
        None => std::env::remove_var("DSH_HOME"),
    }
    match previous_bin {
        Some(value) => std::env::set_var("DSH_BIN", value),
        None => std::env::remove_var("DSH_BIN"),
    }
    match previous_patch {
        Some(value) => std::env::set_var("DSH_PATCH", value),
        None => std::env::remove_var("DSH_PATCH"),
    }
    let _ = std::fs::remove_dir_all(&home);
}
