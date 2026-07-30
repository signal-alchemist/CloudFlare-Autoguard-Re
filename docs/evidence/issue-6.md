# Issue #6 evidence

## Scope

Current CloudFlare-CMS ops signal v1 normal contract and conversion to one
sanitized Observation.

## RED

- Command: `npm run test:unit`
- Exit: `1`
- Expected failure:
  `ERR_MODULE_NOT_FOUND lib/contracts/ops-signal.ts`
- The contract test was present before the implementation.

## GREEN

- Command: `npm run test:unit`
- Exit: `0`
- Result: 2 tests passed.
- Covered runtime failure and contact delivery failure normal payloads.

## LOCAL

- Contract/schema: PASS
- Sanitized Observation conversion: PASS
- Requirements/basic design/Issue map: PRESENT
- `npm run lint`: PASS, exit 0
- `npm run build`: PASS, exit 0

## STAGING_REMOTE

`NOT_RUN` — no staging service identity, secret, endpoint, or D1 resource was
used by this Issue.

## PRODUCTION_REMOTE

`NOT_RUN` — no production resource or credential was used by this Issue.

## Rollback / rehearsal

Revert this Issue's single commit. No migration or remote resource mutation is
included.

## Unresolved blockers

- CMS v1 signature/scope/freshness/replay rejection is tracked by #7.
- D1 persistence and restart evidence is tracked by #10.
