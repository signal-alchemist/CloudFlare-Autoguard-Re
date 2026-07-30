import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalOperationalGatePayload,
  signOperationalGateCompat,
  verifyOperationalGateCompat,
  type UnsignedOperationalGateCompat,
} from "../../lib/contracts/operational-gate-compat.ts";
import { handleCompatGateRequest } from "../../lib/http/compat-gate.ts";

const secret = "post-deploy-signing-secret-0123456789";
const unsigned: UnsignedOperationalGateCompat = {
  siteId: "dfconnect",
  environment: "production",
  gates: {
    contentPublish: "allow",
    siteDeploy: "allow",
  },
  checkedAt: 1_785_427_200,
  freshUntil: 1_785_427_380,
  freeze: false,
};

test("CMS Gate compat keeps exact fields, epoch freshness, HMAC vector, and authenticated no-store HTTP", async () => {
  assert.equal(
    canonicalOperationalGatePayload(unsigned),
    '{"checkedAt":1785427200,"environment":"production","freeze":false,"freshUntil":1785427380,"gates":{"contentPublish":"allow","siteDeploy":"allow"},"siteId":"dfconnect"}',
  );
  const signed = await signOperationalGateCompat(unsigned, secret);
  assert.equal(
    signed.signature,
    "hmac-sha256:41cab53d023bfa2267ca6357e05627c30bfe635766fbbee9e6a56471ff6da2c8",
  );
  assert.deepEqual(Object.keys(signed).sort(), [
    "checkedAt",
    "environment",
    "freeze",
    "freshUntil",
    "gates",
    "signature",
    "siteId",
  ]);
  assert.deepEqual(Object.keys(signed.gates).sort(), [
    "contentPublish",
    "siteDeploy",
  ]);
  assert.equal(await verifyOperationalGateCompat(signed, secret), true);

  const tampered = [
    { ...signed, siteId: "another" },
    { ...signed, environment: "staging" as const },
    {
      ...signed,
      gates: { ...signed.gates, contentPublish: "deny" as const },
    },
    { ...signed, freshUntil: signed.freshUntil + 1 },
    { ...signed, freeze: true },
    { ...signed, extra: "canonical-only-field" },
  ];
  for (const candidate of tampered) {
    assert.equal(
      await verifyOperationalGateCompat(candidate, secret),
      false,
    );
  }
  assert.equal(
    await verifyOperationalGateCompat(
      { ...signed, freshUntil: signed.checkedAt },
      secret,
    ),
    false,
  );

  const serviceToken = "cms-gate-service-token-0123456789";
  const projection = {
    async read() {
      return unsigned;
    },
  };
  const unauthorized = await handleCompatGateRequest(
    new Request("https://guard.example/compat/v1/gate", {
      headers: { authorization: "Bearer wrong-token-value" },
    }),
    {
      siteId: "dfconnect",
      environment: "production",
      serviceToken,
      signingSecret: secret,
      clock: () => unsigned.checkedAt * 1_000,
    },
    projection,
  );
  assert.equal(unauthorized.status, 401);

  const response = await handleCompatGateRequest(
    new Request("https://guard.example/compat/v1/gate", {
      headers: { authorization: `Bearer ${serviceToken}` },
    }),
    {
      siteId: "dfconnect",
      environment: "production",
      serviceToken,
      signingSecret: secret,
      clock: () => unsigned.checkedAt * 1_000,
    },
    projection,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("content-type"), "application/json");
  const body = (await response.json()) as Record<string, unknown>;
  assert.deepEqual(body, signed);

  const failedProjection = await handleCompatGateRequest(
    new Request("https://guard.example/compat/v1/gate", {
      headers: { authorization: `Bearer ${serviceToken}` },
    }),
    {
      siteId: "dfconnect",
      environment: "production",
      serviceToken,
      signingSecret: secret,
      clock: () => unsigned.checkedAt * 1_000,
    },
    {
      async read() {
        throw new Error("provider secret must not escape");
      },
    },
  );
  assert.equal(failedProjection.status, 200);
  const denied = (await failedProjection.json()) as {
    gates: { contentPublish: string; siteDeploy: string };
    freeze: boolean;
  };
  assert.deepEqual(denied.gates, {
    contentPublish: "deny",
    siteDeploy: "deny",
  });
  assert.equal(denied.freeze, false);
  assert.doesNotMatch(
    JSON.stringify(denied),
    /provider secret must not escape/u,
  );
});
