# Issue #8 evidence

## Scope

Deterministic Incident fingerprinting, durable D1 deduplication, append-only
timeline, guarded state transitions, and restart-safe resolution.

## RED

- Command: `npm run test:unit`
- Exit: `1`
- Expected failure: `lib/domain/incidents.ts` did not exist.
- The fingerprint, persistence, replay, transition, resolution, and restart
  test was present before implementation.

## GREEN

- Command: `npm run test:unit`
- Exit: `0`
- Result: 9 tests passed.
- The Issue test records two distinct Observations into one Incident, suppresses
  an exact replay, reopens the database, walks the state machine, rejects weak
  SEV-1 resolution, accepts sufficient evidence, and suppresses a duplicate
  transition command.

## LOCAL

- Frozen SHA-256 fingerprint vector over five identity fields: PASS
- Any site/environment/component/reason/scope change changes fingerprint: PASS
- D1 unique fingerprint creates one Incident under repeated failure: PASS
- Distinct Observations append timeline; exact replay does not: PASS
- State and timeline survive database close/reopen: PASS
- Skipped and post-resolution transitions are rejected: PASS
- SEV-1 one-success resolution is rejected without timeline mutation: PASS
- Resolution requires human acknowledgement and every required source: PASS
- Duplicate transition idempotency key does not append a second event: PASS
- All migrations remain repeatable in the durability regression test: PASS
- `npm run lint`: PASS, exit 0
- `npm run typecheck`: PASS, exit 0

## STAGING_REMOTE

`NOT_RUN` — no staging D1 database or live Incident was used.

## PRODUCTION_REMOTE

`NOT_RUN` — no production Incident was created or transitioned.

## Rollback / rehearsal

Revert this Issue's single commit before applying its additive migration
remotely. After remote use begins, keep Incident/timeline tables until retention
and export owners approve destructive cleanup.

## Unresolved blockers

- Severity escalation policy for a later Observation sharing the same
  fingerprint requires an explicit operations-owner decision.
- On-call acknowledgement identity and escalation timing remain external
  configuration.
- Automatic resolution is not enabled; the tested evidence gate only permits
  an authorized transition command.
