# DSH Desktop — Tauri 2 shell (Rust side)

Unofficial desktop shell for DeepSeek Harness (DSH). The Rust crate in
`src-tauri/` owns the three platform primitives (spawnHost / killHost /
attachWebView) and the loopback control channel; all business logic lives in
the DSH host as the `dsh-desktop-shell` Cordis plugin
(`packages/desktop-shell`). Contracts live in `packages/protocol`.

> **Verification status:** this crate was written on a machine **without a
> Rust toolchain** (no cargo/rustc/MSVC). It has never been compiled. Every
> external API usage was verified against the tauri 2.11.5 sources and the
> locally compiled reference project `.refs/dsh-tauri-desktop/src-tauri/`
> (tauri 2.11.5 locked) — see "API verification" below. Treat the first
> `cargo check` as the real gate.

## Build prerequisites

- Rust 1.77.2+ (rust-toolchain pinned by `rust-version`), MSVC toolchain on
  Windows (`link.exe`), WebView2 Runtime (preinstalled on Win 11).
- Node >= 20 and pnpm 10 (frontend build + tests).
- No `cargo` needed for the contract audit (`pnpm audit:contract` scans the
  Rust sources with plain node).

## Commands

```bash
# from apps/desktop-tauri
pnpm install            # workspace install (frontend + @tauri-apps/cli)
pnpm tauri dev          # dev: vite on :1420 + cargo run (needs toolchain)
pnpm tauri build        # bundle per tauri.conf.json targets

# Rust-side tests (need the toolchain)
cargo test                       # unit tests: ready line, nav fence, DSH_BIN, launcher
cargo test --test lifecycle      # sidecar integration; real node child
DSH_E2E=1 cargo test --test lifecycle   # enable the lifecycle test

# smoke run (real app + real sidecar + plugin handshake, exits 0/1)
DSH_SMOKE=1 DSH_BIN=node scripts DSH_SMOKE_OUT=report.json pnpm tauri dev
# regenerate the bundled icons (no dependencies):
node scripts/gen-icons.mjs
```

With the official CLI installed: `DSH_BIN=<path-to-dsh>` replaces mock-dsh;
the same code path runs (`--profile <p> --patch <yml> --port 0 --no-open`).

## Environment contract

| Variable | Meaning |
|---|---|
| `DSH_BIN` | sidecar command: `*.mjs/*.cjs/*.js` run via node (`DSH_NODE` or PATH), `*.cmd/*.bat` (Windows) via `cmd.exe /d /s /c`, anything else executed directly |
| `DSH_NODE` | explicit node binary for script `DSH_BIN` values |
| `DSH_PATCH` | override `--patch` yml (dev default: monorepo `packages/desktop-shell/cordis.patch.yml` found upward from the exe) |
| `DSH_HOME` | DSH home dir (default `~/.dsh`); profiles live under `profiles/` |
| `DSH_DESKTOP_CONTROL_URL` / `DSH_DESKTOP_CONTROL_TOKEN` | injected into the sidecar env by the shell |
| `DSH_SMOKE` / `DSH_SMOKE_OUT` | smoke mode + report path (default `<app data dir>/smoke-report.json`) |
| `DSH_E2E` | gates `src-tauri/tests/lifecycle.rs` |
| `RUST_LOG` | tracing filter (default `info,tauri=warn`) |

## Known issues / deviations

- **Never compiled.** API usage was verified by source inspection against
  tauri 2.11.5 (`crates/tauri`), tiny_http 0.12, windows-sys 0.59 and the
  reference crate's real usage. First build may still surface detail-level
  errors (unused imports, serde field naming).
- **Main window is built in Rust, not auto-created.** `tauri.conf.json`
  declares it with `"create": false` and `setup()` rebuilds it via
  `WebviewWindowBuilder::from_config(..).on_navigation(..)`: tauri 2.11.5 has
  **no** `Builder::on_navigation` (verified: `crates/tauri/src/app.rs`), and
  the origin-equality navigation fence is a hard requirement.
- **Windows production origin is `http://tauri.localhost`.** The pre-ready
  allowlist therefore contains `tauri://localhost` (macOS/Linux),
  `http://tauri.localhost` (Windows) and `http://localhost:1420` (dev).
- `tauri-plugin-updater` is wired but inert until `plugins.updater` gets a
  real feed (no release source exists yet).
- **Packaged `--patch` lookup is TODO:** in a bundled app there is no
  monorepo next to the exe; ship `cordis.patch.yml` as a Tauri resource and
  resolve via `AppHandle::path().resource_dir()` (see `sidecar.rs`).
- Tests that kill real processes (`proc_kill` unix/windows, lifecycle) need
  process-creation rights; they are skipped unless their cfg/`DSH_E2E` gate
  is satisfied.

## API verification (file:line into the reference / upstream)

- Builder/plugins/tray/emit patterns: `.refs/dsh-tauri-desktop/src-tauri/src/lib.rs:26-98,202-239`
- sidecar spawn (`kill_on_drop`, `creation_flags`, piped pumps, status
  machine): `.../src/services/workflow_service.rs:281-355`
- `on_navigation` is builder-only in tauri 2.11.5:
  `tauri-v2.11.5 crates/tauri/src/app.rs` (absent) vs
  `crates/tauri/src/webview/webview_window.rs:150,266,2384`
  (`from_config`, `on_navigation(Fn(&Url) -> bool)`, `WebviewWindow::navigate`)
- `WindowConfig.create` (`"create": false` official pattern):
  `tauri-v2.11.5 crates/tauri-utils/src/config.rs:1917-1945`
- `App::run(FnMut(&AppHandle, RunEvent))`, `RunEvent::ExitRequested/Exit`:
  `tauri-v2.11.5 crates/tauri/src/app.rs:1366`, `220-232`
- opener `open_url/open_path`, `OpenerExt`: plugins-workspace v2
  `plugins/opener/src/lib.rs:62-175`
- single-instance `init(FnMut(&AppHandle, Vec<String>, String))`:
  `plugins/single-instance/src/lib.rs:36`
- window-state `with_state_flags(StateFlags::SIZE|POSITION|MAXIMIZED)`:
  `plugins/window-state/src/lib.rs:52-65,340`
- tiny_http 0.12 `from_listener(TcpListener, None)`, `recv_timeout`
  (`IoResult<Option<Request>>`), `Request::{method,url,headers,body_length,
  as_reader}`, `Response::{from_string,with_status_code,add_header}`,
  `Header::from_bytes(..) -> Result<Header, ()>`: upstream
  `tiny-http/tiny-http src/{lib,connection,common,response}.rs`
- windows-sys 0.59 job objects (`CreateJobObjectW`, `SetInformationJobObject`,
  `JobObjectExtendedLimitInformation`, `AssignProcessToJobObject`,
  `TerminateJobObject`, `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`): docs.rs
  windows-sys 0.59.0 `Win32::System::JobObjects`
- tokio `Command::process_group(0)` (unix): docs.rs tokio
  `process::Command::process_group`
