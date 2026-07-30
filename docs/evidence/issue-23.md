# Issue #23 evidence

## Scope

Signed CMS signal HTTP ingress for canonical
`POST /v1/signals/cms` and current-CMS-compatible
`POST /compat/v1/gate`, while preserving the existing
`GET /compat/v1/gate` handler.

## RED

- Command: `node --test tests/unit/cms-signal-http.test.ts`
- Exit: `1`
- Expected failure:
  `ERR_MODULE_NOT_FOUND lib/http/cms-signal.ts`
- The HTTP route, status, compatibility dispatch, and real migration-backed D1
  assertions were present before the ingress implementation.

## GREEN

- Command: `node --test tests/unit/cms-signal-http.test.ts`
- Exit: `0`
- Result: 2 tests passed.
- The Issue tests send exact signed request bytes through both POST paths,
  preserve GET Gate dispatch, and inspect the migrated SQLite tables.

## LOCAL

- Canonical POST and compatibility POST use the same signal handler: PASS
- Existing compatibility GET dispatches to the Gate handler: PASS
- Exact-body HMAC, Bearer, freshness, site/environment, and replay checks:
  PASS
- Accepted Observation plus one receipt and one audit record: PASS
- Fresh retry dedupes the Observation while retaining a separate replay claim:
  PASS
- Missing credential/binding and D1 write failure return generic `503`: PASS
- Auth/signature `401`, scope `403`, replay `409`, malformed `400`, oversized
  `413`, and content type `415`: PASS
- Response bodies do not expose credential or D1 exception details: PASS
- `npm run lint`: PASS, exit 0
- `npm run typecheck`: PASS, exit 0
- `npm run test:unit`: PASS, 17 tests
- `npm run build`: PASS, exit 0

## STAGING_REMOTE

`NOT_RUN` — no staging Guard D1 binding, signal credential, or CMS Queue sender
was provisioned or mutated.

## PRODUCTION_REMOTE

`NOT_RUN` — the owner-only Console deployment has no production CMS signal
secret, and no production Observation was submitted.

## Rollback / rehearsal

Revert this Issue's single implementation commit to remove both POST routes.
The additive D1 schema predates this Issue and should not be removed. Before
remote enablement, send a signed staging failure signal, confirm the sanitized
Observation/receipt/audit rows, retry with a fresh `sentAt`, and confirm the
duplicate response without another Observation.

## Unresolved blockers

- Staging and production need separate real D1 resources and CMS credentials.
- Current CMS has one endpoint and credential pair for both Signal and Gate.
  The handler supports that migration state, while dedicated
  `CMS_SIGNAL_*` credentials require a later CMS configuration split.
- Replay claim and Observation persistence are separate D1 operations. A D1
  failure after a successful claim returns `503`; the current CMS recreates
  `sentAt` on Queue retry, allowing a fresh signed retry, but cross-operation
  atomicity remains future hardening.
