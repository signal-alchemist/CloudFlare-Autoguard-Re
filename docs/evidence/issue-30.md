# Issue #30 evidence

## Scope

Expose dependency-free liveness and owner-only readiness/canonical
operability reads, then server-render the read-only console from the same
sanitized D1 snapshot. The snapshot is fixed at eight components and four
operation gates, treats missing policy/evidence as UNKNOWN/DENY, and never
projects notification payloads, digests, correlation values, requester
identity, credentials, or raw provider content.

Issue #30 remains open under feature parent Issue #22. Its seven acceptance
perspectives are mirrored as `#30-T01` through `#30-T07` in
`docs/03-issue-commit-map.md`. No remote runtime result is inferred from local
tests.

## RED

- Command:
  `node --test tests/unit/operability-http.test.ts tests/unit/canonical-operability.test.ts`
- Exit: `1`
- Expected failures:
  `ERR_MODULE_NOT_FOUND lib/http/operability.ts` and
  `ERR_MODULE_NOT_FOUND lib/services/canonical-operability.ts`.
- The tests were written first for dependency-free liveness, owner
  authorization before D1, exact scope, generic readiness failure, fixed
  component/gate catalogs, policy gaps, read-only D1, and sanitized
  corruption handling.

## GREEN

- Targeted command:
  `node --test tests/unit/operability-http.test.ts tests/unit/canonical-operability.test.ts tests/unit/console-access.test.ts`
- Exit: `0`
- Result: 8 canonical snapshot, operability HTTP, HEAD parity, and console
  access tests passed.
- Command: `npm run typecheck`
- Exit: `0`.
- Command: `npm run test:unit`
- Exit: `0`.
- Result: all 52 unit tests passed.
- Command: `npm run validate`
- Exit: `0`.
- Result: lint, typecheck, all 52 unit tests, and the production build passed.
- Command: `npm run test:rendered`
- Exit: `0`.
- Result: the production build and all 5 isolated Worker/rendering tests
  passed, including native `cloudflare:workers` bindings with migrations
  `0000`–`0007` applied to a real Miniflare D1 binding.
- Command: `npm run test:release`
- Exit: `0`.
- Result: the production build and the private Sites release contract passed.

## Independent review regression

- Review required automatic HEAD stripping at the route/Worker boundary,
  authentication before any D1 read, 401 before 403 for unauthenticated
  cross-scope requests, and one canonical loader shared by `/ready`, the API,
  and the Server Component.
- Review also required a dedicated read-only D1 port; current Observation
  evaluation without verdict materialization; fixed eight-component and
  four-gate output; explicit component freshness/last observation/active
  Incident count; bounded Incident items; and explicit deployment identity
  and scheduler freshness states.
- Notification outbox payload/digest columns are not selected by the read
  model. Incident scope and raw reason, freeze reason, correlation values,
  provider output, request/receipt content, and deployment evidence digest
  are not projected.
- Missing policy (including the current staging policy gap) is a valid
  UNKNOWN/DENY snapshot with readiness `not_ready`; malformed matching rows
  and D1/schema errors remain generic `503`.
- Expired freeze history is filtered in SQL before the active-row bound, and
  more than 100 active Incidents returns a bounded list plus exact count and
  `truncated: true` instead of becoming permanently unavailable.
- Final review reproduced an extensionless server-model import that prevented
  direct Node verification, fixed it with explicit TypeScript module paths,
  and added an isolated native Worker/D1 regression. No remaining P1/P2
  finding was identified after the full validation pass.

## LOCAL

- `/live` performs no authentication, D1, R2, Queue, credential, policy, or
  scheduler check; GET and HEAD are `200`, other methods are `405` with
  `Allow: GET, HEAD`: PASS
- `/ready` and canonical operability authenticate the owner before snapshot
  loading. Unauthenticated cross-scope is `401`; authenticated mismatch is
  `403`; both perform zero D1 reads: PASS
- GET/HEAD status and headers match for liveness, readiness, canonical
  success, `401`, `403`, `404`, and `503`; every HEAD body is empty: PASS
- Unknown `/v1` routes return secured JSON `404`; canonical loader failures
  expose only generic `service_unavailable` or `not_ready`: PASS
- The current production policy configures only `public_delivery`; the other
  seven components are explicit `component_policy_missing` UNKNOWN and all
  four gates remain DENY: PASS
- Component rows include explicit freshness, last observation, and active
  Incident count. Scheduler uses `fresh_pass | fresh_unknown | stale |
  missing`; runtime identity uses `fresh | stale | missing`: PASS
- Real D1 fixtures exercise Incident, notification outbox/delivery,
  deployment identity, post-deploy request/receipt, freeze, and scheduler
  heartbeat. Canary PII/secret values do not appear in the canonical result:
  PASS
- Notification queries use sanitized aggregate metadata and never select
  `payload_json` or `payload_digest`: PASS
- Snapshot reads use a port with no `run` or `batch`; a spy throws on any
  mutation and D1 `total_changes()` remains identical before/after load: PASS
- Readiness is derived from the same snapshot and requires runtime
  scope/policy, actual console auth configuration, D1/schema reads, an R2
  read probe, every CMS credential group, Queue/provider configuration,
  scheduled manifest, and a fresh PASS scheduler heartbeat: PASS
- The built Worker was exercised with a native D1 binding. Canonical API,
  generic not-ready response, and Server Component HTML all used the same
  server-owned `dfconnect/production` scope; spoofed scope headers did not
  change the rendered environment: PASS
- No D1 migration was added: PASS

## STAGING_REMOTE

`NOT_RUN` — no staging Sites deployment, Access request, D1/R2 read, Queue
inspection, Cron heartbeat, or browser validation was performed.

## PRODUCTION_REMOTE

`NOT_RUN` — this implementation commit records no production runtime PASS.
Publishing the commit as a later owner-only Sites version does not by itself
prove or exercise the production D1/R2/Queue, credentials, notification
destination, Incident, freeze, scheduler heartbeat, or operational state.

## Rollback / rehearsal

No migration exists for this Issue. Roll back by reverting the single Issue
implementation commit; the previous console remains static and existing D1
records remain untouched. Keep `/live` outside load-balancer automation until
the deployed path and Access boundary have been verified, because process
liveness alone does not prove D1/R2/Queue/scheduler readiness.

In staging, rehearse missing/mis-scoped D1, missing table/column, malformed
matching rows, missing R2, Queue/provider disablement, invalid Access issuer
and audience, unauthenticated/authenticated cross-scope reads, stale/missing/
UNKNOWN scheduler heartbeat, more than 100 active Incidents, expired freeze
history, SSR D1 failure, and every HEAD response class before production.

## Unresolved blockers

- Provision and bind distinct staging/production private R2 resources. The
  current Sites configuration has `r2: null`, so remote readiness must remain
  `not_ready`.
- Provision distinct staging/production Queue/DLQ and reviewed notification
  provider configuration; current generated Sites bindings remain absent.
- Configure production Cloudflare Access issuer/audience and every CMS
  credential group without placing secrets in the repository.
- Run migrations `0000`–`0007` against the isolated remote D1 bindings and
  capture staging failure-injection evidence before production.
- Add an out-of-band monitor for an unreachable Guard, since `/ready` cannot
  notify when the Worker itself is down.
