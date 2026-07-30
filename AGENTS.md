# AGENTS.md

## Mission

CloudFlare-Guard is the independent operational control plane for the
DFConnect CloudFlare-CMS. It observes delivery, editorial, contact, media,
notification, deployment, recovery, and its own readiness without sitting in
the public request path.

## Read before editing

1. `docs/01-requirements.md`
2. `docs/02-basic-design.md`
3. `docs/03-issue-commit-map.md`

## Delivery rules

- Create one feature parent Issue before its test child Issues.
- Each child Issue contains exactly one test perspective.
- Use Red -> Green TDD and exactly one implementation commit per child Issue.
- Reference the child with `Refs #N`; never use `Fixes` or `Closes`.
- Leave parent and child Issues open.
- Record LOCAL, STAGING_REMOTE, and PRODUCTION_REMOTE separately.
- Never represent a local mock or checked-in resource name as remote evidence.

## Safety boundaries

- Do not place Guard in the public site request path.
- Do not share D1, R2, Queue/DLQ, credentials, or notification paths with CMS.
- Do not store CMS content, Growth metrics, contact PII, raw queries, cookies,
  authorization headers, tokens, webhooks, or unrestricted provider responses.
- Do not provide an arbitrary URL probe.
- Treat missing, stale, invalid, unknown, or unreachable required signals as
  `unknown`; do not extend the last healthy result.
- Do not give AI identities unfreeze, override, rollback, restore, or Cloudflare
  write permissions.
- Do not implement automatic DNS/WAF changes, D1 restore, R2 deletion, secret
  rotation, or unapproved rollback.

## Required local gates

```bash
npm run lint
npm run test:unit
npm run build
```

