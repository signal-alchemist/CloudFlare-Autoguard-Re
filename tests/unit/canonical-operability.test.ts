import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import {
  DatabaseSync,
  type SQLInputValue,
  type StatementSync,
} from "node:sqlite";
import test from "node:test";

import { stableJson } from "../../lib/contracts/ops-signal.ts";
import { incidentFingerprint } from "../../lib/domain/incidents.ts";
import { sha256Hex } from "../../lib/security/safe-output.ts";
import {
  COMPONENT_CATALOG,
  OPERATION_CATALOG,
  loadCanonicalOperabilityFromBindings,
  type GuardReadBindings,
  type ReadOnlyD1DatabasePort,
  type ReadOnlyD1StatementPort,
} from "../../lib/services/canonical-operability.ts";

class ReadOnlyStatement implements ReadOnlyD1StatementPort {
  private readonly database: DatabaseSync;
  private readonly sql: string;
  private readonly statement: StatementSync;
  private readonly values: unknown[];

  constructor(
    database: DatabaseSync,
    sql: string,
    values: unknown[] = [],
  ) {
    assert.match(
      sql.trimStart(),
      /^(?:SELECT|WITH)\b/iu,
      "snapshot repository attempted a non-read SQL statement",
    );
    this.database = database;
    this.sql = sql;
    this.statement = database.prepare(sql);
    this.values = values;
  }

  bind(...values: unknown[]): ReadOnlyD1StatementPort {
    return new ReadOnlyStatement(this.database, this.sql, values);
  }

  async first<T>(): Promise<T | null> {
    return (
      this.statement.get(...(this.values as SQLInputValue[])) as T | undefined
    ) ?? null;
  }

  async all<T>(): Promise<{ success: boolean; results: T[] }> {
    return {
      success: true,
      results: this.statement.all(
        ...(this.values as SQLInputValue[]),
      ) as T[],
    };
  }

  async run(): Promise<never> {
    throw new Error("snapshot_write_forbidden");
  }
}

class ReadOnlyD1 implements ReadOnlyD1DatabasePort {
  readonly sqlite: DatabaseSync;
  prepareCalls = 0;
  batchCalls = 0;
  readonly preparedSql: string[] = [];

  constructor(sqlite: DatabaseSync) {
    this.sqlite = sqlite;
  }

  prepare(sql: string): ReadOnlyD1StatementPort {
    this.prepareCalls += 1;
    this.preparedSql.push(sql);
    return new ReadOnlyStatement(this.sqlite, sql);
  }

  async batch(): Promise<never> {
    this.batchCalls += 1;
    throw new Error("snapshot_batch_forbidden");
  }
}

const now = Date.parse("2026-07-31T08:00:00.000Z");

async function database(): Promise<{
  sqlite: DatabaseSync;
  port: ReadOnlyD1;
}> {
  const sqlite = new DatabaseSync(":memory:");
  const migrationDirectory = new URL("../../drizzle/", import.meta.url);
  const migrations = (await readdir(migrationDirectory))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const migration of migrations) {
    sqlite.exec(await readFile(new URL(migration, migrationDirectory), "utf8"));
  }
  return { sqlite, port: new ReadOnlyD1(sqlite) };
}

function bindings(port: ReadOnlyD1): GuardReadBindings {
  return {
    DB: port,
    GUARD_SITE_ID: "dfconnect",
    GUARD_ENVIRONMENT: "production",
  };
}

function insertHeartbeat(sqlite: DatabaseSync): void {
  sqlite.prepare(`
    INSERT INTO observations (
      observation_id, schema_version, site_id, environment, component,
      check_id, status, reason_code, observed_at, valid_until, source, scope,
      evidence_id, correlation_id, idempotency_key, created_at
    ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `obs_${"a".repeat(32)}`,
    "dfconnect",
    "production",
    "autoguard_control_plane",
    "guard.scheduler.public_delivery",
    "pass",
    "scheduled_cycle_persisted",
    "2026-07-31T07:59:00.000Z",
    "2026-07-31T08:02:00.000Z",
    "autoguard_self",
    "scheduled:dfconnect:production:public-delivery",
    `ev_${"b".repeat(32)}`,
    "scheduled-1785484740000",
    "scheduled:dfconnect:production:1785484740000:guard.scheduler.public_delivery",
    "2026-07-31T07:59:01.000Z",
  );
}

function configuredBindings(port: ReadOnlyD1): GuardReadBindings {
  const secret = "s".repeat(32);
  return {
    ...bindings(port),
    EVIDENCE_BUCKET: {
      async head() {
        return null;
      },
    },
    CONSOLE_AUTH_MODE: "local-development",
    CONSOLE_ACCESS_AUDIENCE: "guard-local-development",
    CMS_GATE_SERVICE_TOKEN: "gate-service-token",
    CMS_GATE_SIGNING_SECRET: secret,
    CMS_SIGNAL_SERVICE_TOKEN: "signal-service-token",
    CMS_SIGNAL_SIGNING_SECRET: secret,
    CMS_POST_DEPLOY_SERVICE_TOKEN: "post-deploy-token",
    CMS_POST_DEPLOY_SIGNING_SECRET: secret,
    CMS_MAINTENANCE_SERVICE_TOKEN: "maintenance-token",
    CMS_MAINTENANCE_SIGNING_SECRET: secret,
    NOTIFICATION_QUEUE: {
      async send() {},
    },
    NOTIFICATION_QUEUE_NAME: "cloudflare-guard-notifications",
    NOTIFICATION_PROVIDER_ENABLED: "true",
    NOTIFICATION_PROVIDER_ENDPOINT:
      "https://alerts.example.test/v1/incidents",
    NOTIFICATION_PROVIDER_TOKEN: "provider-token-0123456789",
  };
}

async function insertOperationalCanaries(sqlite: DatabaseSync): Promise<void> {
  const incidentId = `inc_${"c".repeat(32)}`;
  const identity = {
    siteId: "dfconnect",
    environment: "production" as const,
    component: "public_delivery" as const,
    reasonCode: "secret_token_canary",
    scope: "pii-email-alice.example.test",
  };
  const fingerprint = await incidentFingerprint(identity);
  sqlite.prepare(`
    INSERT INTO incidents (
      incident_id, fingerprint, site_id, environment, component, reason_code,
      scope, severity, state, opened_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    incidentId,
    fingerprint,
    identity.siteId,
    identity.environment,
    identity.component,
    identity.reasonCode,
    identity.scope,
    "sev2",
    "open",
    "2026-07-31T07:55:00.000Z",
    "2026-07-31T07:56:00.000Z",
  );
  sqlite.prepare(`
    INSERT INTO notification_outbox (
      outbox_id, incident_id, observation_id, notification_kind, status,
      payload_json, payload_digest, created_at, updated_at, enqueued_at,
      last_error_code
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `outbox:${incidentId}:incident_opened`,
    incidentId,
    `obs_${"a".repeat(32)}`,
    "incident_opened",
    "pending",
    '{"email":"alice@example.test","token":"super-secret-canary"}',
    "1".repeat(64),
    "2026-07-31T07:56:00.000Z",
    "2026-07-31T07:56:00.000Z",
    null,
    null,
  );
  sqlite.prepare(`
    INSERT INTO notification_deliveries (
      delivery_key, incident_id, payload_digest, provider_code, delivered_at,
      correlation_id
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    `delivery:${incidentId}`,
    incidentId,
    "2".repeat(64),
    "http_204",
    "2026-07-31T07:57:00.000Z",
    "private-correlation-canary",
  );
  sqlite.prepare(`
    INSERT INTO freezes (
      freeze_id, site_id, environment, reason_code, correlation_id,
      activated_at, expires_at, released_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "freeze_seed_active",
    "dfconnect",
    "production",
    "private_freeze_reason_canary",
    "private-freeze-correlation",
    "2026-07-31T07:58:00.000Z",
    "2026-07-31T08:05:00.000Z",
    null,
  );
  sqlite.prepare(`
    INSERT INTO deployment_runtime_identities (
      identity_id, schema_version, site_id, environment, commit_sha,
      worker_version_id, evidence_digest, source_observation_id,
      policy_version, observed_at, valid_until, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `runtime_${"d".repeat(32)}`,
    1,
    "dfconnect",
    "production",
    "e".repeat(40),
    "worker-version-1",
    `sha256:${"f".repeat(64)}`,
    `obs_${"a".repeat(32)}`,
    "deployment-runtime-identity-v1",
    "2026-07-31T07:59:00.000Z",
    "2026-07-31T08:03:00.000Z",
    "2026-07-31T07:59:01.000Z",
  );
  sqlite.prepare(`
    INSERT INTO post_deploy_requests (
      request_id, request_digest, site_id, environment, commit_sha,
      worker_version_id, evidence_digest, requested_at, status, reason_code,
      checked_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "site-deploy-1785484740-1",
    await sha256Hex(
      new TextEncoder().encode(
        stableJson({
          schema: "site-deploy-post-deploy-v1",
          event: "site_deploy.post_deploy_requested",
          requestId: "site-deploy-1785484740-1",
          siteId: "dfconnect",
          environment: "production",
          commitSha: "e".repeat(40),
          workerVersionId: "worker-version-1",
          evidenceDigest: `sha256:${"f".repeat(64)}`,
          requestedAt: 1_785_484_740,
        }),
      ),
    ),
    "dfconnect",
    "production",
    "e".repeat(40),
    "worker-version-1",
    `sha256:${"f".repeat(64)}`,
    1_785_484_740,
    "pass",
    "private_post_deploy_reason_canary",
    1_785_484_770,
    1_785_484_750,
    1_785_484_770,
  );
  sqlite.prepare(`
    INSERT INTO post_deploy_receipts (
      request_id, response_json, response_digest, recorded_at
    ) VALUES (?, ?, ?, ?)
  `).run(
    "site-deploy-1785484740-1",
    '{"private":"receipt-canary"}',
    "4".repeat(64),
    1_785_484_770,
  );
}

test("canonical snapshot is fixed at 8 components/4 gates and policy gaps stay UNKNOWN/DENY without writes", async () => {
  const { sqlite, port } = await database();
  insertHeartbeat(sqlite);
  const beforeChanges = Number(
    (sqlite.prepare("SELECT total_changes() AS value").get() as { value: number })
      .value,
  );

  const result = await loadCanonicalOperabilityFromBindings(
    bindings(port),
    () => now,
  );

  assert.equal(result.schema, "guard-operability-v1");
  assert.equal(result.overall, "unknown");
  assert.deepEqual(
    result.components.map((component) => component.component),
    COMPONENT_CATALOG,
  );
  assert.equal(result.components.length, 8);
  assert.deepEqual(
    result.gates.map((gate) => gate.operation),
    OPERATION_CATALOG,
  );
  assert.equal(result.gates.length, 4);
  assert.ok(result.gates.every((gate) => gate.decision === "deny"));
  for (const component of result.components.filter(
    (item) => item.component !== "public_delivery",
  )) {
    assert.equal(component.state, "unknown");
    assert.deepEqual(component.reasonCodes, ["component_policy_missing"]);
  }
  assert.deepEqual(result.scheduler, {
    state: "fresh_pass",
    reasonCode: "scheduled_cycle_persisted",
    observedAt: "2026-07-31T07:59:00.000Z",
    validUntil: "2026-07-31T08:02:00.000Z",
  });
  assert.equal(port.batchCalls, 0);
  const afterChanges = Number(
    (sqlite.prepare("SELECT total_changes() AS value").get() as { value: number })
      .value,
  );
  assert.equal(afterChanges, beforeChanges);
  assert.doesNotMatch(
    JSON.stringify(result),
    /payload|digest|correlation|requested_by|requester|token|secret|provider-token/u,
  );
  sqlite.close();
});

test("canonical snapshot projects real D1 sections while payload, digest, scope, correlation, and raw reasons never enter the read model", async () => {
  const { sqlite, port } = await database();
  insertHeartbeat(sqlite);
  await insertOperationalCanaries(sqlite);

  const result = await loadCanonicalOperabilityFromBindings(
    configuredBindings(port),
    () => now,
  );

  assert.deepEqual(result.incidents, {
    active: 1,
    truncated: false,
    items: [
      {
        incidentId: `inc_${"c".repeat(32)}`,
        component: "public_delivery",
        severity: "sev2",
        state: "open",
        reasonCode: "incident_active",
        openedAt: "2026-07-31T07:55:00.000Z",
        updatedAt: "2026-07-31T07:56:00.000Z",
      },
    ],
  });
  assert.equal(
    result.components.find(
      (component) => component.component === "public_delivery",
    )?.activeIncidentCount,
    1,
  );
  assert.equal(
    result.components.find(
      (component) => component.component === "public_delivery",
    )?.lastObservedAt,
    null,
  );
  assert.deepEqual(result.notifications, {
    outbox: {
      pending: 1,
      enqueued: 0,
      blocked: 0,
      oldestPendingAt: "2026-07-31T07:56:00.000Z",
    },
    deliveries: {
      total: 1,
      latestDeliveredAt: "2026-07-31T07:57:00.000Z",
    },
  });
  assert.equal(result.freeze.active, true);
  assert.deepEqual(result.freeze.reasonCodes, ["active_freeze"]);
  assert.equal(result.deployment.identity.state, "fresh");
  assert.equal(result.deployment.postDeploy?.status, "pass");
  assert.equal(
    result.deployment.postDeploy?.reasonCode,
    "post_deploy_checks_passed",
  );
  assert.equal(result.scheduler.state, "fresh_pass");
  assert.equal(result.readiness.status, "ready");
  assert.ok(
    result.components.every(
      (component) =>
        typeof component.fresh === "boolean" &&
        Number.isSafeInteger(component.activeIncidentCount),
    ),
  );

  const serialized = JSON.stringify(result);
  assert.doesNotMatch(
    serialized,
    /alice|super-secret|private_|payload|digest|correlation|scope|requester|token/u,
  );
  assert.doesNotMatch(
    port.preparedSql.join("\n"),
    /payload_json|payload_digest/u,
  );
  sqlite.close();
});

test("valid absence is HTTP-safe unknown, while invalid matching rows and D1/schema errors reject", async () => {
  {
    const { sqlite, port } = await database();
    const absent = await loadCanonicalOperabilityFromBindings(
      bindings(port),
      () => now,
    );
    assert.equal(absent.overall, "unknown");
    assert.equal(absent.scheduler.state, "missing");
    assert.ok(absent.gates.every((gate) => gate.decision === "deny"));
    sqlite.close();
  }

  {
    const { sqlite, port } = await database();
    sqlite.prepare(`
      INSERT INTO incidents (
        incident_id, fingerprint, site_id, environment, component, reason_code,
        scope, severity, state, opened_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `inc_${"c".repeat(32)}`,
      "d".repeat(64),
      "dfconnect",
      "production",
      "not_a_component",
      "safe_reason",
      "safe:scope",
      "sev2",
      "open",
      "2026-07-31T07:50:00.000Z",
      "2026-07-31T07:50:00.000Z",
    );
    await assert.rejects(
      loadCanonicalOperabilityFromBindings(bindings(port), () => now),
      /operability_incident_invalid/,
    );
    sqlite.close();
  }

  await assert.rejects(
    loadCanonicalOperabilityFromBindings(
      {
        GUARD_SITE_ID: "dfconnect",
        GUARD_ENVIRONMENT: "production",
      },
      () => now,
    ),
    /operability_binding_unavailable/,
  );

  {
    const emptySqlite = new DatabaseSync(":memory:");
    const emptyPort = new ReadOnlyD1(emptySqlite);
    await assert.rejects(
      loadCanonicalOperabilityFromBindings(
        bindings(emptyPort),
        () => now,
      ),
      /operability_read_unavailable/,
    );
    emptySqlite.close();
  }
});

test("incident items stay bounded, expired freeze history is ignored, and a missing staging policy remains 200-safe UNKNOWN/DENY", async () => {
  const { sqlite, port } = await database();
  const insertIncident = sqlite.prepare(`
    INSERT INTO incidents (
      incident_id, fingerprint, site_id, environment, component, reason_code,
      scope, severity, state, opened_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (let index = 0; index < 101; index += 1) {
    const incidentId = `inc_${index.toString(16).padStart(32, "0")}`;
    const identity = {
      siteId: "dfconnect",
      environment: "production" as const,
      component: "public_delivery" as const,
      reasonCode: "http_status_unexpected",
      scope: `public-delivery-${index}`,
    };
    insertIncident.run(
      incidentId,
      await incidentFingerprint(identity),
      identity.siteId,
      identity.environment,
      identity.component,
      identity.reasonCode,
      identity.scope,
      "sev2",
      "open",
      "2026-07-30T07:00:00.000Z",
      "2026-07-30T07:00:00.000Z",
    );
  }
  const insertFreeze = sqlite.prepare(`
    INSERT INTO freezes (
      freeze_id, site_id, environment, reason_code, correlation_id,
      activated_at, expires_at, released_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (let index = 0; index < 1_025; index += 1) {
    insertFreeze.run(
      `freeze_expired_${index}`,
      "dfconnect",
      "production",
      "expired_history",
      `expired-${index}`,
      "2026-07-30T06:00:00.000Z",
      "2026-07-30T06:05:00.000Z",
      null,
    );
  }

  const production = await loadCanonicalOperabilityFromBindings(
    bindings(port),
    () => now,
  );
  assert.equal(production.incidents.active, 101);
  assert.equal(production.incidents.items.length, 100);
  assert.equal(production.incidents.truncated, true);
  assert.equal(production.freeze.active, false);
  assert.equal(production.freeze.count, 0);

  const staging = await loadCanonicalOperabilityFromBindings(
    {
      ...bindings(port),
      GUARD_ENVIRONMENT: "staging",
    },
    () => now,
  );
  assert.equal(staging.components.length, 8);
  assert.ok(
    staging.components.every(
      (component) =>
        component.state === "unknown" &&
        component.reasonCodes[0] === "component_policy_missing",
    ),
  );
  assert.ok(staging.gates.every((gate) => gate.decision === "deny"));
  assert.equal(staging.readiness.checks.runtimeScopePolicy, "not_ready");
  sqlite.close();
});
