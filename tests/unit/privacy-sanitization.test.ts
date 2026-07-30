import assert from "node:assert/strict";
import test from "node:test";

import {
  parseSafeNotificationEnvelope,
  sanitizeAdapterEvidence,
  sha256Hex,
  toSafeIncidentApi,
  toSafeLogFields,
  toSafeNotification,
} from "../../lib/security/safe-output.ts";

const canaries = {
  cookie: "CANARY_COOKIE_13",
  authorization: "CANARY_BEARER_13",
  turnstile: "CANARY_TURNSTILE_13",
  webhook: "CANARY_WEBHOOK_13",
  name: "CANARY_NAME_13",
  email: "canary13@example.invalid",
  contactBody: "CANARY_CONTACT_BODY_13",
  ip: "192.0.2.131",
  query: "CANARY_QUERY_13",
  account: "CANARY_ACCOUNT_13",
  resource: "CANARY_RESOURCE_13",
  provider: "CANARY_PROVIDER_RESPONSE_13",
  thrown: "CANARY_THROWN_ERROR_13",
};

const trustedContext = {
  siteId: "dfconnect",
  environment: "production",
  component: "public_delivery",
  checkId: "public.apex",
  evidenceId: "ev_0123456789abcdef0123456789abcdef",
  observedAt: "2026-07-31T04:00:00.000Z",
  adapterVersion: "public-probe-v1",
  reviewedOrigin: "https://dfconnect.jp",
};

const incidentProjection = {
  incidentId: "inc_0123456789abcdef0123456789abcdef",
  siteId: "dfconnect",
  environment: "production",
  component: "public_delivery",
  severity: "sev1",
  state: "open",
  reasonCode: "http_status_unexpected",
  scope: "https://dfconnect.jp/",
  evidenceId: "ev_0123456789abcdef0123456789abcdef",
  observedAt: "2026-07-31T04:00:00.000Z",
  correlationId: "probe-run-privacy-13",
};

test("allowlist-first evidence and projections never serialize PII, secrets, raw provider data, or queries", async () => {
  assert.equal(
    await sha256Hex(new TextEncoder().encode("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assert.notEqual(
    await sha256Hex(new TextEncoder().encode("abd")),
    await sha256Hex(new TextEncoder().encode("abc")),
  );

  const sanitized = await sanitizeAdapterEvidence(trustedContext, {
    statusCode: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      cookie: canaries.cookie,
      authorization: canaries.authorization,
      "set-cookie": canaries.cookie,
    },
    body: new TextEncoder().encode(
      `${canaries.contactBody}:${canaries.email}:${canaries.name}`,
    ),
    elapsedMs: 121,
    redirectUrl: "https://dfconnect.jp/pricing/",
    tls: { protocol: "TLSv1.3", daysRemaining: 72 },
    providerCode: "2xx",
    resourceVersion: "worker-v1",
    cookie: canaries.cookie,
    authorization: canaries.authorization,
    turnstileToken: canaries.turnstile,
    webhookUrl: canaries.webhook,
    contactName: canaries.name,
    contactEmail: canaries.email,
    contactBody: canaries.contactBody,
    clientIp: canaries.ip,
    rawQuery: canaries.query,
    accountId: canaries.account,
    resourceId: canaries.resource,
    providerResponse: canaries.provider,
  });
  assert.equal(sanitized.ok, true);
  if (!sanitized.ok) assert.fail("sanitization unexpectedly failed");
  assert.deepEqual(
    {
      statusCode: sanitized.evidence.statusCode,
      contentType: sanitized.evidence.contentType,
      latencyMs: sanitized.evidence.latencyMs,
      redirectPath: sanitized.evidence.redirectPath,
      tlsProtocol: sanitized.evidence.tlsProtocol,
      tlsDaysRemaining: sanitized.evidence.tlsDaysRemaining,
      providerCode: sanitized.evidence.providerCode,
      resourceVersion: sanitized.evidence.resourceVersion,
    },
    {
      statusCode: 200,
      contentType: "text/html",
      latencyMs: 121,
      redirectPath: "/pricing/",
      tlsProtocol: "TLSv1.3",
      tlsDaysRemaining: 72,
      providerCode: "2xx",
      resourceVersion: "worker-v1",
    },
  );
  assert.match(sanitized.evidence.bodySha256, /^[a-f0-9]{64}$/u);

  const notification = toSafeNotification(incidentProjection);
  const log = toSafeLogFields(incidentProjection);
  const api = toSafeIncidentApi(incidentProjection);
  const combined = JSON.stringify({
    evidence: sanitized.evidence,
    notification,
    log,
    api,
  });
  for (const value of Object.values(canaries)) {
    assert.ok(!combined.includes(value), `serialized canary: ${value}`);
  }
  assert.doesNotMatch(
    combined,
    /authorization|cookie|turnstile|webhook|contactBody|contactEmail|clientIp|rawQuery|accountId|resourceId|providerResponse/iu,
  );
  assert.equal(api.evidenceId, incidentProjection.evidenceId);
  assert.ok(!("evidenceUrl" in api));

  const throwingInput: Record<string, unknown> = {};
  Object.defineProperty(throwingInput, "statusCode", {
    enumerable: true,
    get() {
      throw new Error(canaries.thrown);
    },
  });
  const thrownResult = await sanitizeAdapterEvidence(
    trustedContext,
    throwingInput,
  );
  assert.deepEqual(thrownResult, {
    ok: false,
    observationStatus: "unknown",
    reasonCode: "evidence_sanitization_failed",
    evidence: null,
  });
  assert.ok(!JSON.stringify(thrownResult).includes(canaries.thrown));

  const rawQueryResult = await sanitizeAdapterEvidence(trustedContext, {
    statusCode: 302,
    headers: { "content-type": "text/html" },
    body: new Uint8Array(),
    elapsedMs: 10,
    redirectUrl: `https://dfconnect.jp/login?token=${canaries.query}`,
    tls: { protocol: "TLSv1.3", daysRemaining: 72 },
    providerCode: "3xx",
    resourceVersion: "worker-v1",
  });
  assert.equal(rawQueryResult.ok, false);
  assert.ok(!JSON.stringify(rawQueryResult).includes(canaries.query));

  const unsafeContext = await sanitizeAdapterEvidence(
    { ...trustedContext, checkId: canaries.email },
    {},
  );
  assert.equal(unsafeContext.ok, false);

  assert.throws(
    () =>
      parseSafeNotificationEnvelope({
        ...notification,
        email: canaries.email,
      }),
    /safe_notification_unknown_field/,
  );
});
