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
  buildSignedPostDeployVerdict,
  canonicalPostDeployRequest,
  verifyPostDeployRequest,
  verifyPostDeployVerdict,
  type PostDeployRequest,
} from "../../lib/contracts/post-deploy.ts";
import {
  processPostDeployRequest,
  type PostDeployCheckerPort,
} from "../../lib/services/post-deploy.ts";
import { D1PostDeployRepository } from "../../lib/repositories/post-deploy.ts";
import {
  signHmacSha256,
  stableJson,
} from "../../lib/contracts/ops-signal.ts";
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

const signingSecret = "post-deploy-signing-secret-0123456789";
const request: PostDeployRequest = {
  schema: "site-deploy-post-deploy-v1",
  event: "site_deploy.post_deploy_requested",
  requestId: "site-deploy-12345-1",
  siteId: "dfconnect",
  environment: "staging",
  commitSha: "a".repeat(40),
  workerVersionId: "worker-1",
  evidenceDigest: `sha256:${"b".repeat(64)}`,
  requestedAt: 2_000,
};

async function verified(candidate: PostDeployRequest = request) {
  const rawText = stableJson(candidate);
  const rawBody = new TextEncoder().encode(rawText);
  return verifyPostDeployRequest({
    rawBody,
    authorization: "Bearer post-deploy-service-token-0123456789",
    signature: await signHmacSha256(rawBody, signingSecret),
    nowSeconds: 2_000,
    credential: {
      siteId: "dfconnect",
      environment: "staging",
      serviceToken: "post-deploy-service-token-0123456789",
      signingSecret,
      maxAgeSeconds: 300,
      maxFutureSkewSeconds: 30,
    },
  });
}

test("post-deploy exact identity, HMAC, durable idempotency, and immutable receipt survive restart", async () => {
  assert.equal(
    canonicalPostDeployRequest(request),
    '{"commitSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","environment":"staging","event":"site_deploy.post_deploy_requested","evidenceDigest":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","requestedAt":2000,"requestId":"site-deploy-12345-1","schema":"site-deploy-post-deploy-v1","siteId":"dfconnect","workerVersionId":"worker-1"}',
  );
  assert.equal(
    await signHmacSha256(canonicalPostDeployRequest(request), signingSecret),
    "hmac-sha256:f328168fcab751ff5de255aebd8d1c342a0abdd79ba3900948a2c4c0bbb1fa88",
  );
  const fixedVerdict = await buildSignedPostDeployVerdict(
    {
      requestId: request.requestId,
      siteId: request.siteId,
      environment: request.environment,
      commitSha: request.commitSha,
      decision: "allow",
      checkedAt: 1_999,
      freshUntil: 2_300,
    },
    signingSecret,
  );
  assert.equal(
    fixedVerdict.signature,
    "hmac-sha256:389cd90fba061fa8188d43f04b8edc5386957698487c67cc49caf35f12875c2a",
  );
  assert.equal(
    await verifyPostDeployVerdict(fixedVerdict, signingSecret),
    true,
  );
  assert.deepEqual(Object.keys(fixedVerdict).sort(), [
    "checkedAt",
    "commitSha",
    "decision",
    "environment",
    "event",
    "freshUntil",
    "requestId",
    "schema",
    "signature",
    "siteId",
  ]);

  const valid = await verified();
  const invalidRequests = [
    { ...request, commitSha: "a".repeat(39) },
    { ...request, commitSha: "A".repeat(40) },
    { ...request, workerVersionId: "synthetic_sha" },
    { ...request, evidenceDigest: "b".repeat(64) },
    { ...request, requestId: "arbitrary-request" },
    { ...request, requestedAt: 1_699 },
    { ...request, siteId: "another" },
    { ...request, environment: "production" as const },
    { ...request, extra: "not-allowed" },
  ];
  for (const candidate of invalidRequests) {
    await assert.rejects(
      verified(candidate as PostDeployRequest),
      /post_deploy_/,
    );
  }
  await assert.rejects(
    verifyPostDeployRequest({
      rawBody: new TextEncoder().encode(stableJson(request)),
      authorization: "Bearer post-deploy-service-token-0123456789",
      signature: `hmac-sha256:${"0".repeat(64)}`,
      nowSeconds: 2_000,
      credential: {
        siteId: "dfconnect",
        environment: "staging",
        serviceToken: "post-deploy-service-token-0123456789",
        signingSecret,
        maxAgeSeconds: 300,
        maxFutureSkewSeconds: 30,
      },
    }),
    /post_deploy_signature_invalid/,
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
  const directory = await mkdtemp(
    join(tmpdir(), "cloudflare-guard-post-deploy-"),
  );
  const databasePath = join(directory, "guard.sqlite");
  let database = new DatabaseSync(databasePath);
  database.exec(migrations);
  let repository = new D1PostDeployRepository(new NodeSqliteD1(database));
  let checkerCalls = 0;
  const checker: PostDeployCheckerPort = {
    async check() {
      checkerCalls += 1;
      return {
        outcome: "pass",
        reasonCode: "post_deploy_checks_passed",
        checkedAt: 1_999,
        freshUntil: 2_300,
      };
    },
  };

  const first = await processPostDeployRequest(valid, {
    repository,
    checker,
    signingSecret,
  });
  const duplicate = await processPostDeployRequest(valid, {
    repository,
    checker,
    signingSecret,
  });
  assert.equal(first.status, "completed");
  assert.equal(first.outcome, "pass");
  assert.equal(duplicate.status, "duplicate");
  assert.deepEqual(duplicate.receipt, first.receipt);
  assert.equal(checkerCalls, 1);
  assert.deepEqual(
    {
      ...(database
        .prepare(
          "SELECT (SELECT COUNT(*) FROM post_deploy_requests) requests, (SELECT COUNT(*) FROM post_deploy_receipts) receipts",
        )
        .get() as Record<string, number>),
    },
    { requests: 1, receipts: 1 },
  );

  database.close();
  database = new DatabaseSync(databasePath);
  repository = new D1PostDeployRepository(new NodeSqliteD1(database));
  const afterRestart = await processPostDeployRequest(valid, {
    repository,
    checker,
    signingSecret,
  });
  assert.equal(afterRestart.status, "duplicate");
  assert.deepEqual(afterRestart.receipt, first.receipt);
  assert.equal(checkerCalls, 1);

  const changed = await verified({
    ...request,
    evidenceDigest: `sha256:${"c".repeat(64)}`,
  });
  await assert.rejects(
    processPostDeployRequest(changed, {
      repository,
      checker,
      signingSecret,
    }),
    /post_deploy_idempotency_conflict/,
  );
  assert.equal(checkerCalls, 1);
  assert.deepEqual(
    {
      ...(database
        .prepare(
          "SELECT (SELECT COUNT(*) FROM post_deploy_requests) requests, (SELECT COUNT(*) FROM post_deploy_receipts) receipts",
        )
        .get() as Record<string, number>),
    },
    { requests: 1, receipts: 1 },
  );
  database.close();
});
