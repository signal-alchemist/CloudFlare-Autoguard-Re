# Issue #28 evidence

## Scope

Promote only confirmed persisted FAIL Observations into an Incident,
observation timeline, and sanitized pending notification outbox in one atomic
D1 batch. Reconcile both CMS and scheduled ingress, with bounded scheduler
repair. Queue enqueue and provider delivery remain outside this Issue.

## RED

- Command:
  `node --test tests/unit/failure-notification-outbox.test.ts`
- Exit: `1`
- Expected failure:
  `ERR_MODULE_NOT_FOUND lib/domain/incident-severity-policy.ts`
- Atomic Incident/timeline/outbox creation, server severity, exact replay, a
  new failure on the same fingerprint, restart, non-FAIL suppression, safe
  payload, corruption, rollback injection, and two repair shapes were asserted
  before implementation.
- Command:
  `node --test tests/unit/cms-signal-http.test.ts tests/unit/scheduled-public-delivery.test.ts`
- Exit: `1`
- Expected failures: 4 integration assertions. Neither canonical/compat CMS
  ingress nor scheduled observations had reconciliation wiring; injected
  outbox failure returned success and allowed a passing scheduler cycle.

## GREEN

- Command:
  `node --test tests/unit/failure-notification-outbox.test.ts`
- Exit: `0`
- Result: 4 tests passed, including the independent-review scope/index and
  resolved-migration regression.
- Command:
  `node --test tests/unit/cms-signal-http.test.ts tests/unit/scheduled-public-delivery.test.ts`
- Exit: `0`
- Result: 9 tests passed.
- Command:
  `npm run test:unit`
- Exit: `0`
- Result: 34 tests passed.
- Command:
  `npm run validate`
- Exit: `0`
- Result: lint, typecheck, 34 unit tests, and production build passed.
- Command:
  `npm run test:rendered`
- Exit: `0`
- Result: 3 rendered Worker/HTML tests passed.
- Command:
  `npm run test:release`
- Exit: `0`
- Result: release contract passed with migrations `0000`–`0007`, both failure
  reconciliation ingress paths, bounded repair, and no Queue/provider call.

## Independent review regression

- Review found and reproduced three P1 risks before commit: cross-scope repair,
  an unindexed 90-day failure scan, and a pre-0007 resolved Incident repeatedly
  poisoning every scheduler cycle.
- Scope binding, a covering repair index/query-plan assertion, and a blocked
  legacy-resolution backfill were added.
- Re-review result: no findings; targeted tests and `git diff --check` passed.

## LOCAL

- Only exact persisted `Observation.status === "fail"` creates output; pass,
  degraded, unknown, unsupported, and maintenance-shaped input are ignored:
  PASS
- `incident-severity-v1` is checked in and ignores inbound severity; automated
  SEV-1 is forbidden: PASS
- Incident, observation timeline, and pending notification outbox use one D1
  batch; injected outbox failure rolls Incident and timeline back while the
  previously persisted Observation remains repairable: PASS
- Payload is strict `safe-notification-envelope-v1`, canonicalized by
  `compileNotificationDelivery`, digest-bound, and free of raw signal,
  exception message, credential, Cookie, token, and inbound severity: PASS
- Exact replay and restart do not grow rows. A different FAIL with the same
  fingerprint adds one timeline event and preserves one original
  `incident_opened` outbox payload: PASS
- Existing timeline/payload content conflicts and corruption fail closed
  instead of being overwritten: PASS
- CMS canonical accepted and compat fresh-envelope duplicate both reconcile;
  raw exact replay remains `409`, while a reconcile failure is generic `503`
  and the fresh duplicate repairs the missing rows: PASS
- Scheduled new and existing FAIL observations reconcile without re-probing
  persisted targets. Reconcile failure leaves no PASS heartbeat: PASS
- Bounded scheduler repair handles both missing timeline and existing
  timeline with missing outbox, at no more than 32 rows per cycle: PASS
- Repair is bound to the configured site/environment, uses the
  `observations_failure_repair_idx` query plan, and does not mutate a
  different scope in a shared or misbound database: PASS
- A pre-0007 resolved Incident with its original timeline but no outbox
  converges to a non-deliverable `incident_resolved_before_outbox` blocked
  row; a genuinely new post-resolution FAIL remains fail-closed: PASS
- Migration `0007` is additive/repeatable, uses restrictive Observation and
  Incident foreign keys, DB-constrained outbox statuses, unique
  Incident/kind, a pending scan index, and an indexed failure repair scan:
  PASS
- No Queue enqueue, provider call, or delivery-state mutation exists in the
  Issue #28 operation: PASS by source/release contract

## STAGING_REMOTE

`NOT_RUN` — no staging D1 migration, CMS retry, Cron repair scan, Queue
inventory, or failure injection was executed remotely.

## PRODUCTION_REMOTE

`NOT_RUN` — no production Observation, Incident, timeline, outbox, Queue, or
provider state was read or changed.

## Rollback / rehearsal

Before migration `0007`, revert this Issue's single implementation commit.
After applying the additive migration, stop new reconciliation during
application rollback and retain outbox rows as audit/idempotency evidence.
Do not manually enqueue or delete pending rows.

Rehearse a canonical CMS FAIL, exact raw replay, fresh-envelope duplicate,
outbox write failure followed by retry, scheduled direct FAIL, existing
Observation repair without network re-probe, partial D1 failure, stale
scheduler heartbeat detection, and Worker restart. Queue/provider delivery is
rehearsed only after Issue #29.

## Unresolved blockers

- Staging and production need separate migrated D1 bindings and remote batch
  rollback evidence.
- Queue/DLQ/provider resources, credentials, notification destinations,
  on-call severity ownership, retry budget, and escalation policy remain
  unconfigured and are Issue #29 scope.
- An external monitor must detect missing or stale scheduler heartbeat when
  the Worker or D1 cannot persist its own failure.
- A resolved fingerprint recurring as a new failure needs an explicit episode
  ID/reopen transition and notification idempotency contract. Until then it
  fails closed as `incident_reopen_required`.
