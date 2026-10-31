# ADR 0001 — Migrate the desktop shell to Electron

- Status: accepted
- Date: 2026-10-31

## Context

The current Windows client is a .NET 10 WinForms host with a WebView2-rendered
local UI. The UI itself is portable HTML/CSS/JS, but the host is Windows-only:
WinForms, WebView2, NAudio, Win32 shell calls, drive-letter paths and Windows
installer assumptions.

The product needs a first-class macOS build, eventually on a Mac mini, while
keeping the existing UI and Web Audio playback behavior.

## Decision

Rebuild the **host and platform layer** on Electron + TypeScript.

Keep and reuse:

- the existing local HTML/CSS/JS UI;
- the Web Audio player, equalizer, meter and lyrics renderer;
- the local library schema and business rules;
- the extension JSON-RPC protocol;
- the local MCP/AI control contract;
- the optional `go-music-dl` backend (Go is cross-platform).

Replace:

- WinForms with a secure Electron main process;
- WebView2 APIs with Electron's `BrowserWindow` and IPC;
- NAudio with Chromium/Web Audio for consistency across both platforms;
- Windows shell calls with a platform adapter layer.

## Window chrome

The Electron window uses:

- `frame: false` on Windows and Linux;
- `titleBarStyle: 'hiddenInset'` on macOS, preserving the native traffic lights;
- a custom HTML titlebar and window controls on Windows;
- `-webkit-app-region: drag` for the drag surface and `no-drag` for controls.

There is no native Windows caption/title strip. The content extends to the top
edge of the window.

## Security baseline

- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: true` where the feature set allows it
- a narrow preload bridge instead of exposing Node APIs to the renderer
- local-only protocols for audio and app assets
- no remote content loaded into the main window

## Migration milestones

### M1 — Shell spike — implemented 2026-10-31

- Electron project boots on Windows.
- Existing UI loads.
- Frameless window, drag, resize, minimize, maximize and close work.
- A local FLAC plays through the existing Web Audio player.
- A short macOS smoke test is planned once the Mac is available.

Windows evidence (2026-10-31): frameless window loaded the existing UI, scanned
1366 local tracks, played a FLAC through the existing Web Audio player, and
served audio over a localhost Range-capable HTTP endpoint. macOS has not been
tested yet.

### M2 — Core services

- SQLite library service and migrations.
- Local scan/index/import/dedupe.
- Metadata and lyrics loading.
- Range-capable local audio protocol.
- Settings and portable data paths.

### M3 — Platform adapters

- Trash / recycle bin.
- Hard links and copy fallback.
- Child process management for `go-music-dl`.
- Tray, media keys, sleep inhibition, notifications.
- Windows Authenticode and macOS Developer ID/notarization.

### M4 — Extension and AI control

- Node-based extension host with the existing JSON-RPC contract.
- Local MCP bridge and token-gated control API.

## Consequences

Positive:

- One UI and one audio stack on Windows and macOS.
- Consistent Chromium media/Web Audio behavior.
- Native macOS window controls and packaging path.

Negative:

- The C# service layer must be ported to TypeScript or replaced.
- Larger installer and memory footprint than WinForms.
- Code signing and notarization become separate release work.

## Non-goals for this migration

- Do not keep WinForms as the primary long-term host.
- Do not port the C# UI bridge one-to-one; define a small host contract.
- Do not make the renderer depend on Electron APIs directly.

