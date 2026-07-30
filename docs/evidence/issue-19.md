# Issue #19 evidence

## Scope

Four-operation required-component matrix, active-freeze override, fail-closed
CMS projection, and pass/fail/unknown post-deploy classification without
rollback authority.

## RED

- Command: `npm run test:unit`
- Exit: `1`
- Expected failure: `lib/domain/gate-policy.ts` did not exist.
- The operation matrix, missing/stale/state/freeze/dependency, signature
  tamper, and post-deploy classification test was present before
  implementation.

## GREEN

- Command: `npm run test:unit`
- Exit: `0`
- Result: 14 tests passed.
- The Issue test allows each operation only with all required fresh healthy
  verdicts, denies every non-healthy/missing/stale/frozen variant, signs
  deny/deny on dependency failure, and keeps unknown post-deploy outcomes away
  from any rollback capability.

## LOCAL

- Required-component matrices exist for all four named operations: PASS
- Fresh healthy required components and no freeze is the only allow path:
  PASS
- Missing, equality-boundary stale, degraded, unhealthy, unknown, and
  maintenance each deny: PASS
- An older healthy Observation cannot override the current unknown verdict:
  PASS
- Active freeze denies every operation: PASS
- Repository/provider/freeze-store exceptions project signed deny/deny: PASS
- Unsupported proposal/draft operation is rejected: PASS
- Tampered compatibility decision fails signature verification: PASS
- Post-deploy required unhealthy maps to fail; missing/unknown/error maps to
  unknown: PASS
- Guard has no rollback request port and produces no rollback command: PASS
- Worker Gate and post-deploy routes now use the same policy services: PASS
- `npm run lint`: PASS, exit 0
- `npm run typecheck`: PASS, exit 0

## STAGING_REMOTE

`NOT_RUN` — no staging component store, freeze record, Gate request, or
post-deploy request was used.

## PRODUCTION_REMOTE

`NOT_RUN` — production Gate remains inactive.

## Rollback / rehearsal

Revert this Issue's single commit. There is no migration or remote mutation;
the prior route behavior is already deny/unknown.

## Unresolved blockers

- The Worker operational-state repository is deliberately empty until the
  scheduler/materialized verdict source is provisioned, so deployed routes
  remain deny/unknown rather than claiming health.
- Production enablement requires at least 14 days of shadow evidence and owner
  approval.
- Current CMS workflow still rolls back on any post-deploy step failure,
  including `unknown`; classified workflow output is a required CMS-side fix.
- Active-maintenance mutation and release are separate signed/audited
  operations and are not silently implemented by this Gate.
