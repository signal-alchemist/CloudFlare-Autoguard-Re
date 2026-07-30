import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const templateRoot = new URL("../", import.meta.url);

async function render({
  url = "http://localhost/",
  headers = {},
  env = {},
} = {}) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(url, {
      headers: { accept: "text/html", ...headers },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
      ...env,
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the read-only Guard console without presenting remote unknown as healthy", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/iu);
  assert.equal(
    response.headers.get("cache-control"),
    "private, no-store, max-age=0",
  );
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow, noarchive");
  const csp = response.headers.get("content-security-policy") ?? "";
  const cspNonce = csp.match(/'nonce-([A-Za-z0-9_-]{22})'/u)?.[1];
  assert.ok(cspNonce);
  assert.match(csp, /default-src 'none'/u);
  assert.match(csp, /frame-ancestors 'none'/u);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/u);

  const html = await response.text();
  const scripts = html.match(/<script(?:\s[^>]*)?>/gu) ?? [];
  assert.ok(scripts.length > 0);
  for (const script of scripts) {
    assert.match(script, new RegExp(`\\snonce="${cspNonce}"`, "u"));
  }
  assert.match(html, /<html[^>]*lang="ja"/iu);
  assert.match(html, /<title>CloudFlare Guard \| DFConnect<\/title>/iu);
  assert.match(html, /data-app="cloudflare-guard"/u);
  assert.match(html, /運用ステータス/u);
  assert.match(html, /REMOTE NOT RUN/u);
  assert.match(html, /最新のリモート証跡は未取得/u);
  assert.equal((html.match(/data-component=/gu) ?? []).length, 8);
  assert.equal((html.match(/data-gate=/gu) ?? []).length, 4);
  assert.match(html, /public_delivery/u);
  assert.match(html, /autoguard_control_plane/u);
  assert.match(html, /contentPublish/u);
  assert.match(html, /destructiveRecovery/u);
  assert.match(html, /インシデント/u);
  assert.match(html, /通知経路/u);
  assert.match(html, /デプロイ検証/u);
  assert.match(html, /Guard readiness/u);
  assert.match(html, /LOCAL PASS/u);
  assert.match(html, /UNKNOWN/u);
  assert.match(html, /DENY/u);
  assert.doesNotMatch(html, /REMOTE HEALTHY|本番は正常|すべて正常/u);
  assert.doesNotMatch(
    html,
    /rollback実行|freeze解除|インシデント削除|監査ログ削除/u,
  );
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/u);

  const packageJson = await readFile(
    new URL("../package.json", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(packageJson, /react-loading-skeleton/u);
  await assert.rejects(
    access(new URL("../app/_sites-preview", import.meta.url)),
  );
  await access(new URL("../public/favicon.svg", import.meta.url));
  await access(new URL("../public/og.png", import.meta.url));

  const page = await readFile(
    new URL("../app/page.tsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(page, /SkeletonPreview|codex-preview/u);
  assert.match(page, /CloudFlare Guard/u);
  assert.match(page, /read-only/u);

  await assert.rejects(
    access(new URL("public/_sites-preview", templateRoot)),
  );
});

test("worker rejects spoofed console identity before rendering or leaking scope", async () => {
  const response = await render({
    url: "https://guard.example/",
    headers: {
      "cf-access-jwt-assertion": "self.asserted.token",
      "cf-access-authenticated-user-email": "attacker@example.test",
      "x-guard-site-id": "other-site",
      "x-guard-environment": "staging",
      authorization: "Bearer secret-canary",
    },
    env: {
      GUARD_SITE_ID: "dfconnect",
      GUARD_ENVIRONMENT: "production",
      CONSOLE_AUTH_MODE: "cloudflare-access",
      CONSOLE_ACCESS_AUDIENCE: "guard-production-audience",
      CONSOLE_ACCESS_ISSUER: "https://dfconnect.cloudflareaccess.com",
    },
  });
  assert.equal(response.status, 401);
  assert.equal(
    response.headers.get("cache-control"),
    "private, no-store, max-age=0",
  );
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  const body = await response.text();
  assert.equal(body, JSON.stringify({ error: "unauthorized" }));
  assert.doesNotMatch(
    body,
    /attacker|other-site|staging|secret-canary|guard-production-audience/u,
  );
});

test("console preserves accessible names, keyboard focus, remote truth, and mobile information order", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  const html = await response.text();

  assert.match(
    html,
    /<nav(?=[^>]*aria-label="デスクトップナビゲーション")[^>]*>/u,
  );
  assert.match(
    html,
    /<nav(?=[^>]*class="mobile-nav")(?=[^>]*aria-label="モバイルナビゲーション")[^>]*>/u,
  );
  assert.match(html, /<main[^>]*id="main-content"[^>]*tabindex="-1"/u);
  assert.match(html, /<h2[^>]*id="components-title"[^>]*>8 Components<\/h2>/u);
  assert.match(html, /<h2[^>]*id="gates-title"[^>]*>4 Operation Gates<\/h2>/u);
  assert.equal(
    (html.match(/aria-labelledby="component-title-[^"]+"/gu) ?? []).length,
    8,
  );
  assert.equal(
    (html.match(/aria-labelledby="gate-title-[^"]+"/gu) ?? []).length,
    4,
  );
  for (const panelTitle of [
    "incidents-title",
    "notification-title",
    "deploy-title",
    "readiness-title",
  ]) {
    assert.match(
      html,
      new RegExp(`aria-labelledby="${panelTitle}"`, "u"),
    );
    assert.match(html, new RegExp(`id="${panelTitle}"`, "u"));
  }
  assert.match(
    html,
    /role="status" aria-live="polite" aria-atomic="true"/u,
  );
  assert.match(html, /aria-label="状態: UNKNOWN"/u);
  assert.match(html, /aria-label="状態: DENY"/u);
  assert.match(html, /aria-label="リモート証跡: REMOTE NOT RUN"/u);

  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(
    css,
    /:where\(a,\s*button,\s*summary\):focus-visible\s*\{/u,
  );
  assert.match(css, /min-height:\s*44px/u);
  for (const breakpoint of [1180, 860, 560]) {
    assert.ok(css.includes(`@media (max-width: ${breakpoint}px)`));
  }
  assert.match(css, /\.mobile-nav\s*\{[^}]*display:\s*none/su);
  const tabletCss = css.slice(
    css.indexOf("@media (max-width: 860px)"),
    css.indexOf("@media (max-width: 560px)"),
  );
  assert.match(tabletCss, /\.mobile-nav\s*\{[^}]*display:\s*flex/su);
  assert.match(
    tabletCss,
    /\.freshness-value\s*\{[^}]*grid-row:\s*3/su,
  );
  const phoneCss = css.slice(
    css.indexOf("@media (max-width: 560px)"),
    css.indexOf("@media (prefers-reduced-motion: reduce)"),
  );
  assert.doesNotMatch(
    phoneCss,
    /\.remote-chip\s*\{[^}]*display:\s*none/su,
  );
  const reducedMotionCss = css.slice(
    css.indexOf("@media (prefers-reduced-motion: reduce)"),
  );
  assert.match(reducedMotionCss, /scroll-behavior:\s*auto\s*!important/u);
  assert.match(reducedMotionCss, /transition[^:]*:\s*none\s*!important/u);
  assert.match(reducedMotionCss, /transform:\s*none\s*!important/u);
  assert.match(css, /--muted:\s*#566170/u);

  const { dashboardSnapshots } = await import(
    "../lib/ui/dashboard-model.ts"
  );
  for (const snapshot of Object.values(dashboardSnapshots)) {
    assert.equal(snapshot.operability, "UNKNOWN");
    assert.equal(snapshot.evidenceMode, "REMOTE NOT RUN");
    assert.equal(snapshot.components.length, 8);
    assert.ok(snapshot.gates.every((gate) => gate.decision === "DENY"));
    assert.ok(snapshot.localVerification.tests > 0);
  }
});
