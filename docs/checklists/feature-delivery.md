# Feature delivery checklist

Use this before writing code and again before saying a feature is done.

## 1. User task

- [ ] Who is doing this and what are they trying to finish?
- [ ] What is the first-use state, with no configuration?
- [ ] What are the decision points?
- [ ] What happens on cancel / retry / duplicate / failure?

## 2. States

- [ ] Idle
- [ ] Loading (>300 ms has feedback)
- [ ] Progress for long jobs
- [ ] Empty (first use, filtered empty, error-empty are distinct)
- [ ] Success with real result
- [ ] Failure with a recovery action
- [ ] Partial / degraded, if external services can fail

## 3. Lists and data

- [ ] Pagination or bounded render
- [ ] Loading more keeps scroll position
- [ ] Delete removes the row and updates the count
- [ ] Large dataset does not block the first render
- [ ] Empty state has a next action

## 4. Interaction

- [ ] Destructive action has confirmation and a clear consequence
- [ ] Keyboard reachable; icon buttons have `aria-label`
- [ ] Focus is visible and returns after modal close
- [ ] Hover / active / disabled states exist
- [ ] No permanent scrollbar rails; no layout shift

## 5. Configuration

- [ ] Public defaults in `config/default.json`
- [ ] Personal values only in local data/config
- [ ] No personal path, account, credential, or machine name in source
- [ ] Ports/URLs can be changed; occupied ports are handled

## 6. Verification

- [ ] Syntax check changed JS
- [ ] Real app path tested
- [ ] Failure path tested
- [ ] Screenshot updated if UI changed
- [ ] Source audit passes
- [ ] Packaged artifact audit passes with the pinned vendor allowlist
- [ ] Reflection written if the feature exposed a process gap
