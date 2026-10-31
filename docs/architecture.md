# LSA architecture

This document is the source of truth for process boundaries, folders, naming, configuration and dependency direction.

## Process boundaries

LSA follows the standard Electron three-process split:

```text
renderer (ui/)  ──IPC──▶  preload (src/preload/index.js)  ──▶  main (src/main/)
```

- **Main** owns filesystem, SQLite, HTTP servers, dialogs, OS integration and lifecycle.
- **Preload** exposes only the existing `window.chrome.webview` compatibility surface plus explicit window controls. It never exposes `ipcRenderer`.
- **Renderer** is browser-only: no Node, no `require`, no direct filesystem. It talks through the preload bridge.

The structure follows the common Electron recommendation to keep `main`, `preload` and renderer-specific code separate and to keep privileged work in the main process ([project structure](https://github.com/jwynia/agent-skills/blob/main/skills/tech/development/tooling/electron-best-practices/references/architecture/project-structure.md), [process separation](https://github.com/jwynia/agent-skills/blob/main/skills/tech/development/tooling/electron-best-practices/references/architecture/process-separation.md)).

## Repository layout

```text
src/
  main/
    index.js                 composition root: app lifecycle, BrowserWindow, IPC dispatch
    services/                main-process domain services
      account.js             QR/web-cookie account flows
      library.js             SQLite index + track serialization
      extensions.js          extension registry and install lifecycle
      extension-host.js      out-of-process extension execution
      likes.js               liked-music configuration/state
  preload/
    index.js                 narrow contextBridge surface
ui/                          renderer assets (legacy-compatible HTML/CSS/JS)
ai-control/                  local AI-control protocol + MCP bridge
extension-sdk/               extension contract, docs, sample
scripts/                     deterministic build and sync scripts
config/
  default.json               public defaults, no personal values
  local.example.json         placeholder-only user config example
  privacy-allowlist.json     pinned vendor runtime hashes
build/                       icons and platform signing resources
docs/                        architecture, ADRs, screenshots
```

`ui/` is intentionally kept as the renderer directory because it is the existing shared web UI used by the legacy host. If the renderer is migrated to a framework later, move it as one unit to `src/renderer/`; do not split main-process modules into the renderer tree.

## Dependency direction

```text
ui/ ──▶ preload ──▶ main/index.js ──▶ main/services/*
```

- Services must not import renderer files.
- Services should not import `main/index.js`; pass state in via constructors or return values.
- Preload must not import services.
- Any new privileged capability gets a named IPC command, validation in main and a narrow preload method.

## Naming and ownership

- Folders: lowercase, one responsibility per folder.
- Modules: lower-kebab-case files; classes are `PascalCase` where present.
- IPC commands: verb + noun (`getDownloads`, `recordStart`, `qrPoll`), one handler per command.
- One writer per file when multiple agents work in parallel; service modules are the unit of ownership.
- Do not add a second generic “utils” file. If a helper is shared, give it a domain-specific home.

## Configuration layers

Precedence, lowest to highest:

```text
config/default.json  <  DATA_DIR/config.json  <  environment variables
```

- `config/default.json`: public defaults, no user paths or secrets.
- `DATA_DIR/config.json`: per-machine user overrides, never committed.
- `admin-credentials.txt`: local secret file in `DATA_DIR`, never committed.
- `config/privacy-allowlist.json`: pinned third-party runtime hashes for the release audit gate.

Personal music directories and backend URLs belong in the local config, not in source code. This is the “generic core + user configuration” rule from the workspace.

## Release and audit

The release gate scans:

1. project source, configuration and docs;
2. the wrapper launcher;
3. project-owned resources;
4. a pinned third-party runtime hash.

Official Electron binaries contain upstream test fixture paths and test-looking keys. They are not user data, but binary scanning cannot distinguish them from real secrets. The correct fix is a **hash-pinned vendor allowlist** (`config/privacy-allowlist.json`), not deleting bytes from the runtime. The allowlist applies only when the SHA256 matches exactly; project-owned files are still scanned.

## Known follow-up

`src/main/index.js` is still the composition root and contains command orchestration. The next safe split is to extract audio, AI and recording servers into `src/main/services/` once their contracts are covered by tests. Do not split them without characterization tests.
