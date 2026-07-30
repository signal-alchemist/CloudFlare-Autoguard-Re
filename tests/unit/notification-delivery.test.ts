import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DatabaseSync,
  type SQLInputValue,
  type StatementSync,
} from "node:sqlite";
import test from "node:test";

import { stableJson } from "../../lib/contracts/ops-signal.ts";
import {
  processNotificationBatch,
  processNotificationMessage,
  type NotificationDeliveryAuthorizationRepository,
  type NotificationDeliveryDependencies,
  type NotificationDeliveryMarker,
  type NotificationDeliveryRepository,
  type NotificationProviderPort,
  type QueueMessagePort,
} from "../../lib/adapters/notification-delivery.ts";
import { compileNotificationDelivery } from "../../lib/contracts/notifications.ts";
import { D1NotificationDeliveryRepository } from "../../lib/repositories/notification-deliveries.ts";
import { D1NotificationOutboxRepository } from "../../lib/repositories/notification-outbox.ts";
import {
  toSafeNotification,
  type SafeNotificationEnvelope,
} from "../../lib/security/safe-output.ts";
import type {
  D1DatabasePort,
  D1PreparedStatementPort,
  D1RunResult,
} from "../../lib/repositories/observations.ts";

class NodeSqliteStatement implements D1PreparedStatementPort {
  readonly statement: StatementSync;
  readonly values: unknown[];
  private readonly database: DatabaseSync;
  private readonly sql: string;

  constructor(
    database: DatabaseSync,
    sql: string,
    values: unknown[] = [],
  ) {
    this.database = database;
    this.sql = sql;
    this.statement = database.prepare(sql);
    this.values = values;
  }

  bind(...values: unknown[]): D1PreparedStatementPort {
    return new NodeSqliteStatement(this.database, this.sql, values);
  }

  async first<T>(): Promise<T | null> {
    return (
      this.statement.get(...(this.values as SQLInputValue[])) as T | undefined
    ) ?? null;
  }

  async run(): Promise<D1RunResult> {
    const result = this.statement.run(
      ...(this.values as SQLInputValue[]),
    );
    return {
      success: true,
      meta: { changes: Number(result.changes) },
    };
  }
}

class NodeSqliteD1 implements D1DatabasePort {
  readonly database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.database = database;
  }

  prepare(sql: string): D1PreparedStatementPort {
    return new NodeSqliteStatement(this.database, sql);
  }

  async batch(
    statements: readonly D1PreparedStatementPort[],
  ): Promise<D1RunResult[]> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results: D1RunResult[] = [];
      for (const statement of statements) {
        results.push(await statement.run());
      }
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

class TestMessage implements QueueMessagePort {
  readonly body: unknown;
  readonly attempts: number;
  ackCount = 0;
  retryDelays: number[] = [];
  readonly events: string[];

  constructor(body: unknown, attempts = 1, events: string[] = []) {
    this.body = body;
    this.attempts = attempts;
    this.events = events;
  }

  ack(): void {
    this.events.push("ack");
    this.ackCount += 1;
  }

  retry(options: { delaySeconds: number }): void {
    this.events.push(`retry:${options.delaySeconds}`);
    this.retryDelays.push(options.delaySeconds);
  }
}

class MemoryRepository implements NotificationDeliveryRepository {
  readonly markers = new Map<string, NotificationDeliveryMarker>();
  readonly events: string[];
  failRecord = false;

  constructor(events: string[] = []) {
    this.events = events;
  }

  async find(deliveryKey: string): Promise<NotificationDeliveryMarker | null> {
    return this.markers.get(deliveryKey) ?? null;
  }

  async record(
    marker: NotificationDeliveryMarker,
  ): Promise<NotificationDeliveryMarker> {
    this.events.push("marker");
    if (this.failRecord) throw new Error("secret database failure");
    const existing = this.markers.get(marker.deliveryKey);
    if (existing && existing.payloadDigest !== marker.payloadDigest) {
      throw new Error("notification_idempotency_conflict");
    }
    this.markers.set(marker.deliveryKey, existing ?? marker);
    return existing ?? marker;
  }
}

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
  observedAt: "2026-07-31T05:00:00.000Z",
  correlationId: "probe-run-notification-12",
} as const;
const notification = toSafeNotification(incidentProjection);

function provider(
  events: string[],
  result: { status: number; retryAfterSeconds?: number } = {
    status: 204,
  },
): NotificationProviderPort & { bodies: string[]; calls: number } {
  return {
    bodies: [],
    calls: 0,
    async send(request) {
      this.calls += 1;
      this.bodies.push(request.body);
      events.push("provider");
      assert.equal(request.idempotencyKey, notification.deliveryKey);
      assert.equal(request.timeoutMs, 5_000);
      return result;
    },
  };
}

const clock = () => Date.parse("2026-07-31T05:01:00.000Z");
const notificationScope = {
  siteId: "dfconnect",
  environment: "production",
} as const;

function deliveryDependencies(
  notificationProvider: NotificationProviderPort,
  repository: NotificationDeliveryRepository,
  outbox: NotificationDeliveryAuthorizationRepository = {
    async authorizeDelivery() {
      return true;
    },
  },
): NotificationDeliveryDependencies {
  return {
    provider: notificationProvider,
    repository,
    outbox,
    scope: notificationScope,
    clock,
  };
}

test("safe notification delivery marks after 2xx, dedupes restart, and retries toward platform DLQ", async () => {
  const migrationDirectory = new URL("../../drizzle/", import.meta.url);
  const migrations = (
    await Promise.all(
      (await readdir(migrationDirectory))
        .filter((file) => file.endsWith(".sql"))
        .sort()
        .map((file) =>
          readFile(new URL(file, migrationDirectory), "utf8"),
        ),
    )
  ).join("\n");
  const directory = await mkdtemp(join(tmpdir(), "cloudflare-guard-notify-"));
  const databasePath = join(directory, "guard.sqlite");
  let database = new DatabaseSync(databasePath);
  database.exec(migrations);
  database.exec("PRAGMA foreign_keys = ON");
  database
    .prepare(
      `
        INSERT INTO incidents (
          incident_id, fingerprint, site_id, environment, component,
          reason_code, scope, severity, state, opened_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      incidentProjection.incidentId,
      "d".repeat(64),
      incidentProjection.siteId,
      incidentProjection.environment,
      incidentProjection.component,
      incidentProjection.reasonCode,
      incidentProjection.scope,
      incidentProjection.severity,
      incidentProjection.state,
      incidentProjection.observedAt,
      incidentProjection.observedAt,
    );
  const compiledNotification = await compileNotificationDelivery(
    notification,
  );
  database.prepare(`
    INSERT INTO observations (
      observation_id, schema_version, site_id, environment, component,
      check_id, status, reason_code, observed_at, valid_until, source, scope,
      evidence_id, correlation_id, idempotency_key, created_at
    ) VALUES (?, 1, ?, ?, ?, 'public.apex', 'fail', ?, ?, ?,
      'public_probe', ?, ?, ?, 'notification-delivery-fixture', ?)
  `).run(
    "obs_0123456789abcdef0123456789abcdef",
    incidentProjection.siteId,
    incidentProjection.environment,
    incidentProjection.component,
    incidentProjection.reasonCode,
    incidentProjection.observedAt,
    "2026-07-31T05:03:00.000Z",
    incidentProjection.scope,
    incidentProjection.evidenceId,
    incidentProjection.correlationId,
    incidentProjection.observedAt,
  );
  database.prepare(`
    INSERT INTO notification_outbox (
      outbox_id, incident_id, observation_id, notification_kind, status,
      payload_json, payload_digest, created_at, updated_at, enqueued_at,
      last_error_code
    ) VALUES (?, ?, ?, 'incident_opened', 'pending', ?, ?, ?, ?, NULL, NULL)
  `).run(
    `outbox:${incidentProjection.incidentId}:incident_opened`,
    incidentProjection.incidentId,
    "obs_0123456789abcdef0123456789abcdef",
    compiledNotification.body,
    compiledNotification.payloadDigest,
    incidentProjection.observedAt,
    incidentProjection.observedAt,
  );
  let outboxRepository = new D1NotificationOutboxRepository(
    new NodeSqliteD1(database),
    notificationScope,
  );
  let d1Repository = new D1NotificationDeliveryRepository(
    new NodeSqliteD1(database),
  );
  const order: string[] = [];
  const firstProvider = provider(order);
  const orderedRepository: NotificationDeliveryRepository = {
    find: (key) => d1Repository.find(key),
    async record(marker) {
      order.push("marker");
      return d1Repository.record(marker);
    },
  };
  const orderedOutbox: NotificationDeliveryAuthorizationRepository = {
    async authorizeDelivery(input) {
      order.push("outbox");
      return outboxRepository.authorizeDelivery(input);
    },
  };
  const firstMessage = new TestMessage(notification, 1, order);
  await processNotificationMessage(
    firstMessage,
    deliveryDependencies(
      firstProvider,
      orderedRepository,
      orderedOutbox,
    ),
  );
  assert.deepEqual(order, ["outbox", "provider", "marker", "ack"]);
  assert.equal(firstMessage.ackCount, 1);
  assert.deepEqual(firstMessage.retryDelays, []);
  assert.equal(firstProvider.bodies[0], stableJson(notification));
  const marker = await d1Repository.find(notification.deliveryKey);
  assert.match(marker?.payloadDigest ?? "", /^[a-f0-9]{64}$/u);
  assert.deepEqual(Object.keys(marker ?? {}).sort(), [
    "correlationId",
    "deliveredAt",
    "deliveryKey",
    "incidentId",
    "payloadDigest",
    "providerCode",
  ]);
  assert.equal(marker?.providerCode, "http_2xx");
  database.prepare(`
    UPDATE notification_outbox
    SET status = 'enqueued', enqueued_at = ?, updated_at = ?
  `).run(
    "2026-07-31T05:00:30.000Z",
    "2026-07-31T05:00:30.000Z",
  );
  database.prepare(`
    UPDATE notification_deliveries
    SET provider_code = 'http_204'
    WHERE delivery_key = ?
  `).run(notification.deliveryKey);

  database.close();
  database = new DatabaseSync(databasePath);
  database.exec("PRAGMA foreign_keys = ON");
  d1Repository = new D1NotificationDeliveryRepository(
    new NodeSqliteD1(database),
  );
  outboxRepository = new D1NotificationOutboxRepository(
    new NodeSqliteD1(database),
    notificationScope,
  );
  const replayProvider = provider([]);
  const replayMessage = new TestMessage(notification);
  assert.equal(
    (await d1Repository.find(notification.deliveryKey))?.providerCode,
    "http_204",
  );
  await processNotificationMessage(
    replayMessage,
    deliveryDependencies(
      replayProvider,
      d1Repository,
      outboxRepository,
    ),
  );
  assert.equal(replayProvider.calls, 0);
  assert.equal(replayMessage.ackCount, 1);

  const markerFailureEvents: string[] = [];
  const markerFailureRepository = new MemoryRepository(
    markerFailureEvents,
  );
  markerFailureRepository.failRecord = true;
  const markerFailureProvider = provider(markerFailureEvents);
  const markerFailureMessage = new TestMessage(
    notification,
    1,
    markerFailureEvents,
  );
  await processNotificationMessage(
    markerFailureMessage,
    deliveryDependencies(
      markerFailureProvider,
      markerFailureRepository,
    ),
  );
  assert.deepEqual(markerFailureEvents, ["provider", "marker", "retry:5"]);
  assert.equal(markerFailureMessage.ackCount, 0);

  const retryCases = [
    [{ status: 429, retryAfterSeconds: 999 }, 300],
    [{ status: 503 }, 10],
  ] as const;
  for (const [response, delay] of retryCases) {
    const retryProvider = provider([], response);
    const retryMessage = new TestMessage(notification, 2);
    await processNotificationMessage(
      retryMessage,
      deliveryDependencies(
        retryProvider,
        new MemoryRepository(),
      ),
    );
    assert.deepEqual(retryMessage.retryDelays, [delay]);
    assert.equal(retryMessage.ackCount, 0);
  }

  for (const attempts of [1, 2, 3, 4]) {
    const failureMessage = new TestMessage(notification, attempts);
    await processNotificationMessage(
      failureMessage,
      deliveryDependencies(
        provider([], { status: 503 }),
        new MemoryRepository(),
      ),
    );
    assert.equal(failureMessage.ackCount, 0);
    assert.equal(failureMessage.retryDelays.length, 1);
  }

  const networkMessage = new TestMessage(notification);
  const networkOutcome = await processNotificationMessage(
    networkMessage,
    deliveryDependencies({
      async send() {
        throw new Error("CANARY_PROVIDER_NETWORK_ERROR_12");
      },
    }, new MemoryRepository()),
  );
  assert.equal(networkOutcome.reasonCode, "notification_provider_retryable");
  assert.equal(networkMessage.retryDelays.length, 1);
  assert.doesNotMatch(
    JSON.stringify(networkOutcome),
    /CANARY_PROVIDER_NETWORK_ERROR_12/u,
  );

  const rejectedMessage = new TestMessage(notification);
  const rejectedOutcome = await processNotificationMessage(
    rejectedMessage,
    deliveryDependencies(
      provider([], { status: 400 }),
      new MemoryRepository(),
    ),
  );
  assert.equal(rejectedOutcome.status, "poison_retry_scheduled");
  assert.equal(rejectedMessage.ackCount, 0);

  const invalidMessage = new TestMessage({
    ...notification,
    authorization: "CANARY_NOTIFICATION_TOKEN_12",
  });
  const invalidProvider = provider([]);
  await processNotificationMessage(
    invalidMessage,
    deliveryDependencies(
      invalidProvider,
      new MemoryRepository(),
    ),
  );
  assert.equal(invalidProvider.calls, 0);
  assert.equal(invalidMessage.ackCount, 0);
  assert.equal(invalidMessage.retryDelays.length, 1);

  const conflict: SafeNotificationEnvelope = {
    ...notification,
    state: "acknowledged",
  };
  const conflictProvider = provider([]);
  const conflictMessage = new TestMessage(conflict);
  await processNotificationMessage(
    conflictMessage,
    deliveryDependencies(
      conflictProvider,
      d1Repository,
      outboxRepository,
    ),
  );
  assert.equal(conflictProvider.calls, 0);
  assert.equal(conflictMessage.ackCount, 0);
  assert.equal(conflictMessage.retryDelays.length, 1);

  let unauthorizedMarkerReads = 0;
  const unauthorizedRepository: NotificationDeliveryRepository = {
    async find() {
      unauthorizedMarkerReads += 1;
      return null;
    },
    async record(candidate) {
      return candidate;
    },
  };
  const forgedMessages = [
    new TestMessage({
      ...notification,
      state: "acknowledged",
    }),
    new TestMessage({
      ...notification,
      evidenceId: "ev_f123456789abcdef0123456789abcdef",
      deliveryKey:
        `notify:${notification.incidentId}:` +
        "ev_f123456789abcdef0123456789abcdef",
    }),
    new TestMessage({
      ...notification,
      environment: "staging",
    }),
  ];
  for (const forged of forgedMessages) {
    const forgedProvider = provider([]);
    const outcome = await processNotificationMessage(
      forged,
      deliveryDependencies(
        forgedProvider,
        unauthorizedRepository,
        outboxRepository,
      ),
    );
    assert.equal(outcome.status, "poison_retry_scheduled");
    assert.equal(forgedProvider.calls, 0);
    assert.equal(forged.ackCount, 0);
    assert.equal(forged.retryDelays.length, 1);
  }
  assert.equal(unauthorizedMarkerReads, 0);

  if (!marker) assert.fail("delivery marker missing");
  await assert.rejects(
    d1Repository.record({
      ...marker,
      payloadDigest: "e".repeat(64),
    }),
    /notification_idempotency_conflict/u,
  );
  await assert.rejects(
    d1Repository.record({
      ...marker,
      incidentId: "inc_f123456789abcdef0123456789abcdef",
    }),
    /notification_idempotency_conflict/u,
  );

  const batchSuccess = toSafeNotification({
    ...incidentProjection,
    incidentId: "inc_1123456789abcdef0123456789abcdef",
    evidenceId: "ev_1123456789abcdef0123456789abcdef",
  });
  const batchFailure = toSafeNotification({
    ...incidentProjection,
    incidentId: "inc_2123456789abcdef0123456789abcdef",
    evidenceId: "ev_2123456789abcdef0123456789abcdef",
  });
  const successMessage = new TestMessage(batchSuccess);
  const failureMessage = new TestMessage(batchFailure);
  let batchCalls = 0;
  await processNotificationBatch(
    [successMessage, failureMessage],
    deliveryDependencies({
      async send() {
        batchCalls += 1;
        return { status: batchCalls === 1 ? 204 : 503 };
      },
    }, new MemoryRepository()),
  );
  assert.equal(successMessage.ackCount, 1);
  assert.equal(successMessage.retryDelays.length, 0);
  assert.equal(failureMessage.ackCount, 0);
  assert.equal(failureMessage.retryDelays.length, 1);

  const queuePlan = JSON.parse(
    await readFile(
      new URL(
        "../../config/cloudflare/notification-queue.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as {
    provisioningStatus: string;
    localRuntimeStatus: string;
    queue: string;
    sitesGeneratedBinding: string;
    remoteEvidence: {
      staging: string;
      production: string;
    };
    consumer: { max_retries: number; dead_letter_queue: string };
  };
  assert.equal(queuePlan.provisioningStatus, "remote-unprovisioned");
  assert.equal(queuePlan.localRuntimeStatus, "ready");
  assert.equal(queuePlan.sitesGeneratedBinding, "absent");
  assert.deepEqual(queuePlan.remoteEvidence, {
    staging: "NOT_RUN",
    production: "NOT_RUN",
  });
  assert.equal(queuePlan.consumer.max_retries, 3);
  assert.notEqual(queuePlan.queue, queuePlan.consumer.dead_letter_queue);
  assert.ok(queuePlan.consumer.dead_letter_queue.length > 0);

  const serialized = JSON.stringify({
    marker,
    outcome: await processNotificationMessage(
      new TestMessage(notification),
      deliveryDependencies(
        replayProvider,
        d1Repository,
        outboxRepository,
      ),
    ),
  });
  assert.doesNotMatch(
    serialized,
    /webhook|authorization|cookie|providerResponse|secret database failure|CANARY_NOTIFICATION_TOKEN_12/iu,
  );
  database.close();
});
