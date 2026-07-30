# Issue #26 evidence

## Scope

Cloudflare Worker scheduled producer for the checked-in DFConnect production
public-delivery manifest. The producer records capability-aware public
Observations and writes a narrow scheduler/D1 heartbeat only after every
target Observation is durable.

The independent `/healthz` deployment identity writer required by Issue #25 is
not part of this Issue.

## RED

- Command:
  `node --test tests/unit/scheduled-public-delivery.test.ts`
- Exit: `1`
- Expected failure:
  `ERR_MODULE_NOT_FOUND lib/adapters/cloudflare-worker-public-delivery.ts`
- Worker transport capability, fail/unknown precedence, reviewed-target-only
  scheduling, concurrency, D1 idempotency, heartbeat order, failure behavior,
  privacy, and audit provenance assertions existed before implementation.

## GREEN

- Command:
  `node --test tests/unit/scheduled-public-delivery.test.ts`
- Exit: `0`
- Result: 4 tests passed.
- Command:
  `npm run validate`
- Exit: `0`
- Result: lint, typecheck, 24 unit tests, and production build passed.
- Command:
  `npm run test:rendered`
- Exit: `0`
- Result: 3 rendered Worker/HTML tests passed.
- Command:
  `npm run test:release`
- Exit: `0`
- Result: release contract passed and generated Wrangler configuration retained
  the one-minute Cron, `nodejs_compat`, and `DB` binding.

## LOCAL

- The scheduled service imports and strict-compiles only
  `dfconnect.production.ts`; caller input cannot add a URL or check: PASS
- Exact checked-in site/environment and exact configured Cron are required:
  PASS
- Nine manifest checks run with a maximum concurrency of four: PASS
- A/AAAA answers and minimum TTL use `node:dns` and are memoized per hostname
  for one scheduled cycle: PASS
- Worker fetch uses manual redirects, no-store, omitted credentials, a bounded
  body, timeout signal, and response-header allowlist: PASS
- Worker fetch never invents connected IP, TLS authorization, protocol,
  certificate lifetime, or SNI evidence: PASS
- A fully matching HTTP response remains UNKNOWN when peer/TLS attestation is
  unavailable: PASS
- Explicit status, content type, required header, marker, canonical, DNS
  non-global, and off-origin redirect failures remain FAIL: PASS
- Timeout, network failure, 403, 429, 5xx, oversized body, decode failure, and
  unavailable evidence remain UNKNOWN: PASS
- Same `site/environment/scheduledTime/checkId` is restart-safe and does not
  add another Observation, receipt, audit, or network exchange: PASS
- Scheduler heartbeat is inserted after all target writes and only then may be
  PASS: PASS
- Configuration or target D1 write failure leaves no PASS heartbeat; an
  UNKNOWN self Observation is persisted when D1 remains writable: PASS
- A completely missing D1 binding throws from the default scheduled handler;
  it cannot falsely persist or report a heartbeat: PASS by Worker wiring
- Scheduled audit rows use `scheduled-public-producer` and
  `dfconnect-public-delivery-v1`, not the CMS ingest actor: PASS
- Observation/audit rows do not contain body markers, Cookie, connected IP,
  raw redirect URL, or private response headers: PASS
- The default Worker exports and awaits `scheduled()`: PASS
- Generated Worker configuration contains `* * * * *`,
  `nodejs_compat`, and `DB`: PASS

## STAGING_REMOTE

`NOT_RUN` — no staging D1, Cron trigger, DNS result, public fetch, scheduled
failure injection, or heartbeat freshness was observed remotely.

## PRODUCTION_REMOTE

`NOT_RUN` — no production target request or D1 write was made. A checked-in
Cron is not evidence that the deployed Sites Worker retained or fired the
trigger.

## Rollback / rehearsal

Revert this Issue's single implementation commit to remove the scheduled
handler and Cron. No migration was added. Existing append-only Observations
remain audit evidence and should not be deleted during application rollback.

Before production enablement, rehearse wrong site/environment, stale or
duplicate scheduled time, DNS unavailable/non-global, timeout, off-origin
redirect, 429/5xx, marker mismatch, partial D1 failure, full D1 outage, Cron
silence, and recovery on the next minute tick.

## Unresolved blockers

- The Sites saved version must be redeployed and the active Cloudflare Cron
  trigger inspected after its propagation window.
- Production and staging need separate real D1 bindings and environment scope.
- An external monitor outside this Worker must alert when the newest scheduler
  heartbeat is stale or absent, including complete D1/Worker failure.
- Production public delivery still requires an `external_probe` source; this
  Worker source alone cannot satisfy the two-source operational policy.
- Issue #25 still requires a separate signed independent `/healthz` plus
  Cloudflare read-only runtime identity producer. The scheduled producer does
  not append `deployment_runtime_identities`.
