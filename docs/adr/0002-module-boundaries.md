# ADR 0002 — Main/preload/services module boundaries

## Status

Accepted — 2026-10-31

## Context

The first Electron milestone grew a single `src/main.js` plus flat sibling modules. That was enough to boot the legacy renderer, but the directory told a new contributor nothing about process ownership, dependency direction or where a new capability belongs. Configuration defaults and release auditing were also mixed into ad-hoc paths.

## Decision

Adopt the standard Electron process split and make it visible in the tree:

```text
src/main/index.js       composition root
src/main/services/      main-only domain services
src/preload/index.js    narrow bridge
ui/                     renderer
config/                 public defaults + local override examples + vendor audit pins
```

Rules:

- `ui/` never imports Node; all privileged work goes through named IPC commands.
- Preload exposes only the existing host contract and window controls; no raw `ipcRenderer`.
- Services do not import the composition root.
- Public defaults live in `config/default.json`; personal paths/credentials live in the local data directory.
- The release audit uses a SHA256-pinned vendor allowlist for the official Electron runtime. Project-owned files are always scanned.
- The composition root remains the orchestration point until audio/AI/recording servers have characterization tests; extracting them without tests is a regression risk.

## Consequences

- New capabilities have an obvious home and owner.
- Multiple agents can work on separate service files without overlapping writes.
- Configuration and audit policy are explicit and reproducible.
- `src/main/index.js` is still larger than ideal; follow-up extraction is tracked as maintenance, not done blindly.
