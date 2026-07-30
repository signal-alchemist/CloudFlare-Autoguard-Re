# Issue #20 evidence

## Scope

Truthful read-only console rendering for the eight component verdicts, four
operation gates, incident/notification/deploy/readiness summaries, and explicit
local-versus-remote evidence labels.

## RED

- Command: `npm run test:rendered`
- Exit: `1`
- Expected failure: the starter page rendered `<html lang="en">` and had no
  Guard console contract.
- The rendered-page test was present before implementation and required
  Japanese document metadata, eight component cards, four gate rows,
  `REMOTE NOT RUN`, `UNKNOWN`, `DENY`, and removal of starter artifacts.

## GREEN

- Command: `npm run test:rendered`
- Exit: `0`
- Result: one server-rendered console contract test passed after a production
  build.

## LOCAL

- Eight required components render independently: PASS
- Four named operation gates render `DENY`: PASS
- Unknown remote state is never presented as healthy: PASS
- Local checks and remote checks use separate labels: PASS
- Incident, notification, deploy, and recovery-readiness regions render: PASS
- Production/staging view switch and explicit refresh are available: PASS
- No destructive operation is exposed from the console: PASS
- Starter preview, starter assets, and loading-skeleton dependency removed:
  PASS
- Generated social card exists at `public/og.png`: PASS
- `npm run lint`: PASS, exit 0
- `npm run typecheck`: PASS, exit 0

## STAGING_REMOTE

`NOT_RUN` — no staging Cloudflare resource, external probe, Queue, provider, or
deployed Guard state was read.

## PRODUCTION_REMOTE

`NOT_RUN` — production remains fail-closed and no production resource was
mutated.

## Rollback / rehearsal

Revert this Issue's single commit. The change is presentation-only and does not
alter migrations, Worker decisions, or remote resources.

## Generated asset provenance

- Tool: built-in ImageGen, one request
- Output:
  `public/og.png`
- Prompt intent: dark-navy enterprise operations social card, abstract
  four-cell cyan guard, sparse monitoring grid, amber caution accent, no text,
  logos, people, screenshots, or watermark.

## Unresolved blockers

- Live component values require the scheduler/materialized verdict source and
  scoped read API; until then the console intentionally renders unknown.
- Staging and production remote verification still require Access, bindings,
  queue/provider configuration, and external probe identities.
- Current CMS workflow does not supply an actual Worker version and still
  conflates `unknown` post-deploy results with rollback-triggering failures.
