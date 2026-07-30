import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import {
  DatabaseSync,
  type SQLInputValue,
  type StatementSync,
} from "node:sqlite";
import test from "node:test";

import { compileNotificationDelivery } from "../../lib/contracts/notifications.ts";
import {
  D1NotificationOutboxRepository,
  type NotificationOutboxRepository,
} from "../../lib/repositories/notification-outbox.ts";
import type {
  D1DatabasePort,
  D1PreparedStatementPort,
  D1RunResult,
} from "../../lib/repositories/observations.ts";
import {
  dispatchPendingNotifications,
  type NotificationQueuePort,
} from "../../lib/services/notification-dispatcher.ts";
import { toSafeNotification } from "../../lib/security/safe-output.ts";

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

async function database(): Promise<{
  sqlite: DatabaseSync;
  port: NodeSqliteD1;
}> {
  const directory = new URL("../../drizzle/", import.meta.url);
  const migrations = await Promise.all(
    (await readdir(directory))
      .filter((file) => file.endsWith(".sql"))
      .sort()
      .map((file) => readFile(new URL(file, directory), "utf8")),
  );
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const migration of migrations) sqlite.exec(migration);
  return { sqlite, port: new NodeSqliteD1(sqlite) };
}

async function seedPending(
  sqlite: DatabaseSync,
  index: number,
  environment: "staging" | "production" = "production",
): Promise<{
  outboxId: string;
  incidentId: string;
  observationId: string;
  payloadJson: string;
  payloadDigest: string;
}> {
  const hex = index.toString(16).padStart(32, "0");
  const incidentId = `inc_${hex}`;
  const observationId = `obs_${hex}`;
  const evidenceId = `ev_${hex}`;
  const observedAt = `2026-07-31T06:${String(index).padStart(2, "0")}:00.000Z`;
  const correlationId = `notification-dispatch-${index}`;
  const envelope = toSafeNotification({
    incidentId,
    siteId: "dfconnect",
    environment,
    component: "public_delivery",
    severity: environment === "production" ? "sev2" : "sev3",
    state: "open",
    reasonCode: "http_status_unexpected",
    scope: "https://dfconnect.jp/",
    evidenceId,
    observedAt,
    correlationId,
  });
  const compiled = await compileNotificationDelivery(envelope);
  const outboxId = `outbox:${incidentId}:incident_opened`;
  sqlite.prepare(`
    INSERT INTO observations (
      observation_id, schema_version, site_id, environment, component,
      check_id, status, reason_code, observed_at, valid_until, source, scope,
      evidence_id, correlation_id, idempotency_key, created_at
    ) VALUES (?, 1, 'dfconnect', ?, 'public_delivery', 'public.apex',
      'fail', 'http_status_unexpected', ?, ?, 'public_probe',
      'https://dfconnect.jp/', ?, ?, ?, ?)
  `).run(
    observationId,
    environment,
    observedAt,
    new Date(Date.parse(observedAt) + 30_000).toISOString(),
    evidenceId,
    correlationId,
    `dispatch:observation:${index}`,
    observedAt,
  );
  sqlite.prepare(`
    INSERT INTO incidents (
      incident_id, fingerprint, site_id, environment, component,
      reason_code, scope, severity, state, opened_at, updated_at
    ) VALUES (?, ?, 'dfconnect', ?, 'public_delivery',
      'http_status_unexpected', 'https://dfconnect.jp/', ?, 'open', ?, ?)
  `).run(
    incidentId,
    index.toString(16).padStart(64, "0"),
    environment,
    environment === "production" ? "sev2" : "sev3",
    observedAt,
    observedAt,
  );
  sqlite.prepare(`
    INSERT INTO notification_outbox (
      outbox_id, incident_id, observation_id, notification_kind, status,
      payload_json, payload_digest, created_at, updated_at, enqueued_at,
      last_error_code
    ) VALUES (?, ?, ?, 'incident_opened', 'pending', ?, ?, ?, ?, NULL, NULL)
  `).run(
    outboxId,
    incidentId,
    observationId,
    compiled.body,
    compiled.payloadDigest,
    observedAt,
    observedAt,
  );
  return {
    outboxId,
    incidentId,
    observationId,
    payloadJson: compiled.body,
    payloadDigest: compiled.payloadDigest,
  };
}

function statusCounts(
  sqlite: DatabaseSync,
): Record<string, number> {
  const rows = sqlite.prepare(`
    SELECT status, COUNT(*) count
    FROM notification_outbox
    GROUP BY status
  `).all() as Array<{ status: string; count: number }>;
  return Object.fromEntries(rows.map((row) => [row.status, row.count]));
}

const dispatchClock = () =>
  Date.parse("2026-07-31T07:00:00.000Z");

test("dispatcher awaits Queue send before scoped CAS, limits a run to ten, and preserves canonical envelopes", async () => {
  const { sqlite, port } = await database();
  for (let index = 1; index <= 11; index += 1) {
    await seedPending(sqlite, index, "staging");
  }
  for (let index = 12; index <= 22; index += 1) {
    await seedPending(sqlite, index);
  }
  const base = new D1NotificationOutboxRepository(port, {
    siteId: "dfconnect",
    environment: "production",
  });
  const events: string[] = [];
  const repository: NotificationOutboxRepository = {
    scope: base.scope,
    listPending: (limit) => base.listPending(limit),
    markBlocked: (...args) => base.markBlocked(...args),
    markCorruptBlocked: (...args) =>
      base.markCorruptBlocked(...args),
    authorizeDelivery: (...args) => base.authorizeDelivery(...args),
    async markEnqueued(...args) {
      events.push("cas");
      return base.markEnqueued(...args);
    },
  };
  const bodies: unknown[] = [];
  const contentTypes: string[] = [];
  const queue: NotificationQueuePort = {
    async send(body, options) {
      events.push("send:start");
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      bodies.push(body);
      contentTypes.push(options.contentType);
      events.push("send:end");
    },
  };

  const result = await dispatchPendingNotifications({
    repository,
    queue,
    clock: dispatchClock,
  });
  assert.deepEqual(result, {
    selected: 10,
    enqueued: 10,
    blocked: 0,
    retainedPending: 0,
  });
  assert.equal(bodies.length, 10);
  assert.deepEqual(contentTypes, Array.from({ length: 10 }, () => "json"));
  assert.equal(
    events.every(
      (event, index) =>
        event === ["send:start", "send:end", "cas"][index % 3],
    ),
    true,
  );
  assert.deepEqual(statusCounts(sqlite), {
    enqueued: 10,
    pending: 12,
  });
  for (const body of bodies) {
    const compiled = await compileNotificationDelivery(body);
    assert.deepEqual(body, compiled.envelope);
    assert.equal(compiled.envelope.siteId, "dfconnect");
    assert.equal(compiled.envelope.environment, "production");
  }
  sqlite.close();
});

test("Queue or CAS failure and a missing binding leave rows pending without pretending dispatch", async () => {
  const { sqlite, port } = await database();
  await seedPending(sqlite, 20);
  const base = new D1NotificationOutboxRepository(port, {
    siteId: "dfconnect",
    environment: "production",
  });
  let sends = 0;
  const failedSend = await dispatchPendingNotifications({
    repository: base,
    queue: {
      async send() {
        sends += 1;
        throw new Error("CANARY_QUEUE_SECRET_FAILURE");
      },
    },
    clock: dispatchClock,
  });
  assert.deepEqual(failedSend, {
    selected: 1,
    enqueued: 0,
    blocked: 0,
    retainedPending: 1,
  });
  assert.deepEqual(statusCounts(sqlite), { pending: 1 });

  const casFailure: NotificationOutboxRepository = {
    scope: base.scope,
    listPending: (limit) => base.listPending(limit),
    markBlocked: (...args) => base.markBlocked(...args),
    markCorruptBlocked: (...args) =>
      base.markCorruptBlocked(...args),
    authorizeDelivery: (...args) => base.authorizeDelivery(...args),
    async markEnqueued() {
      throw new Error("simulated_cas_failure");
    },
  };
  const failedCas = await dispatchPendingNotifications({
    repository: casFailure,
    queue: {
      async send() {
        sends += 1;
      },
    },
    clock: dispatchClock,
  });
  assert.equal(failedCas.retainedPending, 1);
  assert.deepEqual(statusCounts(sqlite), { pending: 1 });

  const missing = await dispatchPendingNotifications({
    repository: base,
    queue: undefined,
    clock: dispatchClock,
  });
  assert.deepEqual(missing, {
    selected: 0,
    enqueued: 0,
    blocked: 0,
    retainedPending: 0,
  });
  assert.equal(sends, 2);
  assert.deepEqual(statusCounts(sqlite), { pending: 1 });
  assert.doesNotMatch(JSON.stringify(failedSend), /CANARY_QUEUE/u);
  sqlite.close();
});

test("outbox transitions bind the selected snapshot and accept only verified identical terminal replay", async () => {
  const { sqlite, port } = await database();
  await seedPending(sqlite, 31);
  await seedPending(sqlite, 32);
  const repository = new D1NotificationOutboxRepository(port, {
    siteId: "dfconnect",
    environment: "production",
  });
  const [enqueueEntry, blockEntry] =
    await repository.listPending(2);
  assert.ok(enqueueEntry);
  assert.ok(blockEntry);

  sqlite.prepare(`
    UPDATE notification_outbox
    SET updated_at = ?
    WHERE outbox_id = ?
  `).run("2026-07-31T06:59:59.000Z", enqueueEntry.outboxId);
  await assert.rejects(
    repository.markEnqueued(
      enqueueEntry,
      "2026-07-31T07:00:00.000Z",
    ),
    /notification_outbox_enqueue_conflict/u,
  );
  sqlite.prepare(`
    UPDATE notification_outbox
    SET updated_at = ?
    WHERE outbox_id = ?
  `).run(enqueueEntry.updatedAt, enqueueEntry.outboxId);
  await repository.markEnqueued(
    enqueueEntry,
    "2026-07-31T07:00:00.000Z",
  );
  await repository.markEnqueued(
    enqueueEntry,
    "2026-07-31T07:00:01.000Z",
  );

  sqlite.prepare(`
    UPDATE notification_outbox
    SET enqueued_at = ?, last_error_code = ?
    WHERE outbox_id = ?
  `).run(
    "2026-07-31T06:59:59.000Z",
    "tampered_pending_state",
    blockEntry.outboxId,
  );
  await assert.rejects(
    repository.markBlocked(
      blockEntry,
      "notification_outbox_payload_invalid",
      "2026-07-31T07:00:00.000Z",
    ),
    /notification_outbox_block_conflict/u,
  );
  sqlite.prepare(`
    UPDATE notification_outbox
    SET enqueued_at = NULL, last_error_code = NULL
    WHERE outbox_id = ?
  `).run(blockEntry.outboxId);
  await repository.markBlocked(
    blockEntry,
    "notification_outbox_payload_invalid",
    "2026-07-31T07:00:00.000Z",
  );
  await repository.markBlocked(
    blockEntry,
    "notification_outbox_payload_invalid",
    "2026-07-31T07:00:01.000Z",
  );

  assert.deepEqual(statusCounts(sqlite), {
    blocked: 1,
    enqueued: 1,
  });
  sqlite.close();
});

test("a corrupt oldest pending snapshot is quarantined without starving later valid delivery", async () => {
  const { sqlite, port } = await database();
  const corrupt = await seedPending(sqlite, 41);
  await seedPending(sqlite, 42);
  sqlite.prepare(`
    UPDATE notification_outbox
    SET updated_at = ?, enqueued_at = ?, last_error_code = ?
    WHERE outbox_id = ?
  `).run(
    "2026-07-31T06:59:59.000Z",
    "2026-07-31T06:58:59.000Z",
    "legacy_corrupt_state",
    corrupt.outboxId,
  );
  let sends = 0;
  const result = await dispatchPendingNotifications({
    repository: new D1NotificationOutboxRepository(port, {
      siteId: "dfconnect",
      environment: "production",
    }),
    queue: {
      async send() {
        sends += 1;
      },
    },
    clock: dispatchClock,
  });
  assert.deepEqual(result, {
    selected: 2,
    enqueued: 1,
    blocked: 1,
    retainedPending: 0,
  });
  assert.equal(sends, 1);
  assert.deepEqual(
    {
      ...(sqlite.prepare(`
        SELECT status, enqueued_at, last_error_code
        FROM notification_outbox
        WHERE outbox_id = ?
      `).get(corrupt.outboxId) as Record<string, unknown>),
    },
    {
      status: "blocked",
      enqueued_at: null,
      last_error_code: "notification_outbox_payload_invalid",
    },
  );
  sqlite.close();
});

test("delivery authorization requires the exact local failure observation material", async () => {
  const { sqlite, port } = await database();
  const seeded = await seedPending(sqlite, 33);
  const repository = new D1NotificationOutboxRepository(port, {
    siteId: "dfconnect",
    environment: "production",
  });
  const compiled = await compileNotificationDelivery(
    JSON.parse(seeded.payloadJson),
  );
  const authorization = {
    envelope: compiled.envelope,
    payloadJson: compiled.body,
    payloadDigest: compiled.payloadDigest,
  };
  assert.equal(
    await repository.authorizeDelivery(authorization),
    true,
  );
  sqlite.prepare(`
    UPDATE observations
    SET evidence_id = ?
    WHERE observation_id = ?
  `).run(
    "ev_f123456789abcdef0123456789abcdef",
    seeded.observationId,
  );
  assert.equal(
    await repository.authorizeDelivery(authorization),
    false,
  );
  sqlite.prepare(`
    UPDATE observations
    SET evidence_id = ?
    WHERE observation_id = ?
  `).run(
    compiled.envelope.evidenceId,
    seeded.observationId,
  );
  sqlite.prepare(`
    UPDATE notification_outbox
    SET status = 'enqueued', enqueued_at = NULL
    WHERE outbox_id = ?
  `).run(seeded.outboxId);
  assert.equal(
    await repository.authorizeDelivery(authorization),
    false,
  );
  sqlite.prepare(`
    UPDATE notification_outbox
    SET enqueued_at = ?, updated_at = ?
    WHERE outbox_id = ?
  `).run(
    "2026-07-31T07:00:00.000Z",
    "2026-07-31T07:00:00.000Z",
    seeded.outboxId,
  );
  assert.equal(
    await repository.authorizeDelivery(authorization),
    true,
  );
  sqlite.close();
});

test("noncanonical, digest-mismatched, and wrong-scope pending payloads are blocked with one fixed safe code", async () => {
  const { sqlite, port } = await database();
  const malformed = await seedPending(sqlite, 21);
  const digestMismatch = await seedPending(sqlite, 22);
  const wrongScope = await seedPending(sqlite, 23);
  const malformedDigest = await seedPending(sqlite, 24);
  sqlite.prepare(`
    UPDATE notification_outbox
    SET payload_json = '{"secret":"CANARY_RAW_OUTBOX"}'
    WHERE outbox_id = ?
  `).run(malformed.outboxId);
  sqlite.prepare(`
    UPDATE notification_outbox
    SET payload_digest = ?
    WHERE outbox_id = ?
  `).run("f".repeat(64), digestMismatch.outboxId);
  sqlite.prepare(`
    UPDATE notification_outbox
    SET payload_digest = 'not-a-digest'
    WHERE outbox_id = ?
  `).run(malformedDigest.outboxId);
  const wrongBody = JSON.parse(
    String(
      (
        sqlite.prepare(`
          SELECT payload_json FROM notification_outbox
          WHERE outbox_id = ?
        `).get(wrongScope.outboxId) as { payload_json: string }
      ).payload_json,
    ),
  ) as Record<string, unknown>;
  wrongBody.environment = "staging";
  const wrongCompiled = await compileNotificationDelivery(wrongBody);
  sqlite.prepare(`
    UPDATE notification_outbox
    SET payload_json = ?, payload_digest = ?
    WHERE outbox_id = ?
  `).run(
    wrongCompiled.body,
    wrongCompiled.payloadDigest,
    wrongScope.outboxId,
  );

  let sends = 0;
  const repository = new D1NotificationOutboxRepository(port, {
    siteId: "dfconnect",
    environment: "production",
  });
  const result = await dispatchPendingNotifications({
    repository,
    queue: {
      async send() {
        sends += 1;
      },
    },
    clock: dispatchClock,
  });
  assert.deepEqual(result, {
    selected: 4,
    enqueued: 0,
    blocked: 4,
    retainedPending: 0,
  });
  assert.equal(sends, 0);
  const blocked = sqlite.prepare(`
    SELECT status, last_error_code, enqueued_at
    FROM notification_outbox
    ORDER BY outbox_id
  `).all() as Array<Record<string, unknown>>;
  assert.deepEqual(
    blocked.map((row) => ({ ...row })),
    Array.from({ length: 4 }, () => ({
      status: "blocked",
      last_error_code: "notification_outbox_payload_invalid",
      enqueued_at: null,
    })),
  );
  assert.doesNotMatch(
    JSON.stringify({ result, blocked }),
    /CANARY_RAW_OUTBOX|secret/iu,
  );
  sqlite.close();
});
