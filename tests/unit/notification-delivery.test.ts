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
  type NotificationDeliveryMarker,
  type NotificationDeliveryRepository,
  type NotificationProviderPort,
  type QueueMessagePort,
} from "../../lib/adapters/notification-delivery.ts";
import { D1NotificationDeliveryRepository } from "../../lib/repositories/notification-deliveries.ts";
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
  result: { status: number; retryAfter?: string } = { status: 204 },
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
  const firstMessage = new TestMessage(notification, 1, order);
  await processNotificationMessage(firstMessage, {
    provider: firstProvider,
    repository: orderedRepository,
    clock,
  });
  assert.deepEqual(order, ["provider", "marker", "ack"]);
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

  database.close();
  database = new DatabaseSync(databasePath);
  d1Repository = new D1NotificationDeliveryRepository(
    new NodeSqliteD1(database),
  );
  const replayProvider = provider([]);
  const replayMessage = new TestMessage(notification);
  await processNotificationMessage(replayMessage, {
    provider: replayProvider,
    repository: d1Repository,
    clock,
  });
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
  await processNotificationMessage(markerFailureMessage, {
    provider: markerFailureProvider,
    repository: markerFailureRepository,
    clock,
  });
  assert.deepEqual(markerFailureEvents, ["provider", "marker", "retry:5"]);
  assert.equal(markerFailureMessage.ackCount, 0);

  const retryCases = [
    [{ status: 429, retryAfter: "999" }, 300],
    [{ status: 503 }, 10],
  ] as const;
  for (const [response, delay] of retryCases) {
    const retryProvider = provider([], response);
    const retryMessage = new TestMessage(notification, 2);
    await processNotificationMessage(retryMessage, {
      provider: retryProvider,
      repository: new MemoryRepository(),
      clock,
    });
    assert.deepEqual(retryMessage.retryDelays, [delay]);
    assert.equal(retryMessage.ackCount, 0);
  }

  for (const attempts of [1, 2, 3, 4]) {
    const failureMessage = new TestMessage(notification, attempts);
    await processNotificationMessage(failureMessage, {
      provider: provider([], { status: 503 }),
      repository: new MemoryRepository(),
      clock,
    });
    assert.equal(failureMessage.ackCount, 0);
    assert.equal(failureMessage.retryDelays.length, 1);
  }

  const networkMessage = new TestMessage(notification);
  const networkOutcome = await processNotificationMessage(networkMessage, {
    provider: {
      async send() {
        throw new Error("CANARY_PROVIDER_NETWORK_ERROR_12");
      },
    },
    repository: new MemoryRepository(),
    clock,
  });
  assert.equal(networkOutcome.reasonCode, "notification_provider_retryable");
  assert.equal(networkMessage.retryDelays.length, 1);
  assert.doesNotMatch(
    JSON.stringify(networkOutcome),
    /CANARY_PROVIDER_NETWORK_ERROR_12/u,
  );

  const rejectedMessage = new TestMessage(notification);
  const rejectedOutcome = await processNotificationMessage(rejectedMessage, {
    provider: provider([], { status: 400 }),
    repository: new MemoryRepository(),
    clock,
  });
  assert.equal(rejectedOutcome.status, "poison_retry_scheduled");
  assert.equal(rejectedMessage.ackCount, 0);

  const invalidMessage = new TestMessage({
    ...notification,
    authorization: "CANARY_NOTIFICATION_TOKEN_12",
  });
  const invalidProvider = provider([]);
  await processNotificationMessage(invalidMessage, {
    provider: invalidProvider,
    repository: new MemoryRepository(),
    clock,
  });
  assert.equal(invalidProvider.calls, 0);
  assert.equal(invalidMessage.ackCount, 0);
  assert.equal(invalidMessage.retryDelays.length, 1);

  const conflict: SafeNotificationEnvelope = {
    ...notification,
    state: "acknowledged",
  };
  const conflictProvider = provider([]);
  const conflictMessage = new TestMessage(conflict);
  await processNotificationMessage(conflictMessage, {
    provider: conflictProvider,
    repository: d1Repository,
    clock,
  });
  assert.equal(conflictProvider.calls, 0);
  assert.equal(conflictMessage.ackCount, 0);
  assert.equal(conflictMessage.retryDelays.length, 1);

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
  await processNotificationBatch([successMessage, failureMessage], {
    provider: {
      async send() {
        batchCalls += 1;
        return { status: batchCalls === 1 ? 204 : 503 };
      },
    },
    repository: new MemoryRepository(),
    clock,
  });
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
    queue: string;
    consumer: { max_retries: number; dead_letter_queue: string };
  };
  assert.equal(queuePlan.provisioningStatus, "planned");
  assert.equal(queuePlan.consumer.max_retries, 3);
  assert.notEqual(queuePlan.queue, queuePlan.consumer.dead_letter_queue);
  assert.ok(queuePlan.consumer.dead_letter_queue.length > 0);

  const serialized = JSON.stringify({
    marker,
    outcome: await processNotificationMessage(
      new TestMessage(notification),
      {
        provider: replayProvider,
        repository: d1Repository,
        clock,
      },
    ),
  });
  assert.doesNotMatch(
    serialized,
    /webhook|authorization|cookie|providerResponse|secret database failure|CANARY_NOTIFICATION_TOKEN_12/iu,
  );
  database.close();
});
