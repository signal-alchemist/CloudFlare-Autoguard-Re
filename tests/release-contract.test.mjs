import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("private Sites release package has an opaque project binding and complete runtime inputs", async () => {
  const hostingRaw = await readFile(
    new URL(".openai/hosting.json", root),
    "utf8",
  );
  const hosting = JSON.parse(hostingRaw);

  assert.equal(hosting.d1, "DB");
  assert.equal(hosting.r2, null);
  assert.equal(typeof hosting.project_id, "string");
  assert.ok(hosting.project_id.length > 0);
  assert.doesNotMatch(hosting.project_id, /\s/u);
  assert.doesNotMatch(
    hostingRaw,
    /secret|token|credential|authorization|cookie/iu,
  );

  await access(new URL("dist/server/index.js", root));
  const wrangler = JSON.parse(
    await readFile(
      new URL("dist/server/wrangler.json", root),
      "utf8",
    ),
  );
  assert.deepEqual(wrangler.triggers?.crons, ["* * * * *"]);
  assert.ok(wrangler.compatibility_flags?.includes("nodejs_compat"));
  assert.equal(wrangler.d1_databases?.[0]?.binding, "DB");
  await access(new URL("worker/index.ts", root));
  await access(new URL("public/og.png", root));

  const migrations = (await readdir(new URL("drizzle", root)))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .sort();
  assert.deepEqual(
    migrations.map((name) => name.slice(0, 4)),
    ["0000", "0001", "0002", "0003", "0004", "0005"],
  );

  const worker = await readFile(new URL("worker/index.ts", root), "utf8");
  assert.match(worker, /CONSOLE_AUTH_MODE/u);
  assert.match(worker, /cloudflare-access/u);
  assert.match(worker, /sites-private/u);
  assert.match(worker, /service_unavailable/u);
  assert.match(worker, /async scheduled/u);
  assert.match(worker, /runDfconnectScheduledPublicDelivery/u);
});
