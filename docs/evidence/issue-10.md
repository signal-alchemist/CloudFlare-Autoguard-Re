# Issue #10 evidence

## Scope

D1-backed Observation, receipt, audit, and replay storage with repeatable
migration, restart durability, and idempotent duplicate handling.

## RED

- Command: `npm run test:unit`
- Exit: `1`
- Expected failure: `lib/repositories/observations.ts` did not exist.
- The migration/restart/idempotency test was present before the repository
  implementation.

## GREEN

- Command: `npm run test:unit`
- Exit: `0`
- Result: 5 tests passed.
- The Issue test applies the migration twice, closes and reopens the SQLite
  database, submits the same Observation again, and verifies one Observation,
  receipt, audit event, and replay claim.

## LOCAL

- Repeatable D1-compatible migration: PASS
- Durable Observation lookup after database reopen: PASS
- Idempotent duplicate result without duplicate audit records: PASS
- Durable captured-request replay claim: PASS
- Idempotency conflict detection for a changed payload: covered by repository
  contract and enforced before a duplicate response
- `.openai/hosting.json` D1 binding name `DB`: PASS
- `npm run lint`: PASS, exit 0
- `npm run typecheck`: PASS, exit 0
- `npm run build`: PASS, exit 0

## STAGING_REMOTE

`NOT_RUN` — no staging D1 database or binding was provisioned for this Issue.

## PRODUCTION_REMOTE

`NOT_RUN` — no production database was read or mutated.

## Rollback / rehearsal

Revert this Issue's single commit before applying the migration remotely. If
the migration has already been applied, leave the additive tables in place
until data retention and export decisions are approved; the application can
stop writing to them without destructive rollback.

## Unresolved blockers

- Remote D1 binding creation and migration execution remain deployment work.
- Replay-claim expiry cleanup is intentionally deferred to the scheduled
  retention workflow.
