# Issue #18 evidence

## Scope

Strict signed post-deploy request, exact deployment identity, durable D1 claim
and immutable success receipt, restart-safe idempotency, and fail-closed HTTP
route.

## RED

- Command: `npm run test:unit`
- Exit: `1`
- Expected failure: `lib/contracts/post-deploy.ts` did not exist.
- The fixed-vector, strict identity, persistence, duplicate, restart, and
  conflict test was present before implementation.

## GREEN

- Command: `npm run test:unit`
- Exit: `0`
- Result: 13 tests passed.
- The Issue test verifies the current CMS request/verdict vectors, rejects
  malformed identity/scope/time/signature, executes its checker once, returns
  the same stored receipt on duplicate and restart, and rejects a changed
  payload under the same request ID.

## LOCAL

- Exact nine-field request and exact ten-field signed allow response: PASS
- Request HMAC vector
  `hmac-sha256:f328168fcab751ff5de255aebd8d1c342a0abdd79ba3900948a2c4c0bbb1fa88`:
  PASS
- Verdict HMAC vector
  `hmac-sha256:389cd90fba061fa8188d43f04b8edc5386957698487c67cc49caf35f12875c2a`:
  PASS
- Exact 40-lowerhex SHA, Worker version, evidence digest, and request ID: PASS
- Exact raw-byte HMAC, canonical JSON, Bearer, server-owned scope, and
  requestedAt window: PASS
- D1 request claim and signed receipt survive close/reopen: PASS
- Duplicate request calls checker zero additional times: PASS
- Changed digest/SHA/version under the same request ID conflicts: PASS
- In-progress concurrent duplicate does not start a second checker: PASS
- Only `pass` creates the current CMS allow receipt; fail/unknown are
  non-success HTTP outcomes: PASS
- `npm run lint`: PASS, exit 0
- `npm run typecheck`: PASS, exit 0

## STAGING_REMOTE

`NOT_RUN` — no staging deployment, actual Worker version, service token,
signing secret, or remote D1 binding was used.

## PRODUCTION_REMOTE

`NOT_RUN` — no production post-deploy request was accepted.

## Rollback / rehearsal

Revert this Issue's single commit before applying its additive migration.
After remote use, keep request/receipt rows for audit retention instead of
dropping them during application rollback.

## Unresolved blockers

- The wired checker intentionally returns `unknown` until #19 connects the
  required component policy.
- Current CMS workflow omits the real Cloudflare Worker version and sends a
  SHA-derived synthetic value; remote exact-version acceptance is blocked.
- Current CMS workflow automatically rolls back whenever the post-deploy step
  fails, including Guard `unknown`. This contradicts the required
  fail-versus-unknown behavior and needs a classified CMS workflow output
  before remote acceptance.
- A claimed request left in progress by a crash needs an operator-owned lease
  recovery policy; it is not automatically re-run.
