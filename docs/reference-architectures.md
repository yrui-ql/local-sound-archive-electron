# Reference architectures

This document records what was learned by inspecting real open-source Electron projects, not from blog summaries. The goal is to copy patterns that fit LSA and reject patterns that would add accidental complexity.

## Method

For each project I inspected the repository tree (via the GitHub API) and the process/module split. The useful question is not “what folder names do they use”, but:

- Which process owns privileged capability?
- What is the smallest bridge into the renderer?
- Where do domain services live?
- How are features/windows separated?
- What is shared, and what is platform-specific?

## 1. VS Code

Repository: [microsoft/vscode](https://github.com/microsoft/vscode)

Observed structure:

```text
src/vs/base/        primitives and browser UI building blocks
src/vs/platform/    platform services and contracts
src/vs/editor/      editor core
src/vs/workbench/   application shell
  contrib/          feature contributions
  services/         workbench services
  api/              extension API
```

What to learn:

- The codebase is layered by dependency direction, not by file type: `base` has no workbench dependencies; `platform` provides contracts; `workbench/contrib/*` contains feature-specific code.
- Features are **contributions** registered at boundaries. This is why a huge product can still add a feature without editing a giant central switch.
- The extension API is an explicit boundary, not direct access to internal objects.

What LSA adopts:

- `src/main/index.js` is the composition root; domain code belongs in `src/main/services/`.
- Future features should be added as service modules with a narrow command registration, rather than growing one switch forever.

What LSA rejects for now:

- Full dependency-injection/contribution framework. LSA does not have VS Code's scale; introducing it now would be ceremony without payoff.

## 2. FreeTube

Repository: [FreeTubeApp/FreeTube](https://github.com/FreeTubeApp/FreeTube)

Observed structure:

```text
src/main/          Electron main process
src/preload/       contextBridge surface
src/renderer/      Vue renderer
  components/      feature/component boundaries
src/data/          renderer-facing data
src/datastores/    persistence/state handlers
```

What to learn:

- Electron-specific boundaries are explicit and boring in the best way: main, preload and renderer are separate trees.
- The preload is a dedicated API layer, not an extra folder inside the renderer.
- State/persistence is separated from UI components (`datastores`).

What LSA adopts:

- `src/main/`, `src/preload/`, `ui/` split.
- Persistence stays in main services (`library.js`), not in the renderer.

What LSA should add next:

- A small **shared IPC contract** so the renderer and main agree on command names and payloads. LSA currently uses a legacy generic `host-call`; that works but is not a contract. This is follow-up work, not a blind rewrite.

## 3. Joplin

Repository: [laurent22/joplin](https://github.com/laurent22/joplin)

Observed structure:

```text
packages/app-desktop/    Electron shell and desktop-specific UI
packages/lib/            shared domain models/services/migrations
packages/renderer/       markdown rendering
packages/editor/         editor packages
```

What to learn:

- A mature multi-platform app separates the **desktop shell** from **platform-independent core**.
- `lib/services`, `lib/models`, `lib/migrations` are explicit responsibilities; migrations are not hidden in startup code.
- Shared core packages are versioned and consumed by multiple apps (desktop, CLI, mobile).

What LSA adopts:

- Domain services are kept outside the window/lifecycle code (`src/main/services`).
- SQLite/library code is a service, not inline in IPC handlers.

What LSA rejects for now:

- A monorepo. LSA has one desktop product and one renderer. Splitting into packages before there is a second consumer would be premature.

## 4. Zettlr

Repository: [Zettlr/Zettlr](https://github.com/Zettlr/Zettlr)

Observed structure:

```text
source/app/              application services and providers
source/common/           shared modules and utilities
source/win-main/         main window feature areas
source/win-preferences/  separate windows
source/win-*.ts          window-specific entry points
```

What to learn:

- Window boundaries are explicit. Preferences/update/about are separate windows with their own entry points, not conditional clutter in the main window.
- Service providers are a named application layer, not a junk drawer.

What LSA adopts:

- Main process service layer and explicit window lifecycle.
- Future secondary windows (preferences/log viewer) should get their own entry modules instead of more branches in `createWindow`.

## Patterns adopted in LSA

| Pattern | Source observation | LSA location |
|---|---|---|
| Main/preload/renderer separation | FreeTube, Electron guidance | `src/main`, `src/preload`, `ui` |
| Domain services outside lifecycle | VS Code platform/services, Joplin lib/services | `src/main/services` |
| Feature-oriented UI modules | FreeTube renderer components | `ui/` existing modules |
| Explicit window entry points | Zettlr win-* | future `src/main/windows/` |
| Public defaults + local overrides | workspace rule, all projects | `config/` + data dir |
| Pinned vendor runtime audit | release engineering | `config/privacy-allowlist.json` |

## Gaps found by comparison

1. **No shared IPC contract.** LSA's legacy `host-call` command switch is convenient but weakly typed. Plan: introduce `src/shared/ipc.js` with command names/payload validation, then keep the legacy surface as an adapter.
2. **Composition root still large.** `src/main/index.js` orchestrates too many servers. Plan: extract audio/AI/recordings services after characterization tests, not before.
3. **No automated main-service tests.** Add tests around download queue lifecycle, recording pagination and account credential fallback.
4. **No window module.** Secondary windows do not exist yet; when they do, use Zettlr's one-entry-per-window pattern.

## What I will not copy

- VS Code's DI/contribution framework at LSA's scale.
- Joplin's monorepo for a single app.
- A framework migration for the existing renderer just to match another project's stack.

The point of reading real projects is to extract boundaries and trade-offs, not to cargo-cult folder names.
