# Issue #21 evidence

## Scope

Opaque Sites project binding, deployable package inputs, owner-only access
policy, exact-source release preparation, and strict separation from
Cloudflare staging/production health evidence.

## RED

- Command: `npm run test:release`
- Exit: `1`
- Expected failure: `.openai/hosting.json` had no `project_id`.
- The release test existed before project creation and also required the
  vinext server entrypoint, all four D1 migrations, the social asset, and the
  fail-closed console authentication modes.

## GREEN

- Command: `npm run test:release`
- Exit: `0`
- Result: one release-package contract test passed after a production build.

## LOCAL

- The Sites project ID is copied unchanged into `.openai/hosting.json`: PASS
- D1 binding remains `DB`; no R2 binding or secret is stored in the file: PASS
- `dist/server/index.js`, Worker source, OG asset, and migrations 0000–0003
  exist: PASS
- Release package retains both Cloudflare Access and owner-only Sites auth
  modes, with missing configuration fail-closed: PASS
- Exact clean commit, source push, archive, saved version, and deployment are
  performed only after this Issue's single commit.

## SITES_PRIVATE

`DEPLOYMENT_NOT_RUN` at commit time.

The Sites control plane reports custom access with the current owner as the
sole allowed user and no allowed groups. Runtime values are stored in Sites,
not in the repository:

- `GUARD_SITE_ID=dfconnect`
- `GUARD_ENVIRONMENT=production`
- `CONSOLE_AUTH_MODE=sites-private`
- `CONSOLE_ACCESS_AUDIENCE=sites-owner-only-console`

The exact source/version/deployment result is recorded on the still-open
GitHub Issue after deployment because it can only exist after this commit.

## STAGING_REMOTE

`NOT_RUN` — no Cloudflare staging state adapter, Access audience, external
probe, Queue, provider, or notification rehearsal is connected.

## PRODUCTION_REMOTE

`NOT_RUN` — the private Sites deployment is a console delivery check only. It
does not prove production Cloudflare health and does not enable any Gate.

## Rollback / rehearsal

Do not deploy an unsaved or mismatched version. If a private deployment fails,
retain the prior version and report the Sites project/version/deployment IDs;
do not fall back to public/shared deployment.

## Unresolved blockers

- Cloudflare Access production/staging applications and direct-origin denial
  remain separate remote work.
- Live verdict storage/adapters, notification resources, and CMS secrets are
  intentionally unset, so Gate/post-deploy routes remain unavailable or
  deny/unknown.
- CMS must still supply an actual Worker version and distinguish unknown from
  rollback-triggering failure.
