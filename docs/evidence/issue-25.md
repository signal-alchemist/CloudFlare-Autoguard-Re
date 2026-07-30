# Issue #25 evidence

## Scope

D1-backed server-owned CMS runtime identity and exact post-deploy comparison
of `commitSha`, `workerVersionId`, and `evidenceDigest` before a fresh live
`siteDeploy` Gate may create an allow receipt.

## RED

- Command:
  `node --test tests/unit/post-deploy-runtime-identity.test.ts`
- Exit: `1`
- Expected failure:
  `ERR_MODULE_NOT_FOUND lib/repositories/deployment-runtime-identities.ts`
- D1 append/latest, exact triple, freshness, HTTP status, restart reason, and
  privacy assertions existed before the implementation.

## GREEN

- Command:
  `node --test tests/unit/post-deploy-runtime-identity.test.ts`
- Exit: `0`
- Result: 2 tests passed.
- Command: `npm run validate`
- Exit: `0`
- Result: lint, typecheck, 20 unit tests, and production build passed.
- Command: `npm run test:rendered`
- Exit: `0`
- Result: 3 rendered Worker/HTML tests passed.
- Command: `npm run test:release`
- Exit: `0`
- Result: release archive contract passed with migrations `0000`–`0005`.

## LOCAL

- Runtime identity is append-only and latest scope read is deterministic: PASS
- Identity is tied to an existing source Observation by D1 foreign key: PASS
- Fixed `deployment-runtime-identity-v1` policy only: PASS
- Maximum 300-second lifetime and 30-second future skew: PASS
- Digit-leading real Worker version identifiers are accepted: PASS
- Exact fresh triple plus fresh live `siteDeploy` Gate is the only PASS path:
  PASS
- Allow receipt freshness is bounded by both identity and Gate freshness: PASS
- Missing, stale, future, commit mismatch, version mismatch, and evidence
  mismatch remain UNKNOWN with no allow receipt: PASS
- HTTP mismatch response omits all server-owned identity values: PASS
- Repository recreation returns the original mismatch reason without another
  checker call and still has zero receipts: PASS
- Auth `401`, scope `403`, idempotency conflict `409`, malformed request `400`:
  PASS
- Identity, operational-state, claim, completion, and internal failures use a
  generic `503` without D1 or secret details: PASS
- Missing D1 binding or invalid server credential configuration fails before
  post-deploy processing: PASS by Worker wiring
- No Sites saved-version or environment value is used as CMS runtime identity:
  PASS by dependency boundary

## STAGING_REMOTE

`NOT_RUN` — migration `0005`, independent runtime identity Observation/writer,
real Worker version, CMS credential, and staging post-deploy request were not
provisioned.

## PRODUCTION_REMOTE

`NOT_RUN` — no production D1 identity row or post-deploy request was read or
written. The owner-only Sites release remains a Guard console deployment and
is not CMS runtime evidence.

## Rollback / rehearsal

Revert this Issue's single implementation commit before applying migration
`0005`. After remote migration, keep the additive identity table for audit
retention and stop reads/writes during application rollback rather than
dropping evidence. Rehearse exact match, each one-field mismatch, stale
identity, identity D1 outage, and retry after an UNKNOWN result in staging.

## Unresolved blockers

- A separate independent probe/provider producer must append the source
  Observation and complete identity row; the signed post-deploy caller cannot
  write its own expected identity.
- Current CMS uses `site-<SHA prefix>` instead of the actual Cloudflare Worker
  version ID, so remote comparison remains UNKNOWN until the workflow captures
  the provider-returned version.
- Current CMS rolls back on any non-2xx post-deploy response. It must poll
  UNKNOWN within the five-minute budget and reserve rollback for confirmed
  failure.
- Production and staging need separate D1 resources and stable probe
  configuration. Dynamic identity must not be copied into Sites environment
  variables because applying an environment revision requires another Guard
  deployment and would create a trust/deployment cycle.
