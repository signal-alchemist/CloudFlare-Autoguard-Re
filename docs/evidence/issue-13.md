# Issue #13 evidence

## Scope

Allowlist-first sanitization for adapter evidence, notifications, structured
logs, and Incident API projections.

## RED

- Command: `npm run test:unit`
- Exit: `1`
- Expected failure: `lib/security/safe-output.ts` did not exist.
- The PII/secret/provider/query canary test was present before implementation.

## GREEN

- Command: `npm run test:unit`
- Exit: `0`
- Result: 10 tests passed.
- The Issue test seeds unique canaries for Cookie, Authorization, Turnstile,
  webhook, contact name/email/body/IP, raw query, account/resource IDs, raw
  provider response, and thrown error text; every resulting projection contains
  zero canaries.

## LOCAL

- Standard SHA-256 `abc` vector: PASS
- Evidence is constructed from fixed fields without cloning raw input: PASS
- Raw body becomes digest only: PASS
- Content type is reduced to validated media type: PASS
- Redirect is exact reviewed origin and path without query: PASS
- Raw/disallowed headers and provider fields are absent: PASS
- Invalid schema, query, credential-like safe field, and thrown getter fail to
  fixed `unknown`/null evidence without error text: PASS
- Safe notification parser rejects expanded fields: PASS
- Incident API exposes evidence ID only, not a storage/provider URL: PASS
- `npm run lint`: PASS, exit 0
- `npm run typecheck`: PASS, exit 0

## STAGING_REMOTE

`NOT_RUN` — no staging adapter, notification provider, or log sink was used.

## PRODUCTION_REMOTE

`NOT_RUN` — no production evidence or PII was read.

## Rollback / rehearsal

Revert this Issue's single commit. It has no migration or remote mutation.

## Unresolved blockers

- Provider-specific safe metadata allowlists require review when each adapter
  is provisioned.
- Log sink and R2 retention controls require remote validation.
- Notification delivery/retry semantics are implemented separately in #12.
