import assert from "node:assert/strict";
import test from "node:test";

import {
  createHttpNotificationProvider,
} from "../../lib/adapters/http-notification-provider.ts";

const body =
  '{"schema":"safe-notification-envelope-v1","siteId":"dfconnect"}';
const token = "provider-token-0123456789abcdef";

test("enabled HTTP provider posts only canonical input with bounded no-redirect transport and never reads the response body", async () => {
  const calls: Array<{
    input: RequestInfo | URL;
    init: RequestInit | undefined;
  }> = [];
  let timeout = 0;
  let bodyReads = 0;
  const provider = createHttpNotificationProvider({
    enabled: "true",
    endpoint: "https://alerts.example.com/v1/incidents",
    token,
    async fetcher(input, init) {
      calls.push({ input, init });
      return {
        status: 429,
        headers: new Headers({ "retry-after": "120" }),
        get body() {
          bodyReads += 1;
          throw new Error("CANARY_RAW_PROVIDER_RESPONSE");
        },
      } as unknown as Response;
    },
    timeoutSignal(milliseconds) {
      timeout = milliseconds;
      return new AbortController().signal;
    },
  });
  assert.ok(provider);
  const response = await provider.send({
    body,
    contentType: "application/json",
    idempotencyKey:
      "notify:inc_0123456789abcdef0123456789abcdef:" +
      "ev_0123456789abcdef0123456789abcdef",
    timeoutMs: 5_000,
  });
  assert.deepEqual(response, {
    status: 429,
    retryAfterSeconds: 120,
  });
  assert.equal(timeout, 5_000);
  assert.equal(bodyReads, 0);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]?.input,
    "https://alerts.example.com/v1/incidents",
  );
  assert.equal(calls[0]?.init?.method, "POST");
  assert.equal(calls[0]?.init?.body, body);
  assert.equal(calls[0]?.init?.redirect, "manual");
  assert.equal(calls[0]?.init?.credentials, "omit");
  assert.equal(calls[0]?.init?.cache, "no-store");
  const headers = new Headers(calls[0]?.init?.headers);
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(headers.get("authorization"), `Bearer ${token}`);
  assert.match(headers.get("idempotency-key") ?? "", /^notify:/u);
  assert.doesNotMatch(
    JSON.stringify(response),
    /CANARY_RAW_PROVIDER_RESPONSE|provider-token/iu,
  );
});

test("provider requires explicit enablement and rejects non-HTTPS, IP, localhost, userinfo, query, fragment, CRLF, and weak tokens", () => {
  assert.equal(
    createHttpNotificationProvider({
      enabled: undefined,
      endpoint: "https://alerts.example.com/v1/incidents",
      token,
    }),
    null,
  );
  assert.equal(
    createHttpNotificationProvider({
      enabled: "false",
      endpoint: "https://alerts.example.com/v1/incidents",
      token,
    }),
    null,
  );

  const invalidEndpoints = [
    "http://alerts.example.com/v1/incidents",
    "https://127.0.0.1/v1/incidents",
    "https://[::1]/v1/incidents",
    "https://localhost/v1/incidents",
    "https://alerts.localhost/v1/incidents",
    "https://alerts.example.com:444/v1/incidents",
    "https://user:pass@alerts.example.com/v1/incidents",
    "https://alerts.example.com/v1/incidents?token=value",
    "https://alerts.example.com/v1/incidents#fragment",
    "https://alerts.example.com/\r\nx-injected:true",
  ];
  for (const endpoint of invalidEndpoints) {
    assert.throws(
      () =>
        createHttpNotificationProvider({
          enabled: "true",
          endpoint,
          token,
        }),
      /notification_provider_config_invalid/u,
    );
  }
  for (const candidate of [
    undefined,
    "too-short",
    `valid-prefix-${"\r\n"}injected`,
  ]) {
    assert.throws(
      () =>
        createHttpNotificationProvider({
          enabled: "true",
          endpoint: "https://alerts.example.com/v1/incidents",
          token: candidate,
        }),
      /notification_provider_config_invalid/u,
    );
  }
});

test("provider exposes only numeric Retry-After and ignores dates, invalid values, and response bodies", async () => {
  for (const [header, expected] of [
    ["60", 60],
    ["Wed, 21 Oct 2026 07:28:00 GMT", undefined],
    ["-1", undefined],
    ["1.5", undefined],
    ["9999999999", undefined],
  ] as const) {
    const provider = createHttpNotificationProvider({
      enabled: "true",
      endpoint: "https://alerts.example.com/v1/incidents",
      token,
      async fetcher() {
        return new Response("CANARY_PRIVATE_PROVIDER_BODY", {
          status: 503,
          headers: { "retry-after": header },
        });
      },
      timeoutSignal: () => new AbortController().signal,
    });
    assert.ok(provider);
    const result = await provider.send({
      body,
      contentType: "application/json",
      idempotencyKey:
        "notify:inc_0123456789abcdef0123456789abcdef:" +
        "ev_0123456789abcdef0123456789abcdef",
      timeoutMs: 5_000,
    });
    assert.deepEqual(
      result,
      expected === undefined
        ? { status: 503 }
        : { status: 503, retryAfterSeconds: expected },
    );
    assert.doesNotMatch(
      JSON.stringify(result),
      /CANARY_PRIVATE_PROVIDER_BODY/u,
    );
  }

  let redirectCalls = 0;
  const redirectProvider = createHttpNotificationProvider({
    enabled: "true",
    endpoint: "https://alerts.example.com/v1/incidents",
    token,
    async fetcher(_input, init) {
      redirectCalls += 1;
      assert.equal(init?.redirect, "manual");
      return new Response(null, {
        status: 302,
        headers: {
          location: "https://attacker.example/private",
        },
      });
    },
    timeoutSignal: () => new AbortController().signal,
  });
  assert.ok(redirectProvider);
  assert.deepEqual(
    await redirectProvider.send({
      body,
      contentType: "application/json",
      idempotencyKey:
        "notify:inc_0123456789abcdef0123456789abcdef:" +
        "ev_0123456789abcdef0123456789abcdef",
      timeoutMs: 5_000,
    }),
    { status: 302 },
  );
  assert.equal(redirectCalls, 1);
});
