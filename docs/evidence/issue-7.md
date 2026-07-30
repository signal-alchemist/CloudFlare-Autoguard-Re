# Issue #7 evidence

## Scope

HMAC signature, bearer credential scope, canonical body, freshness, and replay
rejection for CMS ops signal v1.

## RED

- Command: `npm run test:unit`
- Exit: `1`
- Expected failure: `signHmacSha256` and request verification exports did not
  exist.
- The security test was present before the implementation.

## GREEN

- Command: `npm run test:unit`
- Exit: `0`
- Result: 4 tests passed.
- Covered valid request plus invalid bearer, signature, environment scope,
  sentAt window, non-canonical JSON, and replay.

## LOCAL

- Exact request-byte Web Crypto HMAC-SHA256 sign/verify: PASS
- Native Web Crypto HMAC challenge/verify bearer comparison: PASS
- Server-owned site/environment binding: PASS
- Strict canonical JSON: PASS
- Fatal UTF-8 decode and duplicate credential rejection: PASS
- Captured-request replay key is separate from Observation idempotency: PASS
- `npm run lint`: PASS, exit 0
- `npm run build`: PASS, exit 0

## STAGING_REMOTE

`NOT_RUN` — staging service token, secret, endpoint, and durable replay store
were not provisioned for this Issue.

## PRODUCTION_REMOTE

`NOT_RUN` — no production credential or signal was used.

## Rollback / rehearsal

Revert this Issue's single commit. It contains no migration and no remote
resource mutation.

## Unresolved blockers

- The replay port is intentionally storage-neutral; durable D1 behavior is #10.
- Full project typecheck is blocked by starter Cloudflare binding declarations
  and is handled with repository infrastructure in #10.
