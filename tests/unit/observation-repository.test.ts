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

import {
  D1ObservationRepository,
  D1ReplayStore,
  type D1DatabasePort,
  type D1PreparedStatementPort,
  type D1RunResult,
} from "../../lib/repositories/observations.ts";
import type { Observation } from "../../lib/contracts/ops-signal.ts";

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
    const result = this.statement.run(...(this.values as SQLInputValue[]));
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

const observation: Observation = {
  schemaVersion: 1,
  observationId: "obs_0123456789abcdef0123456789abcdef",
  siteId: "dfconnect",
  environment: "staging",
  component: "deployment_integrity",
  checkId: "cms_ops.worker_runtime",
  status: "fail",
  reasonCode: "worker_runtime_failure",
  observedAt: "2026-07-31T00:00:00.000Z",
  validUntil: "2026-07-31T00:03:00.000Z",
  source: "cms_ops_signal",
  scope: "/healthz",
  evidenceId: "ev_0123456789abcdef0123456789abcdef",
  correlationId: "request_123",
  idempotencyKey:
    "cms:dfconnect:staging:worker.runtime_failure:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};

test("D1 migration is repeatable and restart-safe ingest remains idempotent", async () => {
  const migrationDirectory = new URL("../../drizzle/", import.meta.url);
  const migrationFiles = (await readdir(migrationDirectory))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  assert.equal(migrationFiles.length, 1);
  const migration = await readFile(
    new URL(migrationFiles[0] ?? "", migrationDirectory),
    "utf8",
  );

  const directory = await mkdtemp(join(tmpdir(), "cloudflare-guard-d1-"));
  const databasePath = join(directory, "guard.sqlite");
  let database = new DatabaseSync(databasePath);
  database.exec(migration);
  database.exec(migration);

  let port = new NodeSqliteD1(database);
  let repository = new D1ObservationRepository(port);
  const first = await repository.record(observation, "2026-07-31T00:01:00.000Z");
  assert.equal(first.status, "accepted");
  assert.equal(
    await new D1ReplayStore(port).claim("request:cms-staging-v1:abc", 1_785_456_120),
    true,
  );
  database.close();

  database = new DatabaseSync(databasePath);
  port = new NodeSqliteD1(database);
  repository = new D1ObservationRepository(port);
  const duplicate = await repository.record(
    observation,
    "2026-07-31T00:02:00.000Z",
  );
  assert.equal(duplicate.status, "duplicate");
  assert.deepEqual(
    await repository.findByIdempotencyKey(observation.idempotencyKey),
    observation,
  );
  assert.equal(
    await new D1ReplayStore(port).claim("request:cms-staging-v1:abc", 1_785_456_120),
    false,
  );
  await assert.rejects(
    repository.record(
      { ...observation, status: "pass" },
      "2026-07-31T00:03:00.000Z",
    ),
    /observation_idempotency_conflict/,
  );

  const counts = database
    .prepare(`
      SELECT
        (SELECT COUNT(*) FROM observations) AS observations,
        (SELECT COUNT(*) FROM signal_receipts) AS receipts,
        (SELECT COUNT(*) FROM audit_events) AS audits,
        (SELECT COUNT(*) FROM replay_claims) AS replayClaims
    `)
    .get() as Record<string, number>;
  assert.deepEqual({ ...counts }, {
    observations: 1,
    receipts: 1,
    audits: 1,
    replayClaims: 1,
  });
  database.close();

  const hosting = JSON.parse(
    await readFile(
      new URL("../../.openai/hosting.json", import.meta.url),
      "utf8",
    ),
  ) as Record<string, unknown>;
  assert.equal(hosting.d1, "DB");
});
