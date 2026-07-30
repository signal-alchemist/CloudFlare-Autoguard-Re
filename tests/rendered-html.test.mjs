import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const templateRoot = new URL("../", import.meta.url);

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
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

  const html = await response.text();
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
