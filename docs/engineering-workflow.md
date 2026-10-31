# Engineering workflow

This is the working loop for LSA changes. It exists so implementation decisions are researched and verified instead of guessed.

## 0. Product framing first

Before any code, write the user task and the state matrix. Use `docs/checklists/feature-delivery.md` and `docs/product-reflection-2026-10-31.md`. A feature is not a host command; it is a complete user path with empty, loading, success, failure and retry states.

## 1. Classify the change

| Type | Examples | Required before code |
|---|---|---|
| Unknown / new tech | first Electron use, native capture, signing | web research + a short spike |
| Cross-cutting | architecture, config, IPC contract, release | ADR + tests |
| UI behavior | recording UX, account modal, list loading | state/empty/error/loading checklist + screenshot |
| Bug fix | port occupied, clear queue 403 | reproduce + evidence + regression check |

If a requirement is not understood, stop coding and research first. Use official docs, the upstream repository and existing best-practice references.

## 2. Research first (required for unknowns)

For Electron questions, check at least:

- the Electron process model and security guidance;
- an established project-structure reference;
- the upstream library/package source or release notes;
- **at least one real open-source project using the same stack**, inspected at the repository-tree/code level — not only a blog post or summary.

For the last item, record:

- repository URL and the exact directories inspected;
- what the project separated (process, service, window, feature, shared code);
- what pattern LSA adopts and what it rejects, with a reason.

The current case studies live in [reference-architectures.md](reference-architectures.md). Update that file when a new stack/architecture decision is made.

Useful references:

- [Electron project structure reference](https://github.com/jwynia/agent-skills/blob/main/skills/tech/development/tooling/electron-best-practices/references/architecture/project-structure.md)
- [Electron process separation](https://github.com/jwynia/agent-skills/blob/main/skills/tech/development/tooling/electron-best-practices/references/architecture/process-separation.md)
- [Electron security checklist](https://github.com/jwynia/agent-skills/blob/main/skills/tech/development/tooling/electron-best-practices/references/security/security-checklist.md)
- [VS Code](https://github.com/microsoft/vscode), [FreeTube](https://github.com/FreeTubeApp/FreeTube), [Joplin](https://github.com/laurent22/joplin), [Zettlr](https://github.com/Zettlr/Zettlr)

Record the decision and trade-offs in `docs/adr/`. Do not leave architecture decisions only in chat.

## 3. Design the layer boundary

Before writing code, answer:

- Does this need Node/filesystem? → main service.
- Does the renderer need it? → named IPC command + preload method.
- Is it user-specific? → local config, not source.
- Is it deterministic and repeatable? → `scripts/`.
- Is it a UI state? → explicit loading/empty/error/success states.

## 4. Implement in small vertical slices

One slice = one user-visible behavior + its IPC + its error path + its verification.

Rules:

- Keep `ui/` free of Node APIs.
- Validate every IPC argument in main.
- Return structured `{ ok, error }` results; never let renderer invent success.
- Destructive actions require confirmation and a real result message.
- Lists that can grow use pagination; never render an unbounded DOM.
- New configuration belongs in `config/default.json` + local override, not in code.

## 5. Verify before claiming done

For every behavior:

1. Syntax check changed JS.
2. Run the app and exercise the actual path (or a smoke command that invokes the real handler).
3. Check the failure path, not only the success path.
4. Run `privacy-audit` for source/config.
5. For a release package, run the artifact audit with the pinned vendor allowlist and launch the packaged app.

UI changes additionally need to pass `docs/checklists/ui-delivery.md`: every screen in the inventory, every layout invariant, every control, every state, and a current screenshot. A feature is not done because one screen looks acceptable in one state.

## 6. Release gate

```bash
node .agents/scripts/privacy-audit.mjs src ui config README.md --full
node .agents/scripts/privacy-audit.mjs \
  release/LSA-portable/LSA.exe \
  release/LSA-portable/LSA-electron.exe \
  --artifact --full --allowlist config/privacy-allowlist.json
```

- Project-owned files must be `errors=0`.
- A vendor binary may be skipped only by an exact SHA256 match in `config/privacy-allowlist.json`.
- Never “fix” a binary audit by zeroing upstream bytes; that breaks the runtime. Redact or allowlist only with a documented reason.

## 7. Reflect

After a bug or a user complaint, write down:

- the symptom and reproduction;
- the actual root cause (not the surface);
- the smallest correct fix;
- the check that would have caught it earlier.

Turn repeatable checks into a script or a test; do not leave them as conversation-only knowledge.
