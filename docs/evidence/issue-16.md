# Issue #16 evidence

## Scope

Keyboard navigation, semantic landmarks/headings/names, responsive information
order, reduced-motion behavior, readable contrast tokens, and separation of
local checks from staging/production remote evidence.

## RED

- Command: `npm run test:rendered`
- Exit: `1`
- Expected first failure: desktop navigation had no accessible name.
- The same pre-implementation test also required a mobile navigation,
  focusable main target, correctly linked section/card/panel headings, explicit
  status names, persistent remote-evidence labels, non-overlapping mobile gate
  rows, 44px targets, visible focus, reduced motion, and truthful snapshot
  invariants.

## GREEN

- Command: `npm run test:rendered`
- Exit: `0`
- Result: 3 rendered Worker/HTML/CSS tests passed after a production build.
- `npm run test:unit`: PASS, 15 tests.
- Total local test checks displayed by the console: 18.
- `npm run lint`: PASS.
- `npm run typecheck`: PASS.

## LOCAL

- Named desktop and mobile navigation landmarks: PASS
- Skip link targets a programmatically focusable `main`: PASS
- Component, gate, incident, notification, deploy, and readiness regions are
  linked to unique visible headings: PASS
- Visible status text also has explicit accessible names: PASS
- Operability live region is polite and atomic: PASS
- Native details/summary, anchors, and refresh control remain keyboard
  operable with a high-visibility focus ring: PASS
- Interactive targets have a 44px minimum: PASS
- 1180px, 860px, and 560px layout contracts are present: PASS
- Mobile navigation replaces the hidden sidebar: PASS
- Gate freshness moves to its own mobile row: PASS
- `REMOTE NOT RUN` remains visible at phone width: PASS
- Reduced-motion disables animation, transition, and hover displacement:
  PASS
- Muted/eyebrow/code tokens were darkened for small-text contrast: PASS
- Production and staging snapshots both remain `UNKNOWN`, `REMOTE NOT RUN`,
  and all gates `DENY`: PASS

## STAGING_REMOTE

`NOT_RUN` — no staged app, browser matrix, assistive-technology session, or
real staging data adapter was used. A staging-scoped deployment therefore
continues to show `REMOTE NOT RUN`.

## PRODUCTION_REMOTE

`NOT_RUN` — no production browser or assistive-technology session was used.

## Rollback / rehearsal

Revert this Issue's single commit. No remote resource, migration, or operation
decision changes are involved.

## Unresolved blockers

- Run the keyboard/screen-reader/browser matrix against the private staging
  deployment after its Access audience and state adapter exist.
- Validate text contrast and zoom/reflow with real browser accessibility
  tooling in staging; this Issue records deterministic SSR/CSS checks only.
- Remote evidence remains separate and cannot be promoted by these local UI
  checks.
