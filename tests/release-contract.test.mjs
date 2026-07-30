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
    [
      "0000",
      "0001",
      "0002",
      "0003",
      "0004",
      "0005",
      "0006",
      "0007",
    ],
  );
  const notificationMigration = await readFile(
    new URL(`drizzle/${migrations.at(-1)}`, root),
    "utf8",
  );
  assert.match(
    notificationMigration,
    /CREATE TABLE IF NOT EXISTS `notification_outbox`/u,
  );
  assert.match(
    notificationMigration,
    /notification_outbox_status_check" CHECK\("notification_outbox"\."status" IN \('pending', 'enqueued', 'blocked'\)\)/u,
  );
  assert.match(
    notificationMigration,
    /FOREIGN KEY \(`incident_id`\) REFERENCES `incidents`/u,
  );
  assert.match(
    notificationMigration,
    /FOREIGN KEY \(`observation_id`\) REFERENCES `observations`/u,
  );
  assert.match(
    notificationMigration,
    /notification_outbox_incident_kind_unique/u,
  );
  assert.match(
    notificationMigration,
    /notification_outbox_pending_scan_idx/u,
  );
  assert.match(
    notificationMigration,
    /observations_failure_repair_idx/u,
  );

  const worker = await readFile(new URL("worker/index.ts", root), "utf8");
  assert.match(worker, /CONSOLE_AUTH_MODE/u);
  assert.match(worker, /cloudflare-access/u);
  assert.match(worker, /sites-private/u);
  assert.match(worker, /service_unavailable/u);
  assert.match(worker, /async scheduled/u);
  assert.match(worker, /runDfconnectScheduledPublicDelivery/u);
  assert.match(worker, /CMS_MAINTENANCE_SERVICE_TOKEN/u);
  assert.match(worker, /CMS_MAINTENANCE_SIGNING_SECRET/u);
  assert.match(worker, /selectMaintenanceCredentialPair/u);
  assert.match(worker, /\/v1\/maintenance-requests/u);
  const maintenanceStart = worker.indexOf("function maintenanceDependencies");
  const maintenanceEnd = worker.indexOf("function handleGateRequest", maintenanceStart);
  assert.ok(maintenanceStart >= 0 && maintenanceEnd > maintenanceStart);
  const maintenanceWiring = worker.slice(maintenanceStart, maintenanceEnd);
  assert.match(maintenanceWiring, /fallbackServiceToken: env\.CMS_GATE_SERVICE_TOKEN/u);
  assert.match(maintenanceWiring, /fallbackSigningSecret: env\.CMS_GATE_SIGNING_SECRET/u);
  assert.doesNotMatch(maintenanceWiring, /CMS_POST_DEPLOY/u);

  const cmsSignal = await readFile(
    new URL("lib/http/cms-signal.ts", root),
    "utf8",
  );
  const scheduled = await readFile(
    new URL(
      "lib/services/scheduled-public-delivery.ts",
      root,
    ),
    "utf8",
  );
  const incidents = await readFile(
    new URL("lib/repositories/incidents.ts", root),
    "utf8",
  );
  assert.match(cmsSignal, /recordFailureAndPendingNotification/u);
  assert.match(scheduled, /recordFailureAndPendingNotification/u);
  assert.match(scheduled, /repairMissingFailureNotifications/u);
  const operationStart = incidents.indexOf(
    "async recordFailureAndPendingNotification",
  );
  const operationEnd = incidents.indexOf(
    "private async firstUnreconciledFailure",
    operationStart,
  );
  assert.ok(operationStart >= 0 && operationEnd > operationStart);
  const failureOperation = incidents.slice(
    operationStart,
    operationEnd,
  );
  assert.match(failureOperation, /database\.batch/u);
  assert.match(failureOperation, /notification_outbox/u);
  assert.doesNotMatch(
    failureOperation,
    /\.send\s*\(|\bfetch\s*\(|\.enqueue\s*\(/u,
  );
});
