# Issue #29 evidence

## Scope

Dispatch scoped pending notification outbox rows to an optional dedicated
Cloudflare Queue, consume only exact locally authorized envelopes, deliver
through an explicitly enabled reviewed HTTPS provider, persist a restart-safe
2xx marker, and ACK only after that marker. No migration or remote resource
mutation is included.

GitHub child Issue #29 is already linked to parent Issue #22 and remains open.
Its eight acceptance perspectives are mirrored as `#29-T01` through `#29-T08`
in `docs/03-issue-commit-map.md`. Executable evidence lives in this file; no
remote runtime result is inferred from local tests.

## RED

- Command:
  `node --test tests/unit/notification-outbox-dispatch.test.ts tests/unit/http-notification-provider.test.ts`
- Exit: `1`
- Expected failures:
  `ERR_MODULE_NOT_FOUND lib/repositories/notification-outbox.ts` and
  `ERR_MODULE_NOT_FOUND lib/adapters/http-notification-provider.ts`.
- Command: `node --test tests/unit/notification-delivery.test.ts`
- Exit: `1`
- Expected failure: provider/marker/ACK ran without exact local outbox
  authorization.
- Command: `node --test tests/unit/notification-worker.test.ts`
- Exit: `1`
- Expected failure: missing export
  `consumeConfiguredNotificationBatch`.

## GREEN

- Targeted command:
  `node --test tests/unit/notification-outbox-dispatch.test.ts tests/unit/http-notification-provider.test.ts tests/unit/notification-delivery.test.ts tests/unit/notification-worker.test.ts tests/unit/scheduled-public-delivery.test.ts`
- Exit: `0`
- Result: 17 scoped dispatcher, provider, delivery, Worker configuration, and
  scheduler separation tests passed.
- Command: `npm run test:unit`
- Exit: `0`
- Result: 44 tests passed.
- Command: `npm run validate`
- Exit: `0`
- Result: lint, typecheck, 44 unit tests, and production build passed.
- Command: `npm run test:rendered`
- Exit: `0`
- Result: production build and 3 rendered Worker/HTML tests passed.
- Command: `npm run test:release`
- Exit: `0`
- Result: production build and the release contract passed with migrations
  `0000`–`0007`, zero generated Queue producer/consumer bindings, local runtime
  ready, and staging/production remote evidence `NOT_RUN`.

## Independent review regression

- Review required exact selected-row CAS fields and pending NULL invariants,
  verified benign terminal replay, source Observation material authorization,
  Queue JSON content metadata, wrong Queue fail-closed behavior, non-default
  port rejection, no redirect follow-up, scheduler heartbeat isolation, and
  explicit generated-binding/remote-evidence assertions.
- Review then reproduced one P2: a corrupt oldest pending timestamp/state
  snapshot rejected the whole scan before quarantine and could starve later
  valid rows. A separate exact raw-snapshot/scope CAS now quarantines it with
  the fixed blocked code while the same cycle continues.
- Independent re-review found no remaining P1/P2 finding. Each review item has
  a dedicated regression assertion.

## LOCAL

- Scoped SQL scan ignores foreign site/environment rows, selects at most ten in
  stable order, sends a canonical envelope object with JSON content type, and
  awaits send before CAS: PASS
- Missing Queue performs no scan or mutation. Queue send and CAS failures leave
  the row pending without exposing exception details: PASS
- CAS binds outbox/Incident/Observation/body/digest/created/updated snapshot,
  pending status, NULL enqueued/error invariants, and server scope. A zero-row
  update is accepted only after an identical terminal state is re-read: PASS
- A malformed pending timestamp/state snapshot uses a separate exact raw
  snapshot/scope quarantine CAS, receives the same fixed blocked code, and
  does not starve a later valid row: PASS
- Malformed, noncanonical, digest-mismatched, and wrong-scope rows never enter
  Queue and converge to one fixed safe blocked code: PASS
- Consumer requires the expected batch Queue and exact pending/enqueued local
  outbox. Incident identity and source FAIL Observation material must match
  before marker lookup or provider call: PASS
- Fabricated same-scope, staging, changed-state/evidence, payload mismatch, and
  wrong-Queue messages cause no provider call, marker, or ACK: PASS
- Provider requires explicit enablement and env-only endpoint/token; rejects
  non-HTTPS, IP, localhost, userinfo, query, fragment, CRLF, and non-default
  port; posts canonical JSON with 5-second timeout and manual redirects: PASS
- Provider response body is never read or logged. Only status and a numeric
  Retry-After are retained: PASS
- 2xx records `http_2xx` before ACK; restart with the same Incident/digest ACKs
  without a provider call. Pre-#29 `http_200`–`http_299` markers remain
  readable during upgrade; Incident or digest marker conflict fails closed:
  PASS
- 429/5xx/timeout retry; 3xx/other 4xx/invalid/scope/outbox/idempotency conflict
  poison retry toward the dedicated DLQ: PASS
- Missing DB/site/environment/Queue/provider settings and wrong batch Queue
  explicitly retry the whole batch without provider, ACK, or per-message
  mutation: PASS
- Notification dispatch runs only after public producer persistence.
  Missing/failed Queue leaves pending while the already persisted scheduler
  heartbeat remains PASS: PASS
- Migration sequence remains `0000`–`0007`; the generated Sites Wrangler has
  no Queue binding and the checked-in plan says remote-unprovisioned /
  `NOT_RUN`: PASS

## STAGING_REMOTE

`NOT_RUN` — no staging Queue, DLQ, producer binding, consumer, provider
credential, endpoint, message, Retry-After, retry, or DLQ transition was
created, read, or exercised.

## PRODUCTION_REMOTE

`NOT_RUN` — no production Queue, DLQ, provider, notification destination,
credential, outbox, marker, or binding was read or changed.

## Rollback / rehearsal

No D1 migration exists for this Issue. Before remote enablement, revert the
Issue implementation commit and keep existing pending rows. After enablement,
disable `NOTIFICATION_PROVIDER_ENABLED`, remove/pause the consumer and producer
binding through the reviewed Cloudflare change process, and retain outbox,
delivery markers, and DLQ messages as audit/idempotency evidence. Do not delete
pending rows or replay a DLQ directly to the provider.

In staging, rehearse missing binding, send failure, CAS conflict, Worker
restart after provider 2xx and before ACK, marker write failure, 429 numeric
Retry-After, 503, timeout, redirect, 400, wrong Queue, wrong scope, payload
tamper, provider disablement, retry exhaustion, and DLQ inspection.

## Unresolved blockers

- Provision distinct staging and production Queue/DLQ resources and bind the
  producer and consumer. The Sites-generated package currently has no Queue
  binding by design.
- Select and review the provider HTTPS endpoint, destination ownership,
  credentials, data-processing terms, rate limits, and cost ceiling.
- Configure `NOTIFICATION_QUEUE_NAME`, the explicit provider enable flag,
  endpoint, and secret separately per environment.
- Complete staging failure injection and verify Cloudflare retry/DLQ behavior
  before production enablement.
- Add an out-of-band monitor for stale pending rows, DLQ depth, missing
  consumer execution, and notification delivery freshness.
