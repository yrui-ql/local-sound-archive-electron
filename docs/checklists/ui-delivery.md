# UI delivery gate

Do not call a UI change finished because the code compiles or the happy path renders. Run this gate and keep the evidence.

## 1. Screen inventory

For every changed screen, fill one row:

| Screen | States exercised | Primary action | Scroll owner | Evidence |
|---|---|---|---|---|
| Library | empty / loaded / long / hover / playing | play | list | screenshot |
| Recent | empty / loaded / long / playing | play | list | screenshot |
| Downloads | queue / records / empty / failed / clear | clear | list | screenshot |
| Recording | empty / recording / list / play / delete | record | list | screenshot |
| Likes | idle / syncing / error / connected | sync | page | screenshot |

If a screen is missing from this table, it was not reviewed.

## 2. Layout invariants

- [ ] Page title / summary / toolbar is fixed; content body is the only scroll region.
- [ ] Panels that should fill the page use `flex: 1` and `min-height: 0`; no dead blank area below a panel.
- [ ] No double scrollbar (`.main` + list) and no nested scroll trap.
- [ ] Empty state is centered in the available panel, not a small block in a huge canvas.
- [ ] At 100% / 125% / 150% DPI, controls do not overlap or clip.
- [ ] Header actions align with the panel header and stay reachable at narrow width.

## 3. Controls

- [ ] Every list has a discoverable scroll tool: hover overlay scrollbar, PageUp/PageDown, Home/End.
- [ ] Native `<select>` was checked; if present, it has a custom listbox with keyboard and aria.
- [ ] Row play control is not at the far right; current playing state is an indicator, not a pause glyph.
- [ ] Play/pause semantics: row = play this track; global player = pause/resume.
- [ ] Hover / focus-visible / active / disabled states exist.
- [ ] Selected state is neutral; no gold border, glow or decorative rail.

## 4. State feedback

- [ ] Loading >300ms is visible.
- [ ] Syncing/downloading has motion (spinner/pulse/sweep), stops on completion.
- [ ] Empty, error and partial states each have a recovery action.
- [ ] Counts and labels come from the real response, not optimistic UI.
- [ ] Reduced motion disables nonessential animation.

## 5. Evidence

- [ ] Current build screenshot for each changed screen.
- [ ] At least one empty state and one populated/long state screenshot.
- [ ] One keyboard pass (Tab/Enter/Arrow/PageUp/Home/End).
- [ ] Source audit and packaged audit pass.
- [ ] Reflection updated if a gap caused user correction.
