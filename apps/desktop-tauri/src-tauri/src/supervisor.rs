//! Host supervisor (crash self-healing): restarts the sidecar after
//! UNEXPECTED exits with exponential backoff. Policy is a pure state machine
//! (unit-tested); the runtime wiring lives in `on_sidecar_state`.
//!
//! Mirrors apps/desktop-electron/src/main/supervisor.ts: MAX_RESTARTS = 5,
//! backoff = 2^n seconds capped at 32s, counter resets after 60s of stable
//! running. `DSH_SUPERVISOR=0` disables the whole mechanism.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const MAX_RESTARTS: u32 = 5;
pub const BASE_BACKOFF_MS: u64 = 2_000;
pub const STABLE_RESET_MS: u64 = 60_000;

#[derive(Debug)]
pub struct BackoffPolicy {
    consecutive: u32,
    max_restarts: u32,
    base_ms: u64,
}

impl BackoffPolicy {
    pub const fn new() -> Self {
        Self { consecutive: 0, max_restarts: MAX_RESTARTS, base_ms: BASE_BACKOFF_MS }
    }

    /// Record an unexpected failure. `Some(delay)` = restart after this long;
    /// `None` = give up (limit reached).
    pub fn on_failure(&mut self) -> Option<Duration> {
        if self.consecutive >= self.max_restarts {
            return None;
        }
        let delay = Duration::from_millis(self.base_ms.saturating_mul(1u64 << self.consecutive.min(31)));
        self.consecutive += 1;
        Some(delay)
    }

    pub fn on_stable(&mut self) {
        self.consecutive = 0;
    }

    pub fn exhausted(&self) -> bool {
        self.consecutive >= self.max_restarts
    }

    pub fn failures(&self) -> u32 {
        self.consecutive
    }
}

impl Default for BackoffPolicy {
    fn default() -> Self {
        Self::new()
    }
}static SUPERVISOR_DISABLED: AtomicBool = AtomicBool::new(false);
static STABLE_SINCE: Mutex<Option<Instant>> = Mutex::new(None);

pub fn supervisor_disabled() -> bool {
    std::env::var("DSH_SUPERVISOR").ok().as_deref() == Some("0")
}

/// Feed a state transition from the sidecar event sink. Must run on the async
/// runtime (schedules the restart via tauri::async_runtime). `restart` is the
/// sidecar's restart future factory, injected for testability.
pub fn handle_state<F>(running: bool, error: Option<&str>, restart: F)
where
    F: FnOnce() + Send + 'static,
{
    if supervisor_disabled() {
        return;
    }
    if running {
        *STABLE_SINCE.lock().expect("stable lock") = Some(Instant::now());
        return;
    }
    let Some(error) = error else { return };

    // Stable-run counter reset: a host that ran long enough before dying
    // starts the backoff ladder over.
    {
        let mut stable = STABLE_SINCE.lock().expect("stable lock");
        if stable.is_some_and(|since| since.elapsed() >= Duration::from_millis(STABLE_RESET_MS)) {
            *stable = None;
            POLICY.lock().expect("policy lock").on_stable();
        }
        *stable = None;
    }

    let Some(delay) = POLICY.lock().expect("policy lock").on_failure() else {
        tracing::error!("supervisor gave up after {MAX_RESTARTS} restarts; last error: {error}");
        return;
    };
    let attempt = POLICY.lock().expect("policy lock").failures();
    tracing::warn!("host exited unexpectedly; restart #{attempt} in {}ms", delay.as_millis());
    std::thread::spawn(move || {
        std::thread::sleep(delay);
        restart();
    });
}

static POLICY: Mutex<BackoffPolicy> = Mutex::new(BackoffPolicy::new());

/// Test-only knob: read the current failure count.
#[cfg(test)]
pub fn failures_for_test() -> u32 {
    POLICY.lock().expect("policy lock").failures()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn doubles_delay_then_gives_up() {
        let mut policy = BackoffPolicy::new();
        let mut delays = Vec::new();
        for _ in 0..MAX_RESTARTS + 1 {
            delays.push(policy.on_failure().map(|d| d.as_millis()));
        }
        assert_eq!(delays, vec![Some(2000), Some(4000), Some(8000), Some(16000), Some(32000), None]);
        assert!(policy.exhausted());
    }

    #[test]
    fn resets_after_stable() {
        let mut policy = BackoffPolicy::new();
        let _ = policy.on_failure();
        let _ = policy.on_failure();
        policy.on_stable();
        assert_eq!(policy.failures(), 0);
        assert_eq!(policy.on_failure().map(|d| d.as_millis()), Some(2000));
    }

    #[test]
    fn handle_state_is_disabled_by_env() {
        // SAFETY: single-threaded test process touching this env var.
        std::env::set_var("DSH_SUPERVISOR", "0");
        assert!(supervisor_disabled());
        std::env::remove_var("DSH_SUPERVISOR");
        assert!(!supervisor_disabled());
    }
}
