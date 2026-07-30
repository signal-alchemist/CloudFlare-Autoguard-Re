import assert from "node:assert/strict";
import test from "node:test";

import { dfconnectProductionManifest } from "../../config/sites/dfconnect.production.ts";
import {
  compilePublicDeliveryManifest,
  runPublicDeliveryCheck,
  type PublicDeliveryExchange,
  type PublicDeliveryProbePorts,
} from "../../lib/probes/public-delivery.ts";

function ports(
  exchange: (
    url: string,
    allowedAddresses: readonly string[],
  ) => PublicDeliveryExchange,
  addresses: readonly string[] = ["104.21.35.80", "172.67.145.42"],
): PublicDeliveryProbePorts {
  return {
    async resolve(hostname) {
      assert.ok(hostname === "dfconnect.jp" || hostname === "www.dfconnect.jp");
      return { addresses, ttlSeconds: 300 };
    },
    async exchange(request) {
      return exchange(request.url, request.allowedAddresses);
    },
  };
}

const healthyHtml =
  '<!doctype html><html><head><link rel="canonical" href="https://dfconnect.jp/"></head><body><h1>Web運用の、<span>次の標準をつくる。</span></h1></body></html>';

test("reviewed public-delivery checks reject SSRF, off-origin redirects, and rebinding while storing sanitized evidence", async () => {
  const manifest = compilePublicDeliveryManifest(dfconnectProductionManifest);
  const healthy = await runPublicDeliveryCheck({
    manifest,
    selection: {
      siteId: "dfconnect",
      environment: "production",
      checkId: "public.apex",
    },
    ports: ports((url, allowedAddresses) => {
      assert.equal(url, "https://dfconnect.jp/");
      assert.deepEqual(allowedAddresses, ["104.21.35.80", "172.67.145.42"]);
      return {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "x-content-type-options": "nosniff",
        },
        body: new TextEncoder().encode(healthyHtml),
        connectedAddress: "104.21.35.80",
        elapsedMs: 121,
        tls: {
          authorized: true,
          protocol: "TLSv1.3",
          daysRemaining: 72,
          sniHostname: "dfconnect.jp",
        },
      };
    }),
    now: Date.parse("2026-07-31T00:00:00.000Z"),
    correlationId: "probe-run-001",
  });

  assert.equal(healthy.observation.status, "pass");
  assert.equal(healthy.observation.reasonCode, "public_delivery_healthy");
  assert.equal(healthy.observation.source, "public_probe");
  assert.equal(healthy.evidence.assertions.bodyMarker, true);
  assert.equal(healthy.evidence.assertions.canonical, true);
  assert.match(healthy.evidence.bodySha256 ?? "", /^[a-f0-9]{64}$/u);
  const storedEvidence = JSON.stringify(healthy.evidence);
  assert.doesNotMatch(storedEvidence, /104\.21\.35\.80|172\.67\.145\.42/u);
  assert.doesNotMatch(storedEvidence, /Web運用の、|<html|set-cookie/iu);

  const dnsHealthy = await runPublicDeliveryCheck({
    manifest,
    selection: {
      siteId: "dfconnect",
      environment: "production",
      checkId: "public.dns.apex",
    },
    ports: ports(() => {
      throw new Error("exchange_must_not_run");
    }),
    now: Date.parse("2026-07-31T00:00:10.000Z"),
    correlationId: "probe-run-dns",
  });
  assert.equal(dnsHealthy.observation.reasonCode, "dns_resolution_healthy");

  const tlsHealthy = await runPublicDeliveryCheck({
    manifest,
    selection: {
      siteId: "dfconnect",
      environment: "production",
      checkId: "public.tls.apex",
    },
    ports: ports(() => ({
      status: 200,
      headers: {},
      body: new Uint8Array(),
      connectedAddress: "104.21.35.80",
      elapsedMs: 75,
      tls: {
        authorized: true,
        protocol: "TLSv1.3",
        daysRemaining: 72,
        sniHostname: "dfconnect.jp",
      },
    })),
    now: Date.parse("2026-07-31T00:00:20.000Z"),
    correlationId: "probe-run-tls",
  });
  assert.equal(tlsHealthy.observation.reasonCode, "tls_healthy");

  const privateDns = await runPublicDeliveryCheck({
    manifest,
    selection: {
      siteId: "dfconnect",
      environment: "production",
      checkId: "public.apex",
    },
    ports: ports(() => {
      throw new Error("exchange_must_not_run");
    }, ["169.254.169.254"]),
    now: Date.parse("2026-07-31T00:01:00.000Z"),
    correlationId: "probe-run-002",
  });
  assert.equal(privateDns.observation.status, "fail");
  assert.equal(privateDns.observation.reasonCode, "dns_non_global_address");

  const rebinding = await runPublicDeliveryCheck({
    manifest,
    selection: {
      siteId: "dfconnect",
      environment: "production",
      checkId: "public.apex",
    },
    ports: ports(() => ({
      status: 200,
      headers: { "content-type": "text/html" },
      body: new TextEncoder().encode(healthyHtml),
      connectedAddress: "93.184.216.34",
      elapsedMs: 90,
      tls: {
        authorized: true,
        protocol: "TLSv1.3",
        daysRemaining: 60,
        sniHostname: "dfconnect.jp",
      },
    })),
    now: Date.parse("2026-07-31T00:02:00.000Z"),
    correlationId: "probe-run-003",
  });
  assert.equal(rebinding.observation.status, "fail");
  assert.equal(
    rebinding.observation.reasonCode,
    "http_connection_ip_mismatch",
  );

  const offOrigin = await runPublicDeliveryCheck({
    manifest,
    selection: {
      siteId: "dfconnect",
      environment: "production",
      checkId: "public.apex",
    },
    ports: ports(() => ({
      status: 302,
      headers: { location: "https://attacker.example/collect?token=secret" },
      body: new Uint8Array(),
      connectedAddress: "104.21.35.80",
      elapsedMs: 50,
      tls: {
        authorized: true,
        protocol: "TLSv1.3",
        daysRemaining: 60,
        sniHostname: "dfconnect.jp",
      },
    })),
    now: Date.parse("2026-07-31T00:03:00.000Z"),
    correlationId: "probe-run-004",
  });
  assert.equal(offOrigin.observation.status, "fail");
  assert.equal(offOrigin.observation.reasonCode, "http_off_origin_redirect");
  assert.doesNotMatch(JSON.stringify(offOrigin.evidence), /secret|attacker/iu);

  assert.throws(
    () =>
      compilePublicDeliveryManifest({
        ...dfconnectProductionManifest,
        checks: [
          {
            ...dfconnectProductionManifest.checks[0],
            url: "https://user:password@127.0.0.1/admin",
          },
        ],
      }),
    /public_delivery_manifest_target_forbidden/,
  );
});
