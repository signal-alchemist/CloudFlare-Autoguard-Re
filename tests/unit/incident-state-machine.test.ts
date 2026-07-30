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
  incidentFingerprint,
  type IncidentIdentity,
  type IncidentResolutionPolicy,
} from "../../lib/domain/incidents.ts";
import { D1IncidentRepository } from "../../lib/repositories/incidents.ts";
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

const identity: IncidentIdentity = {
  siteId: "dfconnect",
  environment: "production",
  component: "public_delivery",
  reasonCode: "http_status_unexpected",
  scope: "https://dfconnect.jp/",
};

const resolutionPolicy: IncidentResolutionPolicy = {
  minimumConsecutiveHealthy: {
    sev1: 2,
    sev2: 2,
    sev3: 1,
    sev4: 1,
  },
  requiredSources: ["public_probe", "external_probe"],
};

test("incident fingerprint, D1 dedupe, transitions, and guarded resolution survive restart", async () => {
  assert.equal(
    await incidentFingerprint(identity),
    "b979338a45b689508000807682835a21885632c398f599c4d88b76bafeed6752",
  );

  const variants: IncidentIdentity[] = [
    { ...identity, siteId: "another" },
    { ...identity, environment: "staging" },
    { ...identity, component: "editorial" },
    { ...identity, reasonCode: "http_marker_missing" },
    { ...identity, scope: "https://dfconnect.jp/pricing/" },
  ];
  const variantFingerprints = await Promise.all(
    variants.map(incidentFingerprint),
  );
  assert.equal(new Set(variantFingerprints).size, variants.length);
  assert.ok(
    variantFingerprints.every((value) => /^[a-f0-9]{64}$/u.test(value)),
  );

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
  const directory = await mkdtemp(join(tmpdir(), "cloudflare-guard-inc-"));
  const databasePath = join(directory, "guard.sqlite");
  let database = new DatabaseSync(databasePath);
  database.exec(migrations);
  let repository = new D1IncidentRepository(new NodeSqliteD1(database));

  const first = await repository.recordFailure({
    identity,
    severity: "sev1",
    observationId: "obs_failure_000000000000000000001",
    observationIdempotencyKey: "observation:failure:one",
    correlationId: "probe-run-incident-1",
    occurredAt: "2026-07-31T03:00:00.000Z",
  });
  const second = await repository.recordFailure({
    identity,
    severity: "sev1",
    observationId: "obs_failure_000000000000000000002",
    observationIdempotencyKey: "observation:failure:two",
    correlationId: "probe-run-incident-2",
    occurredAt: "2026-07-31T03:01:00.000Z",
  });
  const duplicate = await repository.recordFailure({
    identity,
    severity: "sev1",
    observationId: "obs_failure_000000000000000000001",
    observationIdempotencyKey: "observation:failure:one",
    correlationId: "probe-run-incident-1",
    occurredAt: "2026-07-31T03:00:00.000Z",
  });
  assert.equal(first.status, "created");
  assert.equal(second.status, "existing");
  assert.equal(duplicate.status, "duplicate");
  assert.equal(first.incident.incidentId, second.incident.incidentId);
  assert.equal(first.incident.incidentId, duplicate.incident.incidentId);
  assert.deepEqual(
    {
      ...(database
      .prepare(
        "SELECT (SELECT COUNT(*) FROM incidents) incidents, (SELECT COUNT(*) FROM incident_timeline) timeline",
      )
      .get() as Record<string, number>),
    },
    { incidents: 1, timeline: 2 },
  );

  database.close();
  database = new DatabaseSync(databasePath);
  repository = new D1IncidentRepository(new NodeSqliteD1(database));
  const restored = await repository.findByFingerprint(
    await incidentFingerprint(identity),
  );
  assert.equal(restored?.state, "open");

  await assert.rejects(
    repository.transition(
      {
        incidentId: first.incident.incidentId,
        toState: "resolved",
        idempotencyKey: "transition:skip-to-resolved",
        correlationId: "operator-1",
        occurredAt: "2026-07-31T03:02:00.000Z",
        resolutionEvidence: {
          consecutiveHealthyResults: 2,
          sources: ["public_probe", "external_probe"],
          humanAcknowledged: true,
        },
      },
      resolutionPolicy,
    ),
    /incident_transition_invalid/,
  );

  await repository.transition(
    {
      incidentId: first.incident.incidentId,
      toState: "acknowledged",
      idempotencyKey: "transition:ack",
      correlationId: "operator-1",
      occurredAt: "2026-07-31T03:03:00.000Z",
    },
    resolutionPolicy,
  );
  await repository.transition(
    {
      incidentId: first.incident.incidentId,
      toState: "mitigating",
      idempotencyKey: "transition:mitigating",
      correlationId: "operator-1",
      occurredAt: "2026-07-31T03:04:00.000Z",
    },
    resolutionPolicy,
  );
  await repository.transition(
    {
      incidentId: first.incident.incidentId,
      toState: "monitoring",
      idempotencyKey: "transition:monitoring",
      correlationId: "operator-1",
      occurredAt: "2026-07-31T03:05:00.000Z",
    },
    resolutionPolicy,
  );

  const weakResolution = {
    incidentId: first.incident.incidentId,
    toState: "resolved" as const,
    idempotencyKey: "transition:weak-resolution",
    correlationId: "operator-1",
    occurredAt: "2026-07-31T03:06:00.000Z",
    resolutionEvidence: {
      consecutiveHealthyResults: 1,
      sources: ["public_probe", "external_probe"] as const,
      humanAcknowledged: true,
    },
  };
  await assert.rejects(
    repository.transition(weakResolution, resolutionPolicy),
    /incident_resolution_evidence_insufficient/,
  );
  assert.equal(
    (await repository.findById(first.incident.incidentId))?.state,
    "monitoring",
  );

  const resolveCommand = {
    ...weakResolution,
    idempotencyKey: "transition:resolved",
    occurredAt: "2026-07-31T03:07:00.000Z",
    resolutionEvidence: {
      ...weakResolution.resolutionEvidence,
      consecutiveHealthyResults: 2,
    },
  };
  const resolved = await repository.transition(
    resolveCommand,
    resolutionPolicy,
  );
  const repeatedResolution = await repository.transition(
    resolveCommand,
    resolutionPolicy,
  );
  assert.equal(resolved.state, "resolved");
  assert.deepEqual(repeatedResolution, resolved);
  assert.equal(
    (
      database
        .prepare("SELECT COUNT(*) AS count FROM incident_timeline")
        .get() as { count: number }
    ).count,
    6,
  );
  await assert.rejects(
    repository.transition(
      {
        incidentId: first.incident.incidentId,
        toState: "mitigating",
        idempotencyKey: "transition:after-resolved",
        correlationId: "operator-1",
        occurredAt: "2026-07-31T03:08:00.000Z",
      },
      resolutionPolicy,
    ),
    /incident_transition_invalid/,
  );
  database.close();
});
