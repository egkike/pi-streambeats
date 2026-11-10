## What this changes

<!-- One paragraph. What behaviour is different after this PR, and for whom. -->

## Specs covered

<!-- S-numbers from odd/tasks/<feature>.md, or "none (docs only)". -->

## How it was verified

<!-- Commands actually run, and their result. "Not run" is a valid answer; guessing is not. -->

```
pnpm check
```

## Risk

<!-- Item N from the risk list with its reason, or "none". -->

Risk: none

## Checklist

- [ ] Tests cover the behaviour this PR changes, including the cases the spec names
- [ ] `pnpm check` passes locally (lint, typecheck, test)
- [ ] Behaviour changes update `odd/tasks/<feature>.md` (`S#` and a new `L#`)
- [ ] Docs or help text updated if a command, option or message changed
- [ ] No new runtime dependency (or it was agreed before this PR)
