# Issue #11 evidence

## Scope

Exact current CMS Gate compatibility response, canonical HMAC-SHA256 signing,
Bearer-protected no-store HTTP handler, and fail-closed route wiring.

## RED

- Command: `npm run test:unit`
- Exit: `1`
- Expected failure: the operational Gate compatibility contract did not exist.
- The exact-field, fixed-vector, tamper, authentication, and handler-failure
  test was present before implementation.

## GREEN

- Command: `npm run test:unit`
- Exit: `0`
- Result: 12 tests passed.
- The Issue test matches the current CMS canonical body and frozen signature,
  rejects field/timestamp/tamper variants, denies unauthorized requests, and
  returns a signed deny/deny projection when its source fails.

## LOCAL

- Exact top-level fields and exact two nested Gate fields: PASS
- Epoch-second safe integers and positive bounded freshness: PASS
- Recursive key-sort canonical JSON: PASS
- Frozen HMAC vector
  `hmac-sha256:41cab53d023bfa2267ca6357e05627c30bfe635766fbbee9e6a56471ff6da2c8`:
  PASS
- Web Crypto HMAC verification rejects all tested tampering: PASS
- Web Crypto bearer comparison and exact Bearer syntax: PASS
- `GET /compat/v1/gate` uses JSON and `Cache-Control: no-store`: PASS
- Missing environment configuration returns 503; projection failure signs
  deny/deny: PASS
- No canonical-only reason/component/Incident fields are added to compat v1:
  PASS
- `npm run lint`: PASS, exit 0
- `npm run typecheck`: PASS, exit 0

## STAGING_REMOTE

`NOT_RUN` — no CMS staging service token, signing secret, or Guard endpoint was
configured.

## PRODUCTION_REMOTE

`NOT_RUN` — no production Gate request was made.

## Rollback / rehearsal

Revert this Issue's single commit and remove the route binding before exposing
an endpoint. There is no migration or remote mutation.

## Unresolved blockers

- The route intentionally returns deny/deny until #19 supplies evaluated
  component state.
- Current CMS consumer compares signature strings directly and does not reject
  unknown response fields; consumer hardening remains a separate CMS change.
- The compatibility endpoint is aggregate-only because current CMS does not
  send an OperationContext. Canonical operation evaluation remains separate.
- Service token, signing secret, Access policy, rate limit, and environment
  variables require remote provisioning.
