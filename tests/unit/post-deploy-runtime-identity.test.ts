import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import {
  DatabaseSync,
  type SQLInputValue,
  type StatementSync,
} from "node:sqlite";
import test from "node:test";

import {
  signHmacSha256,
  stableJson,
  type Component,
} from "../../lib/contracts/ops-signal.ts";
import {
  verifyPostDeployVerdict,
  type PostDeployRequest,
} from "../../lib/contracts/post-deploy.ts";
import type { DeploymentRuntimeIdentity } from "../../lib/domain/deployment-runtime-identity.ts";
import type { ComponentVerdict } from "../../lib/domain/component-verdict.ts";
import { operationComponentMatrix } from "../../lib/domain/gate-policy.ts";
import { handlePostDeployRequest } from "../../lib/http/post-deploy.ts";
import {
  D1DeploymentRuntimeIdentityRepository,
} from "../../lib/repositories/deployment-runtime-identities.ts";
import {
  D1PostDeployRepository,
} from "../../lib/repositories/post-deploy.ts";
import type {
  D1DatabasePort,
  D1PreparedStatementPort,
  D1RunResult,
} from "../../lib/repositories/observations.ts";
import {
  createPostDeployOperationalChecker,
  type OperationalStateRepository,
} from "../../lib/services/gate-projection.ts";

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
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

const nowSeconds = 2_000;
const nowMs = nowSeconds * 1_000;
const signingSecret = "post-deploy-signing-secret-0123456789";
const serviceToken = "post-deploy-service-token-0123456789";
const workerVersionId = "1abc2345-def6-7890-abcd-ef1234567890";

function iso(seconds: number): string {
  return new Date(seconds * 1_000).toISOString();
}

function request(
  requestId = "site-deploy-25000-1",
  overrides: Partial<PostDeployRequest> = {},
): PostDeployRequest {
  return {
    schema: "site-deploy-post-deploy-v1",
    event: "site_deploy.post_deploy_requested",
    requestId,
    siteId: "dfconnect",
    environment: "staging",
    commitSha: "a".repeat(40),
    workerVersionId,
    evidenceDigest: `sha256:${"b".repeat(64)}`,
    requestedAt: nowSeconds,
    ...overrides,
  };
}

function identity(
  overrides: Partial<DeploymentRuntimeIdentity> = {},
): DeploymentRuntimeIdentity {
  return {
    schemaVersion: 1,
    identityId: "runtime_0123456789abcdef0123456789abcdef",
    siteId: "dfconnect",
    environment: "staging",
    commitSha: "a".repeat(40),
    workerVersionId,
    evidenceDigest: `sha256:${"b".repeat(64)}`,
    sourceObservationId: "obs_0123456789abcdef0123456789abcdef",
    policyVersion: "deployment-runtime-identity-v1",
    observedAt: iso(nowSeconds - 10),
    validUntil: iso(nowSeconds + 120),
    ...overrides,
  };
}

function verdict(component: Component): ComponentVerdict {
  return {
    schemaVersion: 1,
    policyVersion: "runtime-identity-gate-v1",
    siteId: "dfconnect",
    environment: "staging",
    component,
    state: "healthy",
    reasonCodes: ["component_all_required_pass"],
    observationIds: [
      `obs_${component.padEnd(32, "0").slice(0, 32)}`,
    ],
    evaluatedAt: iso(nowSeconds - 10),
    freshUntil: iso(nowSeconds + 180),
  };
}

const healthyVerdicts = operationComponentMatrix.siteDeploy.map(verdict);

function operationalState(): OperationalStateRepository {
  return {
    async readVerdicts() {
      return healthyVerdicts;
    },
    async hasActiveFreeze() {
      return false;
    },
  };
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
  sqlite.prepare(`
    INSERT INTO observations (
      observation_id, schema_version, site_id, environment, component,
      check_id, status, reason_code, observed_at, valid_until, source, scope,
      evidence_id, correlation_id, idempotency_key, created_at
    ) VALUES (
      ?1, 1, 'dfconnect', 'staging', 'deployment_integrity',
      'deploy.identity', 'pass', 'deployment_runtime_identity_observed',
      ?2, ?3, 'provider_api', 'dfconnect-site-staging',
      'ev_0123456789abcdef0123456789abcdef',
      'runtime_identity_probe_1', 'runtime-identity:probe:1', ?2
    )
  `).run(
    "obs_0123456789abcdef0123456789abcdef",
    iso(nowSeconds - 10),
    iso(nowSeconds + 120),
  );
  return { sqlite, port: new NodeSqliteD1(sqlite) };
}

async function signedHttpRequest(
  candidate: PostDeployRequest,
  overrides: Partial<{
    authorization: string;
    signature: string;
  }> = {},
): Promise<Request> {
  const rawBody = stableJson(candidate);
  return new Request("https://guard.example/v1/post-deploy-checks", {
    method: "POST",
    headers: {
      authorization:
        overrides.authorization ?? `Bearer ${serviceToken}`,
      "content-type": "application/json",
      "x-dfconnect-signature":
        overrides.signature ??
        (await signHmacSha256(rawBody, signingSecret)),
    },
    body: rawBody,
  });
}

function checker(
  runtimeIdentities: {
    readLatest(input: {
      siteId: string;
      environment: "staging" | "production";
    }): Promise<DeploymentRuntimeIdentity | null>;
  },
) {
  return createPostDeployOperationalChecker({
    repository: operationalState(),
    runtimeIdentities,
    clock: () => nowMs,
  });
}

function httpDependencies(
  port: D1DatabasePort,
  runtimeIdentities: Parameters<typeof checker>[0],
) {
  return {
    credential: {
      siteId: "dfconnect",
      environment: "staging" as const,
      serviceToken,
      signingSecret,
      maxAgeSeconds: 300,
      maxFutureSkewSeconds: 30,
    },
    repository: new D1PostDeployRepository(port),
    checker: checker(runtimeIdentities),
    clockSeconds: () => nowSeconds,
  };
}

test("D1 runtime identity is append-only and only an exact fresh triple plus a fresh live Gate passes", async () => {
  const { sqlite, port } = await database();
  const identities = new D1DeploymentRuntimeIdentityRepository(port);
  const current = identity();

  assert.equal(
    (await identities.append(current, iso(nowSeconds - 9))).status,
    "accepted",
  );
  assert.equal(
    (await identities.append(current, iso(nowSeconds - 8))).status,
    "duplicate",
  );
  await assert.rejects(
    identities.append(
      identity({ policyVersion: "caller-selected-policy-v2" }),
      iso(nowSeconds - 8),
    ),
    /deployment_runtime_identity_invalid/,
  );
  await assert.rejects(
    identities.append(
      identity({ validUntil: iso(nowSeconds + 291) }),
      iso(nowSeconds - 8),
    ),
    /deployment_runtime_identity_invalid/,
  );
  await assert.rejects(
    identities.append(
      identity({
        identityId: "runtime_fedcba9876543210fedcba9876543210",
        sourceObservationId: "obs_fedcba9876543210fedcba9876543210",
        observedAt: iso(nowSeconds - 9),
      }),
      iso(nowSeconds - 8),
    ),
    /FOREIGN KEY constraint failed/,
  );
  assert.deepEqual(
    await identities.readLatest({
      siteId: "dfconnect",
      environment: "staging",
    }),
    current,
  );
  assert.equal(
    (
      sqlite.prepare(
        "SELECT COUNT(*) count FROM deployment_runtime_identities",
      ).get() as { count: number }
    ).count,
    1,
  );

  const exact = await checker(identities).check(request());
  assert.equal(exact.outcome, "pass");
  assert.equal(exact.reasonCode, "post_deploy_checks_passed");
  assert.equal(exact.freshUntil, nowSeconds + 120);

  const mismatches: PostDeployRequest[] = [
    request("site-deploy-25001-1", { commitSha: "c".repeat(40) }),
    request("site-deploy-25002-1", { workerVersionId: "2-worker-version" }),
    request("site-deploy-25003-1", {
      evidenceDigest: `sha256:${"d".repeat(64)}`,
    }),
  ];
  for (const candidate of mismatches) {
    const result = await checker(identities).check(candidate);
    assert.equal(result.outcome, "unknown");
    assert.equal(
      result.reasonCode,
      "post_deploy_runtime_identity_mismatch",
    );
  }

  const missing = await checker({
    async readLatest() {
      return null;
    },
  }).check(request("site-deploy-25004-1"));
  assert.equal(missing.outcome, "unknown");
  assert.equal(
    missing.reasonCode,
    "post_deploy_runtime_identity_missing",
  );

  const stale = await checker({
    async readLatest() {
      return identity({ validUntil: iso(nowSeconds) });
    },
  }).check(request("site-deploy-25005-1"));
  assert.equal(stale.outcome, "unknown");
  assert.equal(
    stale.reasonCode,
    "post_deploy_runtime_identity_stale",
  );
  const future = await checker({
    async readLatest() {
      return identity({
        observedAt: iso(nowSeconds + 31),
        validUntil: iso(nowSeconds + 120),
      });
    },
  }).check(request("site-deploy-25006-1"));
  assert.equal(future.outcome, "unknown");
  assert.equal(
    future.reasonCode,
    "post_deploy_runtime_identity_stale",
  );
  sqlite.close();
});

test("post-deploy HTTP keeps client errors distinct and maps runtime/D1/internal failures to generic 503", async () => {
  const { sqlite, port } = await database();
  const identities = new D1DeploymentRuntimeIdentityRepository(port);
  await identities.append(identity(), iso(nowSeconds - 9));
  const dependencies = httpDependencies(port, identities);

  const acceptedRequest = request("site-deploy-25010-1");
  const accepted = await handlePostDeployRequest(
    await signedHttpRequest(acceptedRequest),
    dependencies,
  );
  assert.equal(accepted.status, 200);
  assert.equal(
    await verifyPostDeployVerdict(await accepted.json(), signingSecret),
    true,
  );

  const auth = await handlePostDeployRequest(
    await signedHttpRequest(request("site-deploy-25011-1"), {
      authorization: "Bearer wrong-post-deploy-token-012345",
    }),
    dependencies,
  );
  assert.equal(auth.status, 401);

  const scopeRequest = request("site-deploy-25012-1", {
    environment: "production",
  });
  const scope = await handlePostDeployRequest(
    await signedHttpRequest(scopeRequest),
    dependencies,
  );
  assert.equal(scope.status, 403);

  const malformed = await handlePostDeployRequest(
    await signedHttpRequest(
      request("site-deploy-25013-1", {
        workerVersionId: "not allowed",
      }),
    ),
    dependencies,
  );
  assert.equal(malformed.status, 400);

  const conflict = await handlePostDeployRequest(
    await signedHttpRequest(
      request(acceptedRequest.requestId, {
        evidenceDigest: `sha256:${"c".repeat(64)}`,
      }),
    ),
    dependencies,
  );
  assert.equal(conflict.status, 409);

  let mismatchReads = 0;
  const mismatchIdentityReader = {
    async readLatest() {
      mismatchReads += 1;
      return identity();
    },
  };
  const mismatchRequest = request("site-deploy-25016-1", {
    evidenceDigest: `sha256:${"e".repeat(64)}`,
  });
  const mismatch = await handlePostDeployRequest(
    await signedHttpRequest(mismatchRequest),
    httpDependencies(port, mismatchIdentityReader),
  );
  assert.equal(mismatch.status, 503);
  const mismatchBody = await mismatch.text();
  assert.equal(
    mismatchBody,
    stableJson({
      schema: "post-deploy-evaluation-v1",
      requestId: mismatchRequest.requestId,
      outcome: "unknown",
      reasonCode: "post_deploy_runtime_identity_mismatch",
    }),
  );
  assert.doesNotMatch(
    mismatchBody,
    new RegExp(
      `${identity().commitSha}|${identity().workerVersionId}|${identity().evidenceDigest}`,
      "u",
    ),
  );

  const mismatchAfterRestart = await handlePostDeployRequest(
    await signedHttpRequest(mismatchRequest),
    httpDependencies(port, mismatchIdentityReader),
  );
  assert.equal(mismatchAfterRestart.status, 503);
  assert.equal(await mismatchAfterRestart.text(), mismatchBody);
  assert.equal(mismatchReads, 1);
  assert.equal(
    (
      sqlite.prepare(
        "SELECT COUNT(*) count FROM post_deploy_receipts WHERE request_id = ?1",
      ).get(mismatchRequest.requestId) as { count: number }
    ).count,
    0,
  );

  const infrastructure = await handlePostDeployRequest(
    await signedHttpRequest(request("site-deploy-25014-1")),
    httpDependencies(port, {
      async readLatest() {
        throw new Error("D1 failure with private details");
      },
    }),
  );
  assert.equal(infrastructure.status, 503);
  assert.deepEqual(await infrastructure.json(), {
    error: "service_unavailable",
  });

  const failingPort: D1DatabasePort = {
    prepare() {
      throw new Error("D1 claim failure with private details");
    },
    async batch() {
      throw new Error("D1 batch failure with private details");
    },
  };
  const d1Failure = await handlePostDeployRequest(
    await signedHttpRequest(request("site-deploy-25015-1")),
    httpDependencies(failingPort, identities),
  );
  assert.equal(d1Failure.status, 503);
  const failureBody = await d1Failure.text();
  assert.equal(
    failureBody,
    stableJson({ error: "service_unavailable" }),
  );
  assert.doesNotMatch(
    failureBody,
    /private|details|commitSha|workerVersionId|evidenceDigest/iu,
  );

  const completionFailingPort: D1DatabasePort = {
    prepare: port.prepare.bind(port),
    async batch() {
      throw new Error("D1 completion failure with private details");
    },
  };
  const completionFailure = await handlePostDeployRequest(
    await signedHttpRequest(request("site-deploy-25017-1")),
    httpDependencies(completionFailingPort, identities),
  );
  assert.equal(completionFailure.status, 503);
  assert.deepEqual(await completionFailure.json(), {
    error: "service_unavailable",
  });
  sqlite.close();
});
