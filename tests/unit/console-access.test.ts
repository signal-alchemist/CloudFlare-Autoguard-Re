import assert from "node:assert/strict";
import test from "node:test";
import {
  applyConsoleSecurityHeaders,
  authorizeConsoleRequest,
  consoleAccessErrorResponse,
  createConsoleCspNonce,
  prepareConsoleHtmlRequest,
  verifyCloudflareAccessRequest,
} from "../../lib/http/console-access.ts";
import { resolveConsoleReason } from "../../lib/ui/console-copy.ts";

const productionPolicy = {
  siteId: "dfconnect",
  environment: "production" as const,
  accessAudience: "guard-production-audience",
};

function base64Url(value: Uint8Array | string): string {
  const bytes =
    typeof value === "string" ? new TextEncoder().encode(value) : value;
  return Buffer.from(bytes).toString("base64url");
}

async function signedAccessJwt(
  privateKey: CryptoKey,
  claims: Record<string, unknown>,
): Promise<string> {
  const header = base64Url(
    JSON.stringify({ alg: "RS256", kid: "guard-test-key", typ: "JWT" }),
  );
  const payload = base64Url(JSON.stringify(claims));
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${base64Url(new Uint8Array(signature))}`;
}

test("console access rejects self-asserted identity, cross-scope reads, unsafe output, and weak response headers", async () => {
  const spoofed = new Request("https://guard.example/", {
    headers: {
      "cf-access-authenticated-user-email": "attacker@example.test",
      "cf-access-jwt-assertion": "self.asserted.token",
      "x-guard-site-id": "dfconnect",
      "x-guard-environment": "production",
      authorization: "Bearer should-never-appear",
    },
  });

  const unauthenticated = await authorizeConsoleRequest(
    spoofed,
    {
      policy: productionPolicy,
      requestedScope: {
        siteId: "dfconnect",
        environment: "production",
      },
    },
    async () => null,
  );
  assert.deepEqual(unauthenticated, {
    allowed: false,
    status: 401,
    code: "unauthorized",
  });

  const verifiedIdentity = async () => ({
    subject: "access-user-id",
    audiences: ["guard-production-audience"],
  });
  const allowed = await authorizeConsoleRequest(
    new Request("https://guard.example/"),
    {
      policy: productionPolicy,
      requestedScope: {
        siteId: "dfconnect",
        environment: "production",
      },
    },
    verifiedIdentity,
  );
  assert.deepEqual(allowed, { allowed: true });

  for (const requestedScope of [
    { siteId: "other-site", environment: "production" as const },
    { siteId: "dfconnect", environment: "staging" as const },
  ]) {
    const crossScope = await authorizeConsoleRequest(
      new Request("https://guard.example/"),
      { policy: productionPolicy, requestedScope },
      verifiedIdentity,
    );
    assert.deepEqual(crossScope, {
      allowed: false,
      status: 403,
      code: "forbidden",
    });
  }

  const wrongAudience = await authorizeConsoleRequest(
    new Request("https://guard.example/"),
    {
      policy: productionPolicy,
      requestedScope: {
        siteId: "dfconnect",
        environment: "production",
      },
    },
    async () => ({
      subject: "other-access-user",
      audiences: ["guard-staging-audience"],
    }),
  );
  assert.deepEqual(wrongAudience, {
    allowed: false,
    status: 403,
    code: "forbidden",
  });

  const malformedAssertion = await verifyCloudflareAccessRequest(
    new Request("https://guard.example/", {
      headers: { "cf-access-jwt-assertion": "not-a-jwt" },
    }),
    {
      issuer: "https://dfconnect.cloudflareaccess.com",
      audience: "guard-production-audience",
      nowSeconds: () => 1_785_427_200,
    },
    async () => {
      throw new Error("malformed JWT must fail before JWKS fetch");
    },
  );
  assert.equal(malformedAssertion, null);

  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const validAssertion = await signedAccessJwt(keyPair.privateKey, {
    iss: "https://dfconnect.cloudflareaccess.com",
    aud: ["guard-production-audience"],
    sub: "verified-access-subject",
    iat: 1_785_427_190,
    nbf: 1_785_427_190,
    exp: 1_785_427_500,
  });
  const jwksFetcher: typeof fetch = async () =>
    Response.json({
      keys: [
        {
          ...publicJwk,
          kid: "guard-test-key",
          alg: "RS256",
          use: "sig",
        },
      ],
    });
  const verified = await verifyCloudflareAccessRequest(
    new Request("https://guard.example/", {
      headers: { "cf-access-jwt-assertion": validAssertion },
    }),
    {
      issuer: "https://dfconnect.cloudflareaccess.com",
      audience: "guard-production-audience",
      nowSeconds: () => 1_785_427_200,
    },
    jwksFetcher,
  );
  assert.deepEqual(verified, {
    subject: "verified-access-subject",
    audiences: ["guard-production-audience"],
  });

  const [tamperedHeader, tamperedPayload, encodedSignature] =
    validAssertion.split(".");
  const tamperedSignature = Buffer.from(encodedSignature, "base64url");
  tamperedSignature[0] ^= 1;
  const tamperedAssertion = [
    tamperedHeader,
    tamperedPayload,
    tamperedSignature.toString("base64url"),
  ].join(".");
  const tampered = await verifyCloudflareAccessRequest(
    new Request("https://guard.example/", {
      headers: { "cf-access-jwt-assertion": tamperedAssertion },
    }),
    {
      issuer: "https://dfconnect.cloudflareaccess.com",
      audience: "guard-production-audience",
      nowSeconds: () => 1_785_427_200,
    },
    jwksFetcher,
  );
  assert.equal(tampered, null);

  const unsafe =
    '<img src=x onerror=alert(1)> https://api.example/path?token=secret account_123 Bearer abc';
  const projected = resolveConsoleReason(unsafe);
  assert.equal(projected, "詳細な理由は安全な証跡から取得できません。");
  assert.doesNotMatch(projected, /img|token|account_123|Bearer|https?:/u);

  const secured = applyConsoleSecurityHeaders(
    new Response("<main>safe</main>", {
      headers: { "content-type": "text/html; charset=utf-8" },
    }),
  );
  assert.equal(secured.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.match(
    secured.headers.get("content-security-policy") ?? "",
    /default-src 'none'/u,
  );
  assert.match(
    secured.headers.get("content-security-policy") ?? "",
    /frame-ancestors 'none'/u,
  );
  assert.equal(secured.headers.get("referrer-policy"), "no-referrer");
  assert.equal(secured.headers.get("x-content-type-options"), "nosniff");
  assert.equal(secured.headers.get("x-frame-options"), "DENY");
  assert.equal(secured.headers.get("permissions-policy"), "camera=(), microphone=(), geolocation=()");

  const nonce = createConsoleCspNonce();
  assert.match(nonce, /^[A-Za-z0-9_-]{22}$/u);
  const prepared = prepareConsoleHtmlRequest(
    spoofed,
    nonce,
  );
  assert.match(
    prepared.headers.get("content-security-policy") ?? "",
    new RegExp(`script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`, "u"),
  );
  for (const sensitive of [
    "authorization",
    "cookie",
    "cf-access-jwt-assertion",
    "cf-access-authenticated-user-email",
    "oai-authenticated-user-email",
    "x-guard-site-id",
    "x-guard-environment",
  ]) {
    assert.equal(prepared.headers.get(sensitive), null);
  }
  const nonceSecured = applyConsoleSecurityHeaders(
    new Response("<script nonce=\"safe\"></script>"),
    nonce,
  );
  assert.match(
    nonceSecured.headers.get("content-security-policy") ?? "",
    new RegExp(`'nonce-${nonce}'`, "u"),
  );
  assert.doesNotMatch(
    nonceSecured.headers.get("content-security-policy") ?? "",
    /unsafe-inline/u,
  );

  const denied = consoleAccessErrorResponse(unauthenticated);
  assert.equal(denied.status, 401);
  assert.deepEqual(await denied.json(), { error: "unauthorized" });
  const serialized = JSON.stringify([...denied.headers]);
  assert.doesNotMatch(
    serialized,
    /attacker|access-user-id|guard-production-audience|dfconnect/u,
  );
});
