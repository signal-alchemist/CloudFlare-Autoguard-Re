# Issue #17 evidence

## Scope

Pure component freshness/quorum verdicts and an internal required-component
eligibility check that never extends last-known healthy state.

## RED

- Command: `npm run test:unit`
- Exit: `1`
- Expected failure: `lib/domain/component-verdict.ts` did not exist.
- The freshness, uncertainty, quorum, scope, conflict, and fail-closed matrix
  was present before implementation.

## GREEN

- Command: `npm run test:unit`
- Exit: `0`
- Result: 8 tests passed.
- The Issue test covers fresh pass, missing, equality-boundary stale, newer
  unknown, provider uncertainty, two-source quorum, wrong scope, future,
  invalid validity, unsupported, conflicting observations, and all non-healthy
  component states.

## LOCAL

- All required sources fresh/pass is the only `healthy` path: PASS
- `validUntil <= now` is stale: PASS
- A newer unknown result wins over an older still-valid pass: PASS
- timeout, 403, 429, 5xx, and schema drift map to distinct `unknown` reasons:
  PASS
- Two-source pass/fail is degraded below quorum; fail/fail is unhealthy: PASS
- Site, environment, component, check, and source scope are exact: PASS
- Future and server-policy-invalid validity windows are unknown: PASS
- Same input set produces the same sorted verdict independent of order: PASS
- Conflicting same-time evidence is unknown: PASS
- Missing, stale, degraded, unhealthy, unknown, and maintenance all deny the
  internal required-component check: PASS
- `npm run lint`: PASS, exit 0
- `npm run typecheck`: PASS, exit 0

## STAGING_REMOTE

`NOT_RUN` — no staging provider or second-location probe was queried.

## PRODUCTION_REMOTE

`NOT_RUN` — no production verdict was calculated from remote evidence.

## Rollback / rehearsal

Revert this Issue's single commit. The evaluator is pure and creates no remote
or database mutation.

## Unresolved blockers

- Current CMS ops signals are failure-only; dedicated probe/provider
  Observations are required to establish a healthy component.
- Production two-location policy awaits an approved external probe source.
- Operation-specific component matrices and signed CMS compatibility output
  remain Issues #19 and #11.
