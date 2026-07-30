import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import {
  DatabaseSync,
  type SQLInputValue,
  type StatementSync,
} from "node:sqlite";
import test from "node:test";

import { dfconnectProductionOperationalPolicy } from "../../config/sites/dfconnect.operational-policy.ts";
import type {
  Component,
  Observation,
} from "../../lib/contracts/ops-signal.ts";
import {
  evaluateComponentVerdict,
  type ComponentPolicyV1,
} from "../../lib/domain/component-verdict.ts";
import { operationComponentMatrix } from "../../lib/domain/gate-policy.ts";
import {
  D1OperationalStateRepository,
  type D1AllResult,
  type D1OperationalDatabasePort,
  type D1OperationalStatementPort,
  type OperationalPolicySetV1,
} from "../../lib/repositories/operational-state.ts";
import type { D1RunResult } from "../../lib/repositories/observations.ts";
import { createCompatGateProjection } from "../../lib/services/gate-projection.ts";

class NodeSqliteStatement implements D1OperationalStatementPort {
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

  bind(...values: unknown[]): D1OperationalStatementPort {
    return new NodeSqliteStatement(this.database, this.sql, values);
  }

  async first<T>(): Promise<T | null> {
    return (
      this.statement.get(...(this.values as SQLInputValue[])) as T | undefined
    ) ?? null;
  }

  async all<T>(): Promise<D1AllResult<T>> {
    return {
      success: true,
      results: this.statement.all(
        ...(this.values as SQLInputValue[]),
      ) as T[],
    };
  }

  async run(): Promise<D1RunResult> {
    const result = this.statement.run(...(this.values as SQLInputValue[]));
    return {
      success: true,
      meta: { changes: Number(result.changes) },
    };
  }
}

class NodeSqliteD1 implements D1OperationalDatabasePort {
  readonly database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.database = database;
  }

  prepare(sql: string): D1OperationalStatementPort {
    return new NodeSqliteStatement(this.database, sql);
  }

  async batch(
    statements: readonly D1OperationalStatementPort[],
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

const baseNow = Date.parse("2026-07-31T08:00:00.000Z");
const gateComponents = [
  ...new Set<Component>([
    ...operationComponentMatrix.contentPublish,
    ...operationComponentMatrix.siteDeploy,
  ]),
].sort((left, right) => left.localeCompare(right));

const fixturePolicies: readonly ComponentPolicyV1[] = gateComponents.map(
  (component) => ({
    schemaVersion: 1,
    policyVersion: `fixture-${component}-v1`,
    siteId: "dfconnect",
    environment: "production",
    component,
    checks: [
      {
        checkId: `fixture.${component}`,
        requiredSources: ["autoguard_self"],
        failureQuorum: 1,
        maxValiditySeconds: 180,
        maxFutureSkewSeconds: 30,
      },
    ],
  }),
);

const fixturePolicySet: OperationalPolicySetV1 = {
  schemaVersion: 1,
  policySetVersion: "fixture-gate-v1",
  siteId: "dfconnect",
  environment: "production",
  components: fixturePolicies,
};

async function database(): Promise<{
  sqlite: DatabaseSync;
  port: NodeSqliteD1;
}> {
  const sqlite = new DatabaseSync(":memory:");
  const migrationDirectory = new URL("../../drizzle/", import.meta.url);
  const migrationFiles = (await readdir(migrationDirectory))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const file of migrationFiles) {
    sqlite.exec(
      await readFile(new URL(file, migrationDirectory), "utf8"),
    );
  }
  return { sqlite, port: new NodeSqliteD1(sqlite) };
}

function insertObservation(
  sqlite: DatabaseSync,
  component: Component,
  sequence: number,
  overrides: Partial<{
    siteId: string;
    environment: "staging" | "production";
    checkId: string;
    status: string;
    source: string;
    observedAt: string;
    validUntil: string;
    schemaVersion: number;
  }> = {},
): void {
  const hex = sequence.toString(16).padStart(32, "0");
  sqlite
    .prepare(
      `
        INSERT INTO observations (
          observation_id, schema_version, site_id, environment, component,
          check_id, status, reason_code, observed_at, valid_until, source,
          scope, evidence_id, correlation_id, idempotency_key, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      `obs_${hex}`,
      overrides.schemaVersion ?? 1,
      overrides.siteId ?? "dfconnect",
      overrides.environment ?? "production",
      component,
      overrides.checkId ?? `fixture.${component}`,
      overrides.status ?? "pass",
      `fixture_${overrides.status ?? "pass"}`,
      overrides.observedAt ?? "2026-07-31T07:59:00.000Z",
      overrides.validUntil ?? "2026-07-31T08:02:00.000Z",
      overrides.source ?? "autoguard_self",
      `fixture:${component}`,
      `ev_${hex}`,
      `correlation_${sequence}`,
      `fixture:dfconnect:production:${component}:${hex}`,
      "2026-07-31T07:59:01.000Z",
    );
}

function insertHealthySet(
  sqlite: DatabaseSync,
  validUntil = "2026-07-31T08:02:00.000Z",
): void {
  gateComponents.forEach((component, index) => {
    insertObservation(sqlite, component, index + 1, { validUntil });
  });
}

function projection(
  repository: D1OperationalStateRepository,
  clock: () => number,
) {
  return createCompatGateProjection({ repository, clock });
}

async function readGate(
  repository: D1OperationalStateRepository,
  nowMs: number,
) {
  return projection(repository, () => nowMs).read({
    siteId: "dfconnect",
    environment: "production",
    nowSeconds: Math.floor(nowMs / 1_000),
  });
}

test("D1 latest Observation materializes scoped fresh Verdicts and active expiring freeze into fail-closed Gate state", async () => {
  assert.equal(
    dfconnectProductionOperationalPolicy.siteId,
    "dfconnect",
  );
  assert.equal(
    dfconnectProductionOperationalPolicy.environment,
    "production",
  );
  assert.deepEqual(
    dfconnectProductionOperationalPolicy.components[0]?.checks.map(
      (check) => check.requiredSources,
    ),
    Array.from(
      { length: 9 },
      () => ["public_probe", "external_probe"] as const,
    ),
  );

  {
    const { sqlite, port } = await database();
    insertHealthySet(sqlite);
    insertObservation(sqlite, "public_delivery", 100, {
      siteId: "another",
      status: "fail",
      observedAt: "2026-07-31T08:00:00.000Z",
      validUntil: "2026-07-31T08:03:00.000Z",
    });
    insertObservation(sqlite, "public_delivery", 101, {
      environment: "staging",
      status: "fail",
      observedAt: "2026-07-31T08:00:00.000Z",
      validUntil: "2026-07-31T08:03:00.000Z",
    });
    insertObservation(sqlite, "public_delivery", 102, {
      checkId: "fixture.not-allowed",
      status: "fail",
      observedAt: "2026-07-31T08:00:00.000Z",
      validUntil: "2026-07-31T08:03:00.000Z",
    });
    insertObservation(sqlite, "public_delivery", 103, {
      source: "provider_api",
      status: "fail",
      observedAt: "2026-07-31T08:00:00.000Z",
      validUntil: "2026-07-31T08:03:00.000Z",
    });
    const repository = new D1OperationalStateRepository(
      port,
      fixturePolicySet,
    );
    const healthy = await readGate(repository, baseNow);
    assert.deepEqual(healthy.gates, {
      contentPublish: "allow",
      siteDeploy: "allow",
    });
    assert.equal(healthy.freeze, false);

    const persisted = sqlite
      .prepare(
        `
          SELECT component, state, policy_version, reason_codes_json,
            observation_ids_json, fresh_until
          FROM component_verdicts
          WHERE site_id = ? AND environment = ?
          ORDER BY component
        `,
      )
      .all("dfconnect", "production") as Record<string, unknown>[];
    assert.equal(persisted.length, gateComponents.length);
    assert.ok(persisted.every((row) => row.state === "healthy"));
    assert.ok(
      persisted.every(
        (row) => row.reason_codes_json ===
          '["component_all_required_pass"]',
      ),
    );
    assert.ok(
      persisted.every(
        (row) => row.fresh_until === "2026-07-31T08:02:00.000Z",
      ),
    );
    assert.ok(
      persisted.every(
        (row) =>
          Array.isArray(JSON.parse(String(row.observation_ids_json))),
      ),
    );

    await assert.rejects(
      repository.readVerdicts({
        siteId: "dfconnect",
        environment: "staging",
        nowMs: baseNow,
      }),
      /operational_state_scope_invalid/,
    );

    sqlite
      .prepare(
        `
          INSERT INTO freezes (
            freeze_id, site_id, environment, reason_code, correlation_id,
            activated_at, expires_at, released_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
        `,
      )
      .run(
        "freeze_staging",
        "dfconnect",
        "staging",
        "maintenance",
        "correlation_staging",
        "2026-07-31T07:55:00.000Z",
        "2026-07-31T08:05:00.000Z",
      );
    sqlite
      .prepare(
        `
          INSERT INTO freezes (
            freeze_id, site_id, environment, reason_code, correlation_id,
            activated_at, expires_at, released_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
        `,
      )
      .run(
        "freeze_expired",
        "dfconnect",
        "production",
        "maintenance",
        "correlation_expired",
        "2026-07-31T07:50:00.000Z",
        "2026-07-31T07:59:59.000Z",
      );
    assert.equal((await readGate(repository, baseNow)).freeze, false);

    sqlite
      .prepare(
        `
          INSERT INTO freezes (
            freeze_id, site_id, environment, reason_code, correlation_id,
            activated_at, expires_at, released_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
        `,
      )
      .run(
        "freeze_production",
        "dfconnect",
        "production",
        "maintenance",
        "correlation_production",
        "2026-07-31T07:59:00.000Z",
        "2026-07-31T08:05:00.000Z",
      );
    const frozen = await readGate(repository, baseNow);
    assert.equal(frozen.freeze, true);
    assert.deepEqual(frozen.gates, {
      contentPublish: "deny",
      siteDeploy: "deny",
    });
    sqlite.close();
  }

  {
    const { sqlite, port } = await database();
    insertHealthySet(sqlite);
    sqlite
      .prepare(
        `
          INSERT INTO freezes (
            freeze_id, site_id, environment, reason_code, correlation_id,
            activated_at, expires_at, released_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
        `,
      )
      .run(
        "freeze_corrupt",
        "dfconnect",
        "production",
        "maintenance",
        "correlation_corrupt",
        "2026-07-31T07:59:00.000Z",
        "not-an-iso-date",
      );
    const repository = new D1OperationalStateRepository(
      port,
      fixturePolicySet,
    );
    const corruptFreeze = await readGate(repository, baseNow);
    assert.deepEqual(corruptFreeze.gates, {
      contentPublish: "deny",
      siteDeploy: "deny",
    });
    sqlite.close();
  }

  {
    const { sqlite, port } = await database();
    insertHealthySet(sqlite);
    sqlite.exec("BEGIN IMMEDIATE");
    try {
      for (let index = 0; index < 4_096; index += 1) {
        insertObservation(sqlite, "public_delivery", 1_000 + index);
      }
      sqlite.exec("COMMIT");
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    }
    const repository = new D1OperationalStateRepository(
      port,
      fixturePolicySet,
    );
    await assert.rejects(
      repository.readVerdicts({
        siteId: "dfconnect",
        environment: "production",
        nowMs: baseNow,
      }),
      /operational_observation_read_failed/,
    );
    assert.equal(
      (await readGate(repository, baseNow)).gates.contentPublish,
      "deny",
    );
    sqlite.close();
  }

  {
    const { sqlite, port } = await database();
    insertHealthySet(sqlite);
    const statement = sqlite.prepare(
      `
        INSERT INTO freezes (
          freeze_id, site_id, environment, reason_code, correlation_id,
          activated_at, expires_at, released_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
      `,
    );
    sqlite.exec("BEGIN IMMEDIATE");
    try {
      for (let index = 0; index < 1_025; index += 1) {
        statement.run(
          `freeze_limit_${index}`,
          "dfconnect",
          "production",
          "maintenance",
          `correlation_limit_${index}`,
          "2026-07-31T07:59:00.000Z",
          "2026-07-31T08:05:00.000Z",
        );
      }
      sqlite.exec("COMMIT");
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    }
    const repository = new D1OperationalStateRepository(
      port,
      fixturePolicySet,
    );
    await assert.rejects(
      repository.hasActiveFreeze({
        siteId: "dfconnect",
        environment: "production",
        nowMs: baseNow,
      }),
      /operational_freeze_read_failed/,
    );
    assert.equal(
      (await readGate(repository, baseNow)).gates.siteDeploy,
      "deny",
    );
    sqlite.close();
  }

  {
    const { sqlite, port } = await database();
    insertHealthySet(sqlite, "2026-07-31T08:00:30.000Z");
    const repository = new D1OperationalStateRepository(
      port,
      fixturePolicySet,
    );
    assert.equal(
      (await readGate(repository, baseNow)).gates.siteDeploy,
      "allow",
    );
    const afterFreshness = await readGate(
      repository,
      Date.parse("2026-07-31T08:00:31.000Z"),
    );
    assert.deepEqual(afterFreshness.gates, {
      contentPublish: "deny",
      siteDeploy: "deny",
    });
    const stale = sqlite
      .prepare(
        `
          SELECT state, fresh_until
          FROM component_verdicts
          WHERE site_id = ? AND environment = ?
        `,
      )
      .all("dfconnect", "production") as {
        state: string;
        fresh_until: string | null;
      }[];
    assert.ok(stale.every((row) => row.state === "unknown"));
    assert.ok(stale.every((row) => row.fresh_until === null));
    sqlite.close();
  }

  {
    const { sqlite, port } = await database();
    insertHealthySet(sqlite);
    sqlite
      .prepare(
        `
          DELETE FROM observations
          WHERE site_id = ? AND environment = ? AND component = ?
        `,
      )
      .run("dfconnect", "production", "public_delivery");
    const repository = new D1OperationalStateRepository(
      port,
      fixturePolicySet,
    );
    const missing = await readGate(repository, baseNow);
    assert.equal(missing.gates.contentPublish, "deny");
    assert.equal(
      sqlite
        .prepare(
          `
            SELECT state
            FROM component_verdicts
            WHERE site_id = ? AND environment = ? AND component = ?
          `,
        )
        .get("dfconnect", "production", "public_delivery")
        ?.state,
      "unknown",
    );
    sqlite.close();
  }

  {
    const { sqlite, port } = await database();
    insertHealthySet(sqlite);
    insertObservation(sqlite, "public_delivery", 250, {
      observedAt: "2026-07-31T08:00:31.000Z",
      validUntil: "2026-07-31T08:03:00.000Z",
    });
    const repository = new D1OperationalStateRepository(
      port,
      fixturePolicySet,
    );
    const future = await readGate(repository, baseNow);
    assert.equal(future.gates.contentPublish, "deny");
    assert.equal(
      sqlite
        .prepare(
          `
            SELECT state
            FROM component_verdicts
            WHERE site_id = ? AND environment = ? AND component = ?
          `,
        )
        .get("dfconnect", "production", "public_delivery")
        ?.state,
      "unknown",
    );
    sqlite.close();
  }

  {
    const { sqlite, port } = await database();
    insertHealthySet(sqlite);
    insertObservation(sqlite, "public_delivery", 201, {
      status: "pass",
      observedAt: "2026-07-31T08:00:10.000Z",
      validUntil: "2026-07-31T08:02:10.000Z",
    });
    insertObservation(sqlite, "public_delivery", 202, {
      status: "fail",
      observedAt: "2026-07-31T08:00:10.000Z",
      validUntil: "2026-07-31T08:02:10.000Z",
    });
    const repository = new D1OperationalStateRepository(
      port,
      fixturePolicySet,
    );
    const conflict = await readGate(
      repository,
      Date.parse("2026-07-31T08:00:20.000Z"),
    );
    assert.equal(conflict.gates.contentPublish, "deny");
    assert.equal(
      sqlite
        .prepare(
          `
            SELECT state
            FROM component_verdicts
            WHERE site_id = ? AND environment = ?
              AND component = ?
          `,
        )
        .get("dfconnect", "production", "public_delivery")
        ?.state,
      "unknown",
    );
    sqlite.close();
  }

  {
    const { sqlite, port } = await database();
    insertHealthySet(sqlite);
    insertObservation(sqlite, "public_delivery", 301, {
      status: "garbage",
      schemaVersion: 1,
      observedAt: "2026-07-31T08:00:00.000Z",
      validUntil: "2026-07-31T08:02:00.000Z",
    });
    const repository = new D1OperationalStateRepository(
      port,
      fixturePolicySet,
    );
    const invalid = await readGate(repository, baseNow);
    assert.deepEqual(invalid.gates, {
      contentPublish: "deny",
      siteDeploy: "deny",
    });
    sqlite.close();
  }

  {
    const policy = fixturePolicies[0]!;
    const invalidStatus = {
      schemaVersion: 1,
      observationId: `obs_${"f".repeat(32)}`,
      siteId: policy.siteId,
      environment: policy.environment,
      component: policy.component,
      checkId: policy.checks[0]!.checkId,
      status: "garbage",
      reasonCode: "invalid_status",
      observedAt: "2026-07-31T07:59:00.000Z",
      validUntil: "2026-07-31T08:02:00.000Z",
      source: "autoguard_self",
      scope: "fixture:invalid",
      evidenceId: `ev_${"f".repeat(32)}`,
      correlationId: "correlation_invalid",
      idempotencyKey: `fixture:${"f".repeat(64)}`,
    } as unknown as Observation;
    assert.equal(
      evaluateComponentVerdict(policy, [invalidStatus], baseNow).state,
      "unknown",
    );
    assert.equal(
      evaluateComponentVerdict(
        policy,
        [
          {
            ...invalidStatus,
            schemaVersion: 999,
            status: "pass",
          } as unknown as Observation,
        ],
        baseNow,
      ).state,
      "unknown",
    );
  }

  {
    const { sqlite, port } = await database();
    insertHealthySet(sqlite);
    const repository = new D1OperationalStateRepository(
      port,
      fixturePolicySet,
    );
    sqlite.close();
    const denied = await readGate(repository, baseNow);
    assert.deepEqual(denied.gates, {
      contentPublish: "deny",
      siteDeploy: "deny",
    });
  }
});
