# desktop-electron — DSH Desktop (Electron thin-host shell)

Electron implementation of the DSH Desktop platform layer. The main process
owns the sidecar (`dsh` host process), the loopback control server and the
native shell generation (main window + tray); the renderer is a thin React
surface that is swapped onto the host URL once the ready line arrives.

The Tauri implementation in `apps/desktop-tauri` implements the **same
contracts** (see "Shared contracts" below) — behavioral differences between the
two are platform facts only, never protocol drift.

## Layout

```
build.mjs            esbuild (main ESM + preload CJS) then vite (renderer)
vite.config.ts       renderer-only build (dist/renderer, base './')
index.html           CSP: no unsafe-eval; connect-src loopback
electron-builder.yml nsis / dmg / AppImage, asar, output release/
src/main/
  config.ts          $DSH_HOME / userData / state file paths
  log.ts             file sink: logs/main-YYYYMMDD.log, 10MB rotation x5, 7-day cleanup,
                     maskTokens() applied before every subscriber sees a line
  proc-kill.ts       killProcessTree: taskkill /T /F (win32), process-group
                     SIGTERM -> SIGKILL with non-group fallback (posix)
  sidecar.ts         DshSidecar state machine + DSH_BIN resolution contract +
                     resolvePatchYmlPath (DSH_PATCH > monorepo cordis.patch.yml)
  control-server.ts  loopback HTTP control channel (see endpoints below)
  shell.ts           ShellGeneration: main window, navigation fence, window
                     state persistence, idempotent release()
  tray.ts            tray menu (show/hide/data dir/restart host/quit)
  launcher.ts        profile discovery ($DSH_HOME/profiles), desktop-state.json
                     (atomic writes), last-known-good checkpoint
  ipc.ts             the 14 DesktopBridge handlers on literal `bridge:*` channels
  settings.ts        secondary window loading dist/renderer/index.html#settings
  smoke.ts           DSH_SMOKE contract
  index.ts           entry: single instance, lifecycle phases, wiring
src/preload/index.ts contextBridge: dshDesktop.invoke/onState/onLog
test/                vitest (node env): proc-kill, sidecar, control-server, launcher
scripts/make-tray-icon.mjs  regenerates assets/tray.png + assets/tray@2x.png
```

## Build / run

```bash
pnpm --filter @dsh-desktop/protocol build   # contract package must have dist/
pnpm --filter desktop-electron typecheck    # tsc --noEmit (strict, noUncheckedIndexedAccess)
pnpm --filter desktop-electron test         # vitest run
pnpm --filter desktop-electron build        # dist/main/index.js + dist/preload/index.cjs + dist/renderer/*
pnpm --filter desktop-electron dev          # build then electron .
pnpm --filter desktop-electron dist --win   # electron-builder package (also --mac / --linux)
```

The renderer sources live in `src/renderer` (owned by the renderer workstream);
`index.html` loads `/src/renderer/main.tsx` and the settings window uses the
`#settings` hash route of the same bundle.

## Shared contracts (identical to the Tauri implementation)

Everything below is defined once in `packages/protocol` and consumed verbatim:

- **Ready line** — parsed only via `parseReadyLine`:
  `dsh web: http://127.0.0.1:<port>/?token=<base64url>` (optional ` (LAN: ...)`
  suffix). The `?token=` credential is preserved into the web view URL.
- **DSH_BIN resolution** (`resolveDshCommand`): `.mjs/.cjs/.js` ->
  `process.execPath` + `ELECTRON_RUN_AS_NODE=1`; `.cmd/.bat` (win32) ->
  `cmd.exe /d /s /c`; otherwise the path as-is; unset -> search PATH for
  `dsh.cmd` (win) / `dsh` (unix); missing ->
  `dsh binary not found: install @deepseek-ai/dsh or set DSH_BIN`.
  Appended args, in order: `--profile <p> --patch <yml> --port 0 --no-open`.
- **Control channel** — loopback HTTP server (random port, per-launch
  `crypto.randomBytes(32).base64url` token in the `x-dsh-desktop-control`
  header), passed to the host via `DSH_DESKTOP_CONTROL_URL` /
  `DSH_DESKTOP_CONTROL_TOKEN`:
  | Endpoint | Behavior |
  |---|---|
  | `POST /v0/hello` | record `{pid, webPort, profile}`, set helloSeen (204) |
  | `GET /v0/hello` | current `Profile` JSON |
  | `POST /v0/webview/attach` | same-origin check against ready-line origin, then navigate the main window; non-same-origin -> 403 |
  | `POST /v0/host/stop` | `sidecar.stop()` |
  | `POST /v0/host/restart` | `sidecar.restart()` -> `{port, url}` |
  | `GET /v0/events` | long-poll <= 25s -> `{events: [...]}` (window-close is enqueued by the main window close request) |
  Wrong/missing token -> 403. Everything listens on 127.0.0.1 only.
- **DesktopBridge IPC** — 14 methods (`DESKTOP_BRIDGE_METHODS`) registered as
  literal `ipcMain.handle('bridge:<method>')` channels; push events `dsh:state`
  and `dsh:log` (`BRIDGE_EVENTS`). The preload allow-lists the method names
  before building any channel string.
- **DSH_SMOKE** — with `DSH_SMOKE=1` the app boots the real window/tray/sidecar
  path, waits for sidecar-running-with-ready-URL + hello + webview-attach, then
  writes the report and exits:

  ```json
  {"framework":"electron","profile":"…","pid":0,"readyLine":{"port":0,"url":"…"},
   "helloReceived":true,"webviewAttached":true,"errors":[]}
  ```

  `pid` is the **DSH host process** pid (the Electron pid is already known to
  whoever spawned it; the host pid is the one that can orphan). Report path:
  `DSH_SMOKE_OUT`, default `<userData>/smoke-report.json`. Timeout 90s -> same
  shape with `errors` populated and exit code 1.

## Navigation fence

`will-frame-navigate` / `will-redirect` (main frame) allow only the ready-line
origin (origin equality via `isSameOrigin`); before the ready line only the
local renderer surface (`file:` or the origin in `DSH_RENDERER_DEV_URL`) is
allowed. `setWindowOpenHandler` always denies; `http`/`https`/`mailto` targets
go to the OS via `shell.openExternal`. `open_external` IPC enforces the same
scheme allow-list.

## Environment variables

| Var | Meaning |
|---|---|
| `DSH_BIN` | explicit host binary/script (see contract above) |
| `DSH_PATCH` | override the injected cordis.patch.yml path |
| `DSH_HOME` | profile root (default `~/.dsh`) |
| `DSH_SMOKE` / `DSH_SMOKE_OUT` | smoke mode + report path |
| `DSH_UPDATE_URL` | opt-in electron-updater generic feed |
| `DSH_RENDERER_DEV_URL` | dev-server origin allowed by the fence before ready |

## Known limitations

- electron-updater is wired but cannot be verified locally: there is no
  published release feed yet (`TODO(release-infrastructure)` in `src/main/index.ts`).
- Packaged (asar) builds: `electron-builder.yml` ships only `dist/**`, so the
  tray icon and `cordis.patch.yml` need packaging work
  (`TODO(packaging)` in `src/main/tray.ts` / `src/main/sidecar.ts`).
- No `--host 0.0.0.0` is ever passed; the host stays on loopback by design.
