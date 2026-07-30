import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Log, LogLevel, Miniflare } from "miniflare";

const templateRoot = new URL("../", import.meta.url);
const serverRoot = fileURLToPath(new URL("../dist/server/", import.meta.url));
const clientRoot = fileURLToPath(new URL("../dist/client/", import.meta.url));
const workerConfig = JSON.parse(
  await readFile(new URL("../dist/server/wrangler.json", import.meta.url), "utf8"),
);

async function render({
  url = "http://localhost/",
  method = "GET",
  headers = {},
  env = {},
  d1 = false,
} = {}) {
  const runtime = new Miniflare({
    scriptPath: fileURLToPath(
      new URL("../dist/server/index.js", import.meta.url),
    ),
    modules: true,
    modulesRoot: serverRoot,
    modulesRules: workerConfig.rules.map((rule) => ({
      type: rule.type,
      include: rule.globs,
    })),
    compatibilityDate: workerConfig.compatibility_date,
    compatibilityFlags: workerConfig.compatibility_flags,
    bindings: env,
    ...(d1 ? { d1Databases: ["DB"] } : {}),
    assets: {
      directory: clientRoot,
      binding: "ASSETS",
      routerConfig: {
        has_user_worker: true,
        invoke_user_worker_ahead_of_assets: true,
      },
    },
    log: new Log(LogLevel.ERROR),
  });

  try {
    if (d1) {
      const database = await runtime.getD1Database("DB");
      const migrationDirectory = new URL("../drizzle/", import.meta.url);
      const migrations = (await readdir(migrationDirectory))
        .filter((file) => file.endsWith(".sql"))
        .sort();
      for (const migration of migrations) {
        const sql = await readFile(
          new URL(migration, migrationDirectory),
          "utf8",
        );
        for (const statement of sql
          .split("--> statement-breakpoint")
          .map((candidate) => candidate.trim())
          .filter(Boolean)) {
          await database.prepare(statement).run();
        }
      }
    }
    const response = await runtime.dispatchFetch(url, {
      method,
      headers: { accept: "text/html", ...headers },
    });
    const body = await response.arrayBuffer();
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } finally {
    await runtime.dispose();
  }
}

test("native Worker bindings drive the canonical API, readiness, and SSR from the same scoped D1", async () => {
  const env = {
    GUARD_SITE_ID: "dfconnect",
    GUARD_ENVIRONMENT: "production",
  };
  const canonicalUrl =
    "http://localhost/v1/sites/dfconnect/environments/production/operability";
  const canonical = await render({
    url: canonicalUrl,
    headers: { accept: "application/json" },
    env,
    d1: true,
  });
  assert.equal(canonical.status, 200);
  const snapshot = await canonical.json();
  assert.equal(snapshot.schema, "guard-operability-v1");
  assert.equal(snapshot.siteId, "dfconnect");
  assert.equal(snapshot.environment, "production");
  assert.equal(snapshot.components.length, 8);
  assert.equal(snapshot.gates.length, 4);
  assert.equal(snapshot.incidents.active, 0);
  assert.equal(snapshot.readiness.status, "not_ready");
  assert.ok(
    snapshot.components
      .filter((component) => component.component !== "public_delivery")
      .every(
        (component) =>
          component.state === "unknown" &&
          component.reasonCodes[0] === "component_policy_missing",
      ),
  );
  assert.ok(snapshot.gates.every((gate) => gate.decision === "deny"));

  const ready = await render({
    url: "http://localhost/ready",
    headers: { accept: "application/json" },
    env,
    d1: true,
  });
  assert.equal(ready.status, 503);
  assert.deepEqual(await ready.json(), {
    schema: "guard-readiness-v1",
    status: "not_ready",
  });

  const consoleResponse = await render({
    headers: {
      "x-guard-site-id": "other-site",
      "x-guard-environment": "staging",
    },
    env,
    d1: true,
  });
  assert.equal(consoleResponse.status, 200);
  const html = await consoleResponse.text();
  assert.match(html, /data-environment="production"/u);
  assert.match(html, /LIVE D1/u);
  assert.match(html, /D1の最新スナップショットを表示中/u);
  assert.match(html, /D1 read succeeded/u);
  assert.doesNotMatch(html, /data-environment="staging"/u);
  assert.doesNotMatch(html, /最新のリモート証跡は未取得/u);
});

test("root HEAD preserves the GET response contract without rendering a body", async () => {
  const [getResponse, headResponse] = await Promise.all([
    render(),
    render({ method: "HEAD" }),
  ]);

  assert.equal(getResponse.status, 200);
  assert.equal(headResponse.status, getResponse.status);
  for (const header of [
    "cache-control",
    "content-type",
    "referrer-policy",
    "x-content-type-options",
    "x-frame-options",
    "x-robots-tag",
  ]) {
    assert.equal(headResponse.headers.get(header), getResponse.headers.get(header));
  }
  assert.match(
    headResponse.headers.get("content-security-policy") ?? "",
    /default-src 'none'/u,
  );
  assert.equal(await headResponse.text(), "");
});

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
  assert.match(html, /Scheduler heartbeat/u);
  assert.match(html, /remote heartbeat unavailable/u);
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
    assert.equal(snapshot.incidents.active, null);
    assert.ok(
      snapshot.components.every(
        (component) => component.activeIncidentCount === null,
      ),
    );
    assert.equal(snapshot.scheduler.displayState, "UNKNOWN");
  }
});
