# Issue #14 evidence

## Scope

Deterministic, single-component classification for the two current CMS
failure-only signal types.

## RED

- Command: `npm run test:unit`
- Exit: `1`
- Expected failure: CMS route `/other` mapped to `public_delivery` instead of
  the isolated editorial component.
- The component-isolation matrix was present before the mapper change.

## GREEN

- Command: `npm run test:unit`
- Exit: `0`
- Result: 7 tests passed.
- The Issue test covers all four current runtime route classes, contact
  notification failure, misleading service names, and rejection of the
  business event `contact.received`.

## LOCAL

- `/api/contact` maps only to `contact_intake`: PASS
- `/img/:width/:object-key` maps only to `media_delivery`: PASS
- `/healthz` maps only to `deployment_integrity`: PASS
- `/other` maps provisionally only to `editorial`: PASS
- `contact.delivery_failure` maps only to `notification_delivery`: PASS
- No CMS failure signal creates a `public_delivery` Observation: PASS
- Service-name substrings do not influence classification: PASS
- Existing check IDs, reason codes, scope, and correlation IDs are preserved:
  PASS
- `npm run lint`: PASS, exit 0
- `npm run typecheck`: PASS, exit 0

## STAGING_REMOTE

`NOT_RUN` — no CMS staging signal was sent.

## PRODUCTION_REMOTE

`NOT_RUN` — no production signal was sent.

## Rollback / rehearsal

Revert this Issue's single commit. Existing append-only Observations are not
rewritten.

## Unresolved blockers

- CMS ops-signal v1 collapses editorial/CMS routes and unrelated paths into
  `/other`. A v2 route discriminator is required for exact editorial
  classification.
- CMS events are failure-only. Their absence cannot produce a healthy verdict.
- The mapper change must be deployed after the short request-replay window or
  with an explicit mapper version before replaying old `/other` identities.
