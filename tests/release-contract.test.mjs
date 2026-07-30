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
  assert.deepEqual(
    wrangler.queues?.producers ?? [],
    [],
    "generated Sites package must not claim an unprovisioned producer binding",
  );
  assert.deepEqual(
    wrangler.queues?.consumers ?? [],
    [],
    "generated Sites package must not claim an unprovisioned consumer binding",
  );
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
  assert.match(worker, /async queue/u);
  assert.match(worker, /consumeConfiguredNotificationBatch/u);
  assert.match(worker, /dispatchConfiguredPendingNotifications/u);
  assert.match(worker, /NOTIFICATION_QUEUE_NAME/u);
  assert.match(worker, /NOTIFICATION_PROVIDER_ENABLED/u);
  assert.match(worker, /NOTIFICATION_PROVIDER_ENDPOINT/u);
  assert.match(worker, /NOTIFICATION_PROVIDER_TOKEN/u);
  assert.match(worker, /routeOperationalReadRequest/u);
  assert.match(worker, /loadCanonicalOperabilityFromBindings/u);
  assert.match(worker, /unknownV1Response/u);
  assert.match(worker, /stripHeadResponse/u);
  const publicProducer = worker.indexOf(
    "await runDfconnectScheduledPublicDelivery",
  );
  const notificationDispatch = worker.indexOf(
    "await dispatchConfiguredPendingNotifications",
    publicProducer,
  );
  assert.ok(
    publicProducer >= 0 && notificationDispatch > publicProducer,
    "notification dispatch must remain best-effort after public persistence",
  );
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

  const queuePlan = JSON.parse(
    await readFile(
      new URL("config/cloudflare/notification-queue.json", root),
      "utf8",
    ),
  );
  assert.equal(queuePlan.provisioningStatus, "remote-unprovisioned");
  assert.equal(queuePlan.localRuntimeStatus, "ready");
  assert.equal(queuePlan.sitesGeneratedBinding, "absent");
  assert.deepEqual(queuePlan.remoteEvidence, {
    staging: "NOT_RUN",
    production: "NOT_RUN",
  });
  assert.equal(queuePlan.bindings.producer, "NOTIFICATION_QUEUE");
  assert.equal(
    queuePlan.bindings.consumerQueueName,
    "NOTIFICATION_QUEUE_NAME",
  );

  const notificationWorker = await readFile(
    new URL("worker/notification.ts", root),
    "utf8",
  );
  const dispatcher = await readFile(
    new URL("lib/services/notification-dispatcher.ts", root),
    "utf8",
  );
  const provider = await readFile(
    new URL("lib/adapters/http-notification-provider.ts", root),
    "utf8",
  );
  assert.match(notificationWorker, /batch\.queue !== expectedQueue/u);
  assert.match(notificationWorker, /retryEntireBatch/u);
  assert.match(dispatcher, /NOTIFICATION_DISPATCH_LIMIT/u);
  assert.match(dispatcher, /contentType: "json"/u);
  assert.match(provider, /url\.protocol !== "https:"/u);
  assert.match(provider, /url\.port !== ""/u);
  assert.match(provider, /redirect: "manual"/u);
  assert.match(provider, /request\.timeoutMs !== 5_000/u);
  assert.doesNotMatch(provider, /response\.(?:text|json|arrayBuffer)\s*\(/u);

  const operability = await readFile(
    new URL("lib/services/canonical-operability.ts", root),
    "utf8",
  );
  assert.match(operability, /COMPONENT_CATALOG/u);
  assert.match(operability, /OPERATION_CATALOG/u);
  assert.match(operability, /readOperationalVerdicts/u);
  assert.match(operability, /component_policy_missing/u);
  assert.match(operability, /fresh_pass/u);
  assert.match(operability, /EVIDENCE_BUCKET/u);
  assert.doesNotMatch(operability, /payload_json|payload_digest/u);
  assert.doesNotMatch(operability, /database\.(?:batch|run)\s*\(/u);

  const nativeBindings = await readFile(
    new URL("lib/runtime/cloudflare-bindings.server.ts", root),
    "utf8",
  );
  const pureConsoleLoader = await readFile(
    new URL("lib/runtime/console-snapshot.ts", root),
    "utf8",
  );
  const page = await readFile(new URL("app/page.tsx", root), "utf8");
  assert.match(nativeBindings, /cloudflare:workers/u);
  assert.match(pureConsoleLoader, /loadConsoleSnapshotFromBindings/u);
  assert.doesNotMatch(pureConsoleLoader, /cloudflare:workers/u);
  assert.match(page, /force-dynamic/u);
  assert.match(page, /loadConsoleSnapshot/u);
  assert.doesNotMatch(page, /\bheaders\s*\(/u);
  assert.doesNotMatch(page, /x-guard-site-id|x-guard-environment/u);
});
