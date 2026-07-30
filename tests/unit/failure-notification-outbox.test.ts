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

import type {
  Observation,
  ObservationStatus,
} from "../../lib/contracts/ops-signal.ts";
import {
  incidentSeverityForFailure,
} from "../../lib/domain/incident-severity-policy.ts";
import { D1IncidentRepository } from "../../lib/repositories/incidents.ts";
import {
  D1ObservationRepository,
  type D1DatabasePort,
  type D1PreparedStatementPort,
  type D1RunResult,
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

class RejectingOutboxStatement implements D1PreparedStatementPort {
  readonly inner: D1PreparedStatementPort;
  readonly sql: string;

  constructor(inner: D1PreparedStatementPort, sql: string) {
    this.inner = inner;
    this.sql = sql;
  }

  bind(...values: unknown[]): D1PreparedStatementPort {
    return new RejectingOutboxStatement(
      this.inner.bind(...values),
      this.sql,
    );
  }

  first<T>(): Promise<T | null> {
    return this.inner.first<T>();
  }

  run(): Promise<D1RunResult> {
    if (this.sql.includes("INTO notification_outbox")) {
      return Promise.reject(new Error("simulated_outbox_write_failure"));
    }
    return this.inner.run();
  }
}

class RejectingOutboxD1 implements D1DatabasePort {
  readonly base: NodeSqliteD1;

  constructor(base: NodeSqliteD1) {
    this.base = base;
  }

  prepare(sql: string): D1PreparedStatementPort {
    return new RejectingOutboxStatement(this.base.prepare(sql), sql);
  }

  batch(
    statements: readonly D1PreparedStatementPort[],
  ): Promise<D1RunResult[]> {
    return this.base.batch(statements);
  }
}

async function migrationSql(): Promise<readonly string[]> {
  const directory = new URL("../../drizzle/", import.meta.url);
  return Promise.all(
    (await readdir(directory))
      .filter((file) => file.endsWith(".sql"))
      .sort()
      .map((file) => readFile(new URL(file, directory), "utf8")),
  );
}

async function migratedDatabase(
  path = ":memory:",
): Promise<{ sqlite: DatabaseSync; port: NodeSqliteD1 }> {
  const sqlite = new DatabaseSync(path);
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const migration of await migrationSql()) sqlite.exec(migration);
  return { sqlite, port: new NodeSqliteD1(sqlite) };
}

function failure(
  suffix = "1",
  overrides: Partial<Observation> = {},
): Observation {
  const hex = suffix.repeat(32);
  return {
    schemaVersion: 1,
    observationId: `obs_${hex}`,
    siteId: "dfconnect",
    environment: "production",
    component: "public_delivery",
    checkId: "public.apex",
    status: "fail",
    reasonCode: "http_status_unexpected",
    observedAt: `2026-07-31T05:0${suffix}:00.000Z`,
    validUntil: `2026-07-31T05:0${suffix}:30.000Z`,
    source: "public_probe",
    scope: "https://dfconnect.jp/",
    evidenceId: `ev_${hex}`,
    correlationId: `scheduled-failure-${suffix}`,
    idempotencyKey: `scheduled:dfconnect:production:failure:${suffix}`,
    ...overrides,
  };
}

function counts(sqlite: DatabaseSync): Record<string, number> {
  return {
    ...(sqlite.prepare(`
      SELECT
        (SELECT COUNT(*) FROM incidents) incidents,
        (SELECT COUNT(*) FROM incident_timeline) timeline,
        (SELECT COUNT(*) FROM notification_outbox) outbox
    `).get() as Record<string, number>),
  };
}

const productionRepairScope = {
  siteId: "dfconnect",
  environment: "production",
} as const;

test("confirmed FAIL atomically creates one safe pending notification and remains exact across replay, a new failure, and restart", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "cloudflare-guard-failure-outbox-"),
  );
  const databasePath = join(directory, "guard.sqlite");
  let { sqlite, port } = await migratedDatabase(databasePath);
  const firstObservation = failure("1");
  await new D1ObservationRepository(port).record(
    firstObservation,
    "2026-07-31T05:01:02.000Z",
  );

  let repository = new D1IncidentRepository(port);
  const first =
    await repository.recordFailureAndPendingNotification(
      firstObservation,
    );
  assert.equal(first.status, "created");
  assert.equal(first.incident?.severity, "sev2");
  assert.deepEqual(counts(sqlite), {
    incidents: 1,
    timeline: 1,
    outbox: 1,
  });

  const outbox = sqlite.prepare(`
    SELECT outbox_id, incident_id, observation_id, notification_kind,
      status, payload_json, payload_digest, created_at, updated_at,
      enqueued_at, last_error_code
    FROM notification_outbox
  `).get() as Record<string, unknown>;
  assert.deepEqual(
    {
      notification_kind: outbox.notification_kind,
      status: outbox.status,
      created_at: outbox.created_at,
      updated_at: outbox.updated_at,
      enqueued_at: outbox.enqueued_at,
      last_error_code: outbox.last_error_code,
    },
    {
      notification_kind: "incident_opened",
      status: "pending",
      created_at: "2026-07-31T05:01:02.000Z",
      updated_at: "2026-07-31T05:01:02.000Z",
      enqueued_at: null,
      last_error_code: null,
    },
  );
  const envelope = JSON.parse(String(outbox.payload_json)) as
    Record<string, unknown>;
  assert.deepEqual(Object.keys(envelope).sort(), [
    "component",
    "correlationId",
    "deliveryKey",
    "environment",
    "evidenceId",
    "incidentId",
    "observedAt",
    "reasonCode",
    "schema",
    "scope",
    "severity",
    "siteId",
    "state",
  ]);
  assert.equal(envelope.severity, "sev2");
  assert.equal(envelope.evidenceId, firstObservation.evidenceId);
  assert.doesNotMatch(
    String(outbox.payload_json),
    /authorization|cookie|token|secret|private_canary|severity.*error/iu,
  );
  assert.match(String(outbox.payload_digest), /^[a-f0-9]{64}$/u);
  assert.throws(
    () =>
      sqlite.prepare(`
        UPDATE notification_outbox SET status = 'sent'
      `).run(),
    /constraint failed/iu,
  );

  const duplicate =
    await repository.recordFailureAndPendingNotification(
      firstObservation,
    );
  assert.equal(duplicate.status, "duplicate");
  assert.deepEqual(counts(sqlite), {
    incidents: 1,
    timeline: 1,
    outbox: 1,
  });

  const secondObservation = failure("2");
  await new D1ObservationRepository(port).record(
    secondObservation,
    "2026-07-31T05:02:02.000Z",
  );
  const second =
    await repository.recordFailureAndPendingNotification(
      secondObservation,
    );
  assert.equal(second.status, "existing");
  assert.deepEqual(counts(sqlite), {
    incidents: 1,
    timeline: 2,
    outbox: 1,
  });

  sqlite.close();
  sqlite = new DatabaseSync(databasePath);
  sqlite.exec("PRAGMA foreign_keys = ON");
  port = new NodeSqliteD1(sqlite);
  repository = new D1IncidentRepository(port);
  const restartDuplicate =
    await repository.recordFailureAndPendingNotification(
      secondObservation,
    );
  assert.equal(restartDuplicate.status, "duplicate");
  assert.deepEqual(counts(sqlite), {
    incidents: 1,
    timeline: 2,
    outbox: 1,
  });

  sqlite.prepare(`
    UPDATE notification_outbox
    SET payload_json = '{"secret":"private_canary"}'
  `).run();
  await assert.rejects(
    repository.recordFailureAndPendingNotification(secondObservation),
    /notification_outbox_corrupt/u,
  );
  assert.deepEqual(counts(sqlite), {
    incidents: 1,
    timeline: 2,
    outbox: 1,
  });
  sqlite.close();
});

test("server policy ignores inbound severity and every non-FAIL status is suppressed", async () => {
  const { sqlite, port } = await migratedDatabase();
  const repository = new D1IncidentRepository(port);
  assert.equal(
    incidentSeverityForFailure({
      ...failure("3", { environment: "staging" }),
      severity: "sev1",
    } as Observation & { severity: string }),
    "sev3",
  );

  const statuses = [
    "pass",
    "degraded",
    "unknown",
    "unsupported",
    "maintenance",
  ] as const;
  for (const [index, status] of statuses.entries()) {
    const candidate = failure(String(index + 4), {
      status: status as ObservationStatus,
    });
    await new D1ObservationRepository(port).record(
      candidate,
      `2026-07-31T05:${String(index + 4).padStart(2, "0")}:02.000Z`,
    );
    const result =
      await repository.recordFailureAndPendingNotification(candidate);
    assert.equal(result.status, "ignored");
    assert.equal(result.incident, null);
  }
  assert.deepEqual(counts(sqlite), {
    incidents: 0,
    timeline: 0,
    outbox: 0,
  });
  sqlite.close();
});

test("outbox failure rolls back incident and timeline, then bounded repair covers missing timeline and missing outbox", async () => {
  const { sqlite, port } = await migratedDatabase();
  const candidate = failure("9");
  await new D1ObservationRepository(port).record(
    candidate,
    "2026-07-31T05:09:02.000Z",
  );
  await assert.rejects(
    new D1IncidentRepository(
      new RejectingOutboxD1(port),
    ).recordFailureAndPendingNotification(candidate),
    /simulated_outbox_write_failure/u,
  );
  assert.deepEqual(counts(sqlite), {
    incidents: 0,
    timeline: 0,
    outbox: 0,
  });

  const repository = new D1IncidentRepository(port);
  assert.equal(
    await repository.repairMissingFailureNotifications(
      productionRepairScope,
      1,
    ),
    1,
  );
  assert.equal(
    await repository.repairMissingFailureNotifications(
      productionRepairScope,
      1,
    ),
    0,
  );
  assert.deepEqual(counts(sqlite), {
    incidents: 1,
    timeline: 1,
    outbox: 1,
  });

  sqlite.prepare("DELETE FROM incident_timeline").run();
  assert.equal(
    await repository.repairMissingFailureNotifications(
      productionRepairScope,
      1,
    ),
    1,
  );
  assert.deepEqual(counts(sqlite), {
    incidents: 1,
    timeline: 1,
    outbox: 1,
  });

  sqlite.prepare("DELETE FROM notification_outbox").run();
  assert.equal(
    await repository.repairMissingFailureNotifications(
      productionRepairScope,
      1,
    ),
    1,
  );
  assert.deepEqual(counts(sqlite), {
    incidents: 1,
    timeline: 1,
    outbox: 1,
  });
  assert.equal(
    await repository.repairMissingFailureNotifications(
      productionRepairScope,
      1,
    ),
    0,
  );
  sqlite.close();
});

test("repair is scope-bound and indexed, while a legacy resolved opening is blocked without starving later cycles", async () => {
  const { sqlite, port } = await migratedDatabase();
  const stagingFailure = failure("6", {
    environment: "staging",
    correlationId: "staging-failure-6",
    idempotencyKey: "scheduled:dfconnect:staging:failure:6",
  });
  const productionFailure = failure("7");
  const observationRepository = new D1ObservationRepository(port);
  await observationRepository.record(
    stagingFailure,
    "2026-07-31T05:06:02.000Z",
  );
  await observationRepository.record(
    productionFailure,
    "2026-07-31T05:07:02.000Z",
  );

  const repository = new D1IncidentRepository(port);
  assert.equal(
    await repository.repairMissingFailureNotifications(
      productionRepairScope,
      1,
    ),
    1,
  );
  assert.equal(
    (
      sqlite.prepare(`
        SELECT COUNT(*) count
        FROM incidents
        WHERE environment = 'staging'
      `).get() as { count: number }
    ).count,
    0,
  );
  assert.equal(
    await repository.repairMissingFailureNotifications(
      productionRepairScope,
      1,
    ),
    0,
  );

  const queryPlan = sqlite.prepare(`
    EXPLAIN QUERY PLAN
    SELECT observation_id
    FROM observations
    WHERE site_id = ?
      AND environment = ?
      AND status = 'fail'
    ORDER BY created_at, observation_id
    LIMIT 1
  `).all("dfconnect", "production") as Array<{ detail: string }>;
  assert.equal(
    queryPlan.some((row) =>
      row.detail.includes("observations_failure_repair_idx")
    ),
    true,
  );

  sqlite.prepare(`
    UPDATE incidents
    SET state = 'resolved', updated_at = '2026-07-31T05:08:00.000Z'
    WHERE environment = 'production'
  `).run();
  sqlite.prepare(`
    DELETE FROM notification_outbox
    WHERE incident_id IN (
      SELECT incident_id
      FROM incidents
      WHERE environment = 'production'
    )
  `).run();
  assert.equal(
    await repository.repairMissingFailureNotifications(
      productionRepairScope,
      1,
    ),
    1,
  );
  assert.deepEqual(
    {
      ...(sqlite.prepare(`
        SELECT status, last_error_code, enqueued_at
        FROM notification_outbox
      `).get() as Record<string, unknown>),
    },
    {
      status: "blocked",
      last_error_code: "incident_resolved_before_outbox",
      enqueued_at: null,
    },
  );
  assert.equal(
    await repository.repairMissingFailureNotifications(
      productionRepairScope,
      1,
    ),
    0,
  );

  const recurringFailure = failure("8");
  await observationRepository.record(
    recurringFailure,
    "2026-07-31T05:08:02.000Z",
  );
  await assert.rejects(
    repository.recordFailureAndPendingNotification(recurringFailure),
    /incident_reopen_required/u,
  );
  sqlite.close();
});
