# Issue #12 evidence

## Scope

Safe notification provider delivery, post-2xx durable marker, Queue ACK/retry
ordering, bounded backoff, and planned Cloudflare DLQ configuration.

## RED

- Command: `npm run test:unit`
- Exit: `1`
- Expected failure: `lib/adapters/notification-delivery.ts` did not exist.
- The delivery ordering, restart, retry, poison, batch, and DLQ-plan test was
  present before implementation.

## GREEN

- Command: `npm run test:unit`
- Exit: `0`
- Result: 11 tests passed.
- The Issue test covers provider 204, marker persistence, ACK-loss replay,
  marker-write failure, 429, 503, network exception, permanent 400, malformed
  envelope, payload conflict, attempts 1–4, mixed batch, D1 restart, and
  queue/DLQ configuration.

## LOCAL

- Exact safe canonical body and provider idempotency key: PASS
- Provider 2xx -> D1 marker -> Queue ACK ordering: PASS
- Existing same key/digest skips provider and ACKs: PASS
- Same key/different digest retries toward DLQ without provider call: PASS
- Marker failure after 2xx does not ACK: PASS
- 429 Retry-After and exponential retry are clamped to 1–300 seconds: PASS
- 5xx/network and poison messages remain unacknowledged and request retry:
  PASS
- Messages are processed individually; a successful sibling remains ACKed:
  PASS
- Marker stores only key, Incident, digest, provider code, time, correlation:
  PASS
- Planned queue uses `max_retries: 3` and a distinct non-empty DLQ: PASS
- `npm run lint`: PASS, exit 0
- `npm run typecheck`: PASS, exit 0

## STAGING_REMOTE

`NOT_RUN` — the Queue, consumer, DLQ, provider endpoint, and service credential
are not provisioned.

## PRODUCTION_REMOTE

`NOT_RUN` — no production provider request or Queue message was sent.

## Rollback / rehearsal

Revert this Issue's single commit before applying its additive migration or
provisioning the planned Queue. After remote delivery begins, retain marker
rows until the retention owner approves cleanup.

## Unresolved blockers

- Cloudflare Queue/DLQ names in the checked-in file are a plan, not proof of
  remote resources.
- Provider endpoint, token, timeout budget, and on-call target require owner
  configuration.
- The guarantee is at-least-once delivery with durable post-2xx deduplication,
  not exactly-once. A crash between provider 2xx and marker write can resend;
  provider-side idempotency support is required to narrow that window.
- Remote fourth-attempt movement to the DLQ remains a staging acceptance test.
