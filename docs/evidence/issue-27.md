# Issue #27 evidence

## Scope

Canonical CMS `maintenance-request-v1` ingress that atomically persists an
expiring active freeze, immutable signed receipt, and audit evidence. The
endpoint is activate-only and exposes no release, unfreeze, or override
authority.

## RED

- Command:
  `node --test tests/unit/maintenance-request.test.ts`
- Exit: `1`
- Expected failure:
  `ERR_MODULE_NOT_FOUND lib/contracts/maintenance-request.ts`
- The CMS canonical request/receipt vectors, credential fallback, HTTP status,
  real D1 atomicity/idempotency, active Gate freeze, expiry boundary, and
  activate-only assertions existed before implementation.

## GREEN

- Command:
  `node --test tests/unit/maintenance-request.test.ts`
- Exit: `0`
- Result: 3 tests passed.
- Command: `npm run validate`
- Exit: `0`
- Result: lint, typecheck, 27 unit tests, and production build passed.
- Command: `npm run test:rendered`
- Exit: `0`
- Result: 3 rendered Worker/HTML tests passed.
- Command: `npm run test:release`
- Exit: `0`
- Result: release contract passed with migrations `0000`–`0006` and the
  maintenance route/credential wiring retained in the Worker source.

## LOCAL

- CMS nine-field request uses the exact recursive-key-sort canonical JSON and
  exact raw-body HMAC vector: PASS
- Signed receipt has only the six CMS-compatible fields, fixed `accepted`
  status, and a verified HMAC vector: PASS
- Dedicated `CMS_MAINTENANCE_*` pair wins; only both undefined permit Gate pair
  fallback; either dedicated half missing fails closed: PASS
- Request age is at most 300 seconds, future skew is at most 30 seconds, and
  requested duration is at most 900 seconds: PASS
- Initial acceptance returns `202`; a restart-safe exact duplicate returns
  `200` with the byte-identical persisted signed receipt: PASS
- Same `requestId` with changed canonical material returns `409` and creates no
  additional freeze, link, receipt, or audit: PASS
- Request, freeze, link, receipt, and audit insert in one D1 batch; a dependent
  unique-key failure rolls the request back: PASS
- Active freeze sets both CMS-compatible Gates to `deny`; the half-open expiry
  boundary is inactive at exact `expiresAt`: PASS
- More than 1,024 retained but expired freeze rows remain auditable without
  tripping the bounded active-freeze read or permanently denying the Gate: PASS
- Malformed/noncanonical/freshness/expiry `400`, auth/signature `401`, scope
  `403`, oversized `413`, content type `415`, wrong method `405`, and internal
  `503` responses are distinguished without internal detail: PASS
- Responses are stable JSON with `no-store` and `nosniff`: PASS
- The repository has no release method and inserts `releasedAt` as `NULL`:
  PASS
- Migration `0006` is additive, repeatable, and uses restrictive foreign keys:
  PASS

## STAGING_REMOTE

`NOT_RUN` — no staging D1 migration, maintenance credential, CMS workflow
request, signed receipt, or remote Gate transition was exercised.

## PRODUCTION_REMOTE

`NOT_RUN` — no production freeze was requested or written. No AI, operator, or
CMS credential was changed.

## Rollback / rehearsal

Revert this Issue's single implementation commit before applying migration
`0006`. After applying the additive migration, stop routing new maintenance
requests during application rollback and retain request, freeze, receipt, and
audit rows. An already active freeze naturally becomes inactive at its signed
expiry; do not delete it or introduce an emergency AI unfreeze.

Before enablement, rehearse first request, immediate retry, Worker restart,
same-ID conflict, wrong scope, each dedicated credential half missing, Gate
fallback, D1 dependent-write failure, overlapping freezes, exact expiry, and
credential rotation after the request freshness window.

## Unresolved blockers

- Production and staging need separate D1 bindings and maintenance credentials.
- CMS `AUTOGUARD_MAINTENANCE_ENDPOINT` must point to the deployed canonical
  `/v1/maintenance-requests` route.
- The current CMS uses a shared Autoguard credential. Gate fallback supports
  migration, but dedicated maintenance credentials should be configured and
  withheld from AI, Growth, and read-only console runtimes.
- Remote D1 batch rollback behavior, receipt verification, Gate denial, and
  exact expiry require a staging rehearsal before operational use.
- Any future early human unfreeze requires a separate Issue, strong operator
  authentication, authorization policy, and append-only audit design.
