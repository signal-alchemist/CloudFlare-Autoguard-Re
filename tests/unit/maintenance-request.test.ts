import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import {
  DatabaseSync,
  type SQLInputValue,
  type StatementSync,
} from "node:sqlite";
import test from "node:test";

import { resolveOperationalPolicySet } from "../../config/sites/dfconnect.operational-policy.ts";
import {
  buildSignedMaintenanceReceipt,
  canonicalMaintenanceRequest,
  selectMaintenanceCredentialPair,
  signHmacSha256,
  stableJson,
  verifyMaintenanceReceipt,
  type MaintenanceRequest,
  type MaintenanceRequestCredential,
} from "../../lib/contracts/maintenance-request.ts";
import type { ComponentVerdict } from "../../lib/domain/component-verdict.ts";
import { operationComponentMatrix } from "../../lib/domain/gate-policy.ts";
import { handleMaintenanceRequest } from "../../lib/http/maintenance-request.ts";
import { D1MaintenanceRequestRepository } from "../../lib/repositories/maintenance-requests.ts";
import type {
  D1DatabasePort,
  D1PreparedStatementPort,
  D1RunResult,
} from "../../lib/repositories/observations.ts";
import {
  D1OperationalStateRepository,
  type D1AllResult,
  type D1OperationalDatabasePort,
  type D1OperationalStatementPort,
} from "../../lib/repositories/operational-state.ts";
import { sha256Hex } from "../../lib/security/safe-output.ts";
import { createCompatGateProjection } from "../../lib/services/gate-projection.ts";

class NodeSqliteStatement
implements D1PreparedStatementPort, D1OperationalStatementPort {
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

  bind(...values: unknown[]): NodeSqliteStatement {
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

class NodeSqliteD1 implements D1DatabasePort, D1OperationalDatabasePort {
  readonly database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.database = database;
  }

  prepare(sql: string): NodeSqliteStatement {
    return new NodeSqliteStatement(this.database, sql);
  }

  async batch(
    statements: readonly NodeSqliteStatement[],
  ): Promise<D1RunResult[]> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results: D1RunResult[] = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

const signingSecret = "maintenance-signing-secret-0123456789";
const serviceToken = "maintenance-service-token-0123456789";
const nowSeconds = 2_001;
const request: MaintenanceRequest = {
  schema: "maintenance-request-v1",
  event: "maintenance.requested",
  requestId: "maintenance-12345",
  siteId: "dfconnect",
  environment: "production",
  requestedBy: "operator-1",
  reasonCode: "planned-maintenance",
  requestedAt: 2_000,
  expiresAt: 2_900,
};
const credential: MaintenanceRequestCredential = {
  credentialId: "cms-maintenance-production-v1",
  siteId: "dfconnect",
  environment: "production",
  serviceToken,
  signingSecret,
  maxAgeSeconds: 300,
  maxFutureSkewSeconds: 30,
  maxDurationSeconds: 900,
};

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

async function signedRequest(
  candidate: MaintenanceRequest = request,
  overrides: Partial<{
    authorization: string;
    contentType: string;
    rawBody: string;
    signature: string;
  }> = {},
): Promise<Request> {
  const rawBody = overrides.rawBody ?? stableJson(candidate);
  return new Request("https://guard.example/v1/maintenance-requests", {
    method: "POST",
    headers: {
      authorization:
        overrides.authorization ?? `Bearer ${serviceToken}`,
      "content-type": overrides.contentType ?? "application/json",
      "x-dfconnect-signature":
        overrides.signature ??
        (await signHmacSha256(rawBody, signingSecret)),
    },
    body: rawBody,
  });
}

function httpDependencies(port: D1DatabasePort) {
  return {
    credential,
    repository: new D1MaintenanceRequestRepository(port),
    clockSeconds: () => nowSeconds,
  };
}

function healthyVerdicts(): readonly ComponentVerdict[] {
  const components = [
    ...new Set([
      ...operationComponentMatrix.contentPublish,
      ...operationComponentMatrix.siteDeploy,
    ]),
  ];
  return components.map((component) => ({
    schemaVersion: 1,
    policyVersion: "maintenance-gate-fixture-v1",
    siteId: "dfconnect",
    environment: "production",
    component,
    state: "healthy",
    reasonCodes: ["component_all_required_pass"],
    observationIds: [
      `obs_${component.padEnd(32, "0").slice(0, 32)}`,
    ],
    evaluatedAt: new Date(1_990_000).toISOString(),
    freshUntil: new Date(3_000_000).toISOString(),
  }));
}

test("CMS maintenance contract has fixed canonical request and signed receipt vectors", async () => {
  const canonical = canonicalMaintenanceRequest(request);
  assert.equal(
    canonical,
    '{"environment":"production","event":"maintenance.requested","expiresAt":2900,"reasonCode":"planned-maintenance","requestedAt":2000,"requestedBy":"operator-1","requestId":"maintenance-12345","schema":"maintenance-request-v1","siteId":"dfconnect"}',
  );
  assert.equal(
    await signHmacSha256(canonical, signingSecret),
    "hmac-sha256:5c8b71519ad9c6e8957017ff6066a16dfe8c37cc985093b98aa9f8bfedefe41c",
  );

  const receipt = await buildSignedMaintenanceReceipt(
    { requestId: request.requestId, recordedAt: nowSeconds },
    signingSecret,
  );
  assert.deepEqual(Object.keys(receipt).sort(), [
    "event",
    "recordedAt",
    "requestId",
    "schema",
    "signature",
    "status",
  ]);
  assert.equal(
    receipt.signature,
    "hmac-sha256:ff1e77a06a1f47ddd7b26e3e15dce40b8842b42262be114077c7b5e0e230be9e",
  );
  assert.equal(await verifyMaintenanceReceipt(receipt, signingSecret), true);

  assert.deepEqual(
    selectMaintenanceCredentialPair({
      dedicatedServiceToken: serviceToken,
      dedicatedSigningSecret: signingSecret,
      fallbackServiceToken: "gate-service-token-0123456789",
      fallbackSigningSecret: "gate-signing-secret-012345678901",
    }),
    { serviceToken, signingSecret },
  );
  assert.deepEqual(
    selectMaintenanceCredentialPair({
      fallbackServiceToken: "gate-service-token-0123456789",
      fallbackSigningSecret: "gate-signing-secret-012345678901",
    }),
    {
      serviceToken: "gate-service-token-0123456789",
      signingSecret: "gate-signing-secret-012345678901",
    },
  );
  assert.equal(
    selectMaintenanceCredentialPair({
      dedicatedServiceToken: serviceToken,
      fallbackServiceToken: "gate-service-token-0123456789",
      fallbackSigningSecret: "gate-signing-secret-012345678901",
    }),
    null,
  );
  assert.equal(
    selectMaintenanceCredentialPair({
      dedicatedSigningSecret: signingSecret,
      fallbackServiceToken: "gate-service-token-0123456789",
      fallbackSigningSecret: "gate-signing-secret-012345678901",
    }),
    null,
  );
  assert.equal(
    await verifyMaintenanceReceipt(
      { ...receipt, unreviewed: true },
      signingSecret,
    ),
    false,
  );
});

test("maintenance HTTP atomically activates one expiring freeze and is durable, safe, and activate-only", async () => {
  const { sqlite, port } = await database();
  const dependencies = httpDependencies(port);
  assert.equal(
    "release" in new D1MaintenanceRequestRepository(port),
    false,
  );

  const accepted = await handleMaintenanceRequest(
    await signedRequest(),
    dependencies,
  );
  assert.equal(accepted.status, 202);
  assert.equal(accepted.headers.get("cache-control"), "no-store");
  assert.equal(accepted.headers.get("x-content-type-options"), "nosniff");
  const acceptedBody = await accepted.text();
  const parsedReceipt = JSON.parse(acceptedBody);
  assert.equal(
    await verifyMaintenanceReceipt(parsedReceipt, signingSecret),
    true,
  );

  const counts = () => ({
    ...(sqlite.prepare(`
      SELECT
        (SELECT COUNT(*) FROM maintenance_requests) requests,
        (SELECT COUNT(*) FROM freezes) freezes,
        (SELECT COUNT(*) FROM maintenance_request_freezes) links,
        (SELECT COUNT(*) FROM maintenance_receipts) receipts,
        (SELECT COUNT(*) FROM audit_events) audits
    `).get() as Record<string, number>),
  });
  assert.deepEqual(counts(), {
    requests: 1,
    freezes: 1,
    links: 1,
    receipts: 1,
    audits: 1,
  });
  const freeze = {
    ...(sqlite.prepare(`
      SELECT reason_code, correlation_id, activated_at, expires_at, released_at
      FROM freezes
    `).get() as Record<string, unknown>),
  };
  assert.deepEqual(freeze, {
    reason_code: "planned-maintenance",
    correlation_id: "maintenance-12345",
    activated_at: new Date(nowSeconds * 1_000).toISOString(),
    expires_at: new Date(request.expiresAt * 1_000).toISOString(),
    released_at: null,
  });

  const policy = resolveOperationalPolicySet("dfconnect", "production");
  assert.ok(policy);
  const freezeReader = new D1OperationalStateRepository(port, policy);
  const projection = createCompatGateProjection({
    repository: {
      async readVerdicts() {
        return healthyVerdicts();
      },
      async hasActiveFreeze(input) {
        return freezeReader.hasActiveFreeze(input);
      },
    },
    clock: () => nowSeconds * 1_000,
  });
  const frozen = await projection.read({
    siteId: "dfconnect",
    environment: "production",
    nowSeconds,
  });
  assert.equal(frozen.freeze, true);
  assert.deepEqual(frozen.gates, {
    contentPublish: "deny",
    siteDeploy: "deny",
  });

  const duplicate = await handleMaintenanceRequest(
    await signedRequest(),
    {
      ...dependencies,
      repository: new D1MaintenanceRequestRepository(port),
    },
  );
  assert.equal(duplicate.status, 200);
  assert.equal(await duplicate.text(), acceptedBody);
  assert.deepEqual(counts(), {
    requests: 1,
    freezes: 1,
    links: 1,
    receipts: 1,
    audits: 1,
  });
  assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
  assert.throws(
    () => sqlite.prepare("DELETE FROM freezes").run(),
    /FOREIGN KEY constraint failed/u,
  );

  const conflict = await handleMaintenanceRequest(
    await signedRequest({ ...request, reasonCode: "changed-maintenance" }),
    dependencies,
  );
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), {
    error: "idempotency_conflict",
  });
  assert.deepEqual(counts(), {
    requests: 1,
    freezes: 1,
    links: 1,
    receipts: 1,
    audits: 1,
  });

  const expiredFreeze = sqlite.prepare(`
    INSERT INTO freezes (
      freeze_id, site_id, environment, reason_code, correlation_id,
      activated_at, expires_at, released_at
    ) VALUES (?, 'dfconnect', 'production', 'historical-maintenance', ?,
      '1970-01-01T00:00:01.000Z', '1970-01-01T00:00:02.000Z', NULL)
  `);
  sqlite.exec("BEGIN IMMEDIATE");
  try {
    for (let index = 0; index < 1_025; index += 1) {
      expiredFreeze.run(
        `freeze_historical_${index}`,
        `maintenance_historical_${index}`,
      );
    }
    sqlite.exec("COMMIT");
  } catch (error) {
    sqlite.exec("ROLLBACK");
    throw error;
  }
  const expiredProjection = createCompatGateProjection({
    repository: {
      async readVerdicts() {
        return healthyVerdicts();
      },
      async hasActiveFreeze(input) {
        return freezeReader.hasActiveFreeze(input);
      },
    },
    clock: () => request.expiresAt * 1_000,
  });
  const expired = await expiredProjection.read({
    siteId: "dfconnect",
    environment: "production",
    nowSeconds: request.expiresAt,
  });
  assert.equal(expired.freeze, false);
  assert.deepEqual(expired.gates, {
    contentPublish: "allow",
    siteDeploy: "allow",
  });

  const nonCanonical = JSON.stringify(request);
  assert.equal(
    (
      await handleMaintenanceRequest(
        await signedRequest(request, { rawBody: nonCanonical }),
        dependencies,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await handleMaintenanceRequest(
        await signedRequest(request, {
          authorization: "Bearer wrong-service-token-0123456789",
        }),
        dependencies,
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await handleMaintenanceRequest(
        await signedRequest(request, {
          signature: `hmac-sha256:${"0".repeat(64)}`,
        }),
        dependencies,
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await handleMaintenanceRequest(
        await signedRequest({ ...request, environment: "staging" }),
        dependencies,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await handleMaintenanceRequest(
        await signedRequest(request, { contentType: "application/json; charset=utf-8" }),
        dependencies,
      )
    ).status,
    415,
  );
  const wrongMethod = await handleMaintenanceRequest(
    new Request("https://guard.example/v1/maintenance-requests", {
      method: "PATCH",
    }),
    dependencies,
  );
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "POST");
  const oversized = await handleMaintenanceRequest(
    new Request("https://guard.example/v1/maintenance-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(64 * 1_024 + 1),
    }),
    dependencies,
  );
  assert.equal(oversized.status, 413);

  const invalidDurations = [
    { ...request, requestId: "maintenance-expired", expiresAt: nowSeconds },
    { ...request, requestId: "maintenance-long", expiresAt: 2_901 },
    { ...request, requestId: "maintenance-future", requestedAt: 2_032, expiresAt: 2_900 },
    { ...request, requestId: "maintenance-stale", requestedAt: 1_700, expiresAt: 2_100 },
  ];
  for (const candidate of invalidDurations) {
    const response = await handleMaintenanceRequest(
      await signedRequest(candidate),
      dependencies,
    );
    assert.equal(response.status, 400);
  }
  const unknownField = await handleMaintenanceRequest(
    await signedRequest(
      { ...request, requestId: "maintenance-unknown", extra: true } as
        MaintenanceRequest,
    ),
    dependencies,
  );
  assert.equal(unknownField.status, 400);
  const invalidConfiguration = await handleMaintenanceRequest(
    await signedRequest({
      ...request,
      requestId: "maintenance-config",
    }),
    {
      ...dependencies,
      credential: {
        ...credential,
        serviceToken: "too-short",
      },
    },
  );
  assert.equal(invalidConfiguration.status, 503);

  const unavailableDatabase: D1DatabasePort = {
    prepare() {
      throw new Error("D1 internal detail must not escape");
    },
    async batch() {
      throw new Error("D1 internal detail must not escape");
    },
  };
  const unavailable = await handleMaintenanceRequest(
    await signedRequest({
      ...request,
      requestId: "maintenance-unavailable",
    }),
    httpDependencies(unavailableDatabase),
  );
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), {
    error: "service_unavailable",
  });
  assert.equal(unavailable.headers.get("cache-control"), "no-store");
  assert.equal(unavailable.headers.get("x-content-type-options"), "nosniff");

  sqlite.prepare(`
    UPDATE maintenance_receipts
    SET response_json = '{"corrupt":true}'
    WHERE request_id = ?1
  `).run(request.requestId);
  const corrupt = await handleMaintenanceRequest(
    await signedRequest(),
    dependencies,
  );
  assert.equal(corrupt.status, 503);
  assert.deepEqual(await corrupt.json(), {
    error: "service_unavailable",
  });

  sqlite.close();
});

test("maintenance D1 batch rolls back the request when a dependent write fails", async () => {
  const { sqlite, port } = await database();
  const rawBody = canonicalMaintenanceRequest(request);
  const digest = await sha256Hex(new TextEncoder().encode(rawBody));
  sqlite.prepare(`
    INSERT INTO freezes (
      freeze_id, site_id, environment, reason_code, correlation_id,
      activated_at, expires_at, released_at
    ) VALUES (?1, 'dfconnect', 'production', 'collision',
      'unrelated', ?2, ?3, NULL)
  `).run(
    `freeze_${digest.slice(0, 32)}`,
    new Date(nowSeconds * 1_000).toISOString(),
    new Date(request.expiresAt * 1_000).toISOString(),
  );

  const response = await handleMaintenanceRequest(
    await signedRequest(),
    httpDependencies(port),
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "service_unavailable",
  });
  assert.deepEqual(
    {
      ...(sqlite.prepare(`
        SELECT
          (SELECT COUNT(*) FROM maintenance_requests) requests,
          (SELECT COUNT(*) FROM maintenance_request_freezes) links,
          (SELECT COUNT(*) FROM maintenance_receipts) receipts,
          (SELECT COUNT(*) FROM audit_events) audits
      `).get() as Record<string, number>),
    },
    { requests: 0, links: 0, receipts: 0, audits: 0 },
  );
  sqlite.close();
});
