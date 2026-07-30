import assert from "node:assert/strict";
import test from "node:test";

import {
  ContractError,
  signHmacSha256,
  stableJson,
  type ReplayStore,
  verifyCmsOpsSignalRequest,
} from "../../lib/contracts/ops-signal.ts";

const now = Date.parse("2026-07-31T00:01:00.000Z");
const credential = {
  credentialId: "cms-staging-v1",
  token: "staging-service-token-0123456789",
  signingSecret: "staging-signing-secret-0123456789",
  siteId: "dfconnect",
  environment: "staging" as const,
  maxAgeSeconds: 120,
  maxFutureSkewSeconds: 30,
  validForSeconds: 180,
};

function body(environment: "staging" | "production" = "staging") {
  return {
    schema: "autoguard-ops-signal-envelope-v1",
    environment,
    sentAt: "2026-07-31T00:00:00.000Z",
    signal: {
      schema: "ops-signal-v1",
      event: "worker.runtime_failure",
      schemaVersion: 1,
      fingerprint: "a".repeat(64),
      severity: "error",
      environment,
      service: `dfconnect-site-${environment}`,
      occurredAt: "2026-07-31T00:00:00.000Z",
      status: 500,
      method: "GET",
      route: "/healthz",
      exceptionName: "TypeError",
      message: "Unhandled Worker exception",
      requestId: "request_123",
    },
  };
}

class MemoryReplayStore implements ReplayStore {
  readonly claimed = new Set<string>();

  async claim(key: string): Promise<boolean> {
    if (this.claimed.has(key)) return false;
    this.claimed.add(key);
    return true;
  }
}

async function signedRequest(
  payload = body(),
  overrides: Partial<{
    authorization: string;
    signature: string;
    rawBody: Uint8Array<ArrayBuffer>;
  }> = {},
) {
  const rawBody =
    overrides.rawBody ?? new TextEncoder().encode(stableJson(payload));
  return {
    rawBody,
    authorization:
      overrides.authorization ?? `Bearer ${credential.token}`,
    signature:
      overrides.signature ??
      (await signHmacSha256(rawBody, credential.signingSecret)),
  };
}

async function expectCode(
  action: () => Promise<unknown>,
  code: string,
): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof ContractError);
    assert.equal(error.code, code);
    return true;
  });
}

test("accepts a canonical signed request bound to its server-owned scope", async () => {
  const verified = await verifyCmsOpsSignalRequest({
    ...(await signedRequest()),
    now,
    credentials: [credential],
    replayStore: new MemoryReplayStore(),
  });

  assert.equal(verified.credentialId, "cms-staging-v1");
  assert.equal(verified.observation.siteId, "dfconnect");
  assert.equal(verified.observation.environment, "staging");
});

test("rejects invalid auth, signature, scope, freshness, canonical JSON, and replay", async () => {
  await expectCode(
    async () =>
      verifyCmsOpsSignalRequest({
        ...(await signedRequest(body(), {
          authorization: "Bearer wrong-service-token-0123456789",
        })),
        now,
        credentials: [credential],
        replayStore: new MemoryReplayStore(),
      }),
    "ops_auth_invalid",
  );

  await expectCode(
    async () =>
      verifyCmsOpsSignalRequest({
        ...(await signedRequest(body(), {
          signature: `hmac-sha256:${"0".repeat(64)}`,
        })),
        now,
        credentials: [credential],
        replayStore: new MemoryReplayStore(),
      }),
    "ops_signature_invalid",
  );

  const production = body("production");
  await expectCode(
    async () =>
      verifyCmsOpsSignalRequest({
        ...(await signedRequest(production)),
        now,
        credentials: [credential],
        replayStore: new MemoryReplayStore(),
      }),
    "ops_scope_invalid",
  );

  await expectCode(
    async () =>
      verifyCmsOpsSignalRequest({
        ...(await signedRequest()),
        now: now + 121_000,
        credentials: [credential],
        replayStore: new MemoryReplayStore(),
      }),
    "ops_envelope_stale",
  );

  const prettyBody = JSON.stringify(body(), null, 2);
  await expectCode(
    async () =>
      verifyCmsOpsSignalRequest({
        ...(await signedRequest(body(), {
          rawBody: new TextEncoder().encode(prettyBody),
        })),
        now,
        credentials: [credential],
        replayStore: new MemoryReplayStore(),
      }),
    "ops_body_noncanonical",
  );

  const invalidUtf8 = Uint8Array.from([0xff, 0xfe, 0xfd]);
  await expectCode(
    async () =>
      verifyCmsOpsSignalRequest({
        ...(await signedRequest(body(), { rawBody: invalidUtf8 })),
        now,
        credentials: [credential],
        replayStore: new MemoryReplayStore(),
      }),
    "ops_body_invalid_utf8",
  );

  const duplicateCredential = {
    ...credential,
    credentialId: "cms-staging-duplicate",
  };
  await expectCode(
    async () =>
      verifyCmsOpsSignalRequest({
        ...(await signedRequest()),
        now,
        credentials: [credential, duplicateCredential],
        replayStore: new MemoryReplayStore(),
      }),
    "ops_credential_duplicate",
  );

  const replayStore = new MemoryReplayStore();
  const request = await signedRequest();
  const first = await verifyCmsOpsSignalRequest({
    ...request,
    now,
    credentials: [credential],
    replayStore,
  });
  await expectCode(
    () =>
      verifyCmsOpsSignalRequest({
        ...request,
        now,
        credentials: [credential],
        replayStore,
      }),
    "ops_replay_detected",
  );

  const freshRetryPayload = {
    ...body(),
    sentAt: "2026-07-31T00:00:01.000Z",
  };
  const retry = await verifyCmsOpsSignalRequest({
    ...(await signedRequest(freshRetryPayload)),
    now,
    credentials: [credential],
    replayStore,
  });
  assert.equal(
    retry.observation.idempotencyKey,
    first.observation.idempotencyKey,
  );
});
