# Issue #15 evidence

## Scope

Read-only console authentication, server-owned site/environment scope, safe
output projection, secret-header stripping, strict CSP nonce, and hardened
uncacheable responses.

## RED

- `node --test tests/unit/console-access.test.ts` first failed because
  `lib/http/console-access.ts` did not exist.
- The next RED required a per-request nonce and failed because the nonce
  functions were not exported.
- The scope-spoof RED failed while `Authorization` was still forwarded to the
  renderer.
- `npm run test:rendered` then failed because the integrated Worker response
  had no `private, no-store` or CSP headers.

## GREEN

- `npm run test:unit`: PASS, 15 tests.
- `npm run test:rendered`: PASS, 2 server/Worker integration tests after a
  production build.
- `npm run lint`: PASS.
- `npm run typecheck`: PASS.

## LOCAL

- A self-asserted Access/email/scope header set cannot authorize: PASS
- Exact server-owned site and environment scope is required: PASS
- Wrong site, environment, and audience are rejected: PASS
- RS256 Access JWT signature, issuer, audience, subject, and lifetime are
  verified against an injected JWKS fixture: PASS
- Malformed and signature-tampered JWTs are rejected: PASS
- Unknown/untrusted reason input maps to fixed generic copy and is not echoed:
  PASS
- Authorization, Cookie, Access JWT, and identity email are removed before
  app rendering: PASS
- The renderer receives only server-overwritten site/environment headers:
  PASS
- Production/staging snapshots are selected server-side; the client no longer
  receives both environment records: PASS
- Every server-rendered script has the same random CSP nonce as the response:
  PASS
- CSP has no `unsafe-inline` or `unsafe-eval`: PASS
- Cache, frame, referrer, MIME, permissions, and noindex headers are present:
  PASS
- Unauthorized Worker response is generic and contains no identity, scope,
  audience, or token canary: PASS

## STAGING_REMOTE

`NOT_RUN` — no staging Access application, audience, JWKS, direct-origin
bypass test, or scoped resource was used.

## PRODUCTION_REMOTE

`NOT_RUN` — no production Access application or user session was used.

## Rollback / rehearsal

Revert this Issue's single commit. Without this commit, do not expose the
console on a remotely reachable origin.

## Unresolved blockers

- Provision distinct production/staging Access applications and audiences,
  then verify the real issuer/JWKS path and direct-origin denial.
- `sites-private` is only a private hosting boundary for the owner preview. Its
  email header is not accepted as Cloudflare Access evidence and must not be
  counted as production Access validation.
- Live state adapters remain unprovisioned, so a successfully authenticated
  console still renders remote state as unknown and gates as deny.
