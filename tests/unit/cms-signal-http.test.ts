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
  type CmsSignalCredential,
} from "../../lib/contracts/ops-signal.ts";
import {
  routeCmsSignalIngress,
  type CmsSignalIngressDependencies,
} from "../../lib/http/cms-signal.ts";
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
      return Promise.reject(new Error("sensitive outbox failure"));
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

const now = Date.parse("2026-07-31T00:01:00.000Z");
const credential: CmsSignalCredential = {
  credentialId: "cms-staging-v1",
  token: "staging-service-token-0123456789",
  signingSecret: "staging-signing-secret-0123456789",
  siteId: "dfconnect",
  environment: "staging",
  maxAgeSeconds: 120,
  maxFutureSkewSeconds: 30,
  validForSeconds: 180,
};

function payload(
  overrides: Partial<{
    environment: "staging" | "production";
    sentAt: string;
  }> = {},
) {
  const environment = overrides.environment ?? "staging";
  return {
    schema: "autoguard-ops-signal-envelope-v1",
    environment,
    sentAt: overrides.sentAt ?? "2026-07-31T00:00:00.000Z",
    signal: {
      schema: "ops-signal-v1",
      event: "worker.runtime_failure",
      schemaVersion: 1,
      fingerprint: "a".repeat(64),
      severity: "error",
      environment,
      service: `dfconnect-site-${environment}`,
      occurredAt: "2026-07-31T00:00:00.000Z",
      status: 500,
      method: "GET",
      route: "/healthz",
      exceptionName: "TypeError",
      message: "Unhandled Worker exception",
      requestId: "request_123",
    },
  };
}

async function signedRequest(
  pathname: string,
  body = payload(),
  overrides: Partial<{
    authorization: string;
    signature: string;
    contentType: string;
  }> = {},
): Promise<Request> {
  const serialized = stableJson(body);
  return new Request(`https://guard.example${pathname}`, {
    method: "POST",
    headers: {
      authorization:
        overrides.authorization ?? `Bearer ${credential.token}`,
      "content-type": overrides.contentType ?? "application/json",
      "x-dfconnect-signature":
        overrides.signature ??
        (await signHmacSha256(serialized, credential.signingSecret)),
    },
    body: serialized,
  });
}

async function database(): Promise<{
  sqlite: DatabaseSync;
  port: NodeSqliteD1;
}> {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const directory = new URL("../../drizzle/", import.meta.url);
  const migrations = await Promise.all(
    (await readdir(directory))
      .filter((file) => file.endsWith(".sql"))
      .sort()
      .map((file) => readFile(new URL(file, directory), "utf8")),
  );
  for (const migration of migrations) sqlite.exec(migration);
  return { sqlite, port: new NodeSqliteD1(sqlite) };
}

function dependencies(
  port: D1DatabasePort,
  gate: CmsSignalIngressDependencies["gate"] = async () =>
    Response.json({ source: "existing-gate" }),
): CmsSignalIngressDependencies {
  return {
    signal: {
      credentials: [credential],
      database: port,
      clock: () => now,
    },
    gate,
  };
}

test("canonical and CMS-compatible ingress share signed D1 receipt/audit handling while GET remains Gate", async () => {
  const { sqlite, port } = await database();
  let gateCalls = 0;
  const deps = dependencies(port, async () => {
    gateCalls += 1;
    return Response.json({ source: "existing-gate" });
  });

  const accepted = await routeCmsSignalIngress(
    await signedRequest("/v1/signals/cms"),
    deps,
  );
  assert.equal(accepted?.status, 202);
  assert.deepEqual(await accepted?.json(), {
    schema: "cms-signal-receipt-v1",
    status: "accepted",
    observationId: "obs_9f6a8a6613bd15fa24f56796529da25b",
    siteId: "dfconnect",
    environment: "staging",
    correlationId: "request_123",
  });

  const duplicate = await routeCmsSignalIngress(
    await signedRequest(
      "/compat/v1/gate",
      payload({ sentAt: "2026-07-31T00:00:01.000Z" }),
    ),
    deps,
  );
  assert.equal(duplicate?.status, 200);
  assert.equal(
    (await duplicate?.json() as { status?: string }).status,
    "duplicate",
  );

  const gate = await routeCmsSignalIngress(
    new Request("https://guard.example/compat/v1/gate"),
    deps,
  );
  assert.equal(gate?.status, 200);
  assert.deepEqual(await gate?.json(), { source: "existing-gate" });
  assert.equal(gateCalls, 1);

  const counts = sqlite
    .prepare(`
      SELECT
        (SELECT COUNT(*) FROM observations) AS observations,
        (SELECT COUNT(*) FROM signal_receipts) AS receipts,
        (SELECT COUNT(*) FROM audit_events) AS audits,
        (SELECT COUNT(*) FROM replay_claims) AS replayClaims,
        (SELECT COUNT(*) FROM incidents) AS incidents,
        (SELECT COUNT(*) FROM incident_timeline) AS timeline,
        (SELECT COUNT(*) FROM notification_outbox) AS outbox
    `)
    .get() as Record<string, number>;
  assert.deepEqual({ ...counts }, {
    observations: 1,
    receipts: 1,
    audits: 1,
    replayClaims: 2,
    incidents: 1,
    timeline: 1,
    outbox: 1,
  });
  const pending = sqlite.prepare(`
    SELECT status, notification_kind, payload_json
    FROM notification_outbox
  `).get() as Record<string, unknown>;
  assert.equal(pending.status, "pending");
  assert.equal(pending.notification_kind, "incident_opened");
  assert.equal(
    (JSON.parse(String(pending.payload_json)) as { severity: string })
      .severity,
    "sev3",
  );
  assert.doesNotMatch(
    String(pending.payload_json),
    /Unhandled Worker exception|severity.*error|authorization|cookie|token/iu,
  );
  sqlite.close();
});

test("CMS reconcile failure is generic 503 and a fresh-envelope duplicate repairs exactly once while exact raw replay remains 409", async () => {
  const { sqlite, port } = await database();
  const failed = await routeCmsSignalIngress(
    await signedRequest("/v1/signals/cms"),
    dependencies(new RejectingOutboxD1(port)),
  );
  assert.equal(failed?.status, 503);
  assert.deepEqual(await failed?.json(), {
    error: "service_unavailable",
  });
  assert.deepEqual(
    {
      ...(sqlite.prepare(`
        SELECT
          (SELECT COUNT(*) FROM observations) observations,
          (SELECT COUNT(*) FROM incidents) incidents,
          (SELECT COUNT(*) FROM incident_timeline) timeline,
          (SELECT COUNT(*) FROM notification_outbox) outbox
      `).get() as Record<string, number>),
    },
    { observations: 1, incidents: 0, timeline: 0, outbox: 0 },
  );

  const freshEnvelope = payload({
    sentAt: "2026-07-31T00:00:01.000Z",
  });
  const repaired = await routeCmsSignalIngress(
    await signedRequest("/compat/v1/gate", freshEnvelope),
    dependencies(port),
  );
  assert.equal(repaired?.status, 200);
  assert.equal(
    (await repaired?.json() as { status: string }).status,
    "duplicate",
  );

  const rawReplay = await routeCmsSignalIngress(
    await signedRequest("/compat/v1/gate", freshEnvelope),
    dependencies(port),
  );
  assert.equal(rawReplay?.status, 409);
  assert.deepEqual(await rawReplay?.json(), {
    error: "replay_rejected",
  });
  assert.deepEqual(
    {
      ...(sqlite.prepare(`
        SELECT
          (SELECT COUNT(*) FROM observations) observations,
          (SELECT COUNT(*) FROM signal_receipts) receipts,
          (SELECT COUNT(*) FROM audit_events) audits,
          (SELECT COUNT(*) FROM replay_claims) replayClaims,
          (SELECT COUNT(*) FROM incidents) incidents,
          (SELECT COUNT(*) FROM incident_timeline) timeline,
          (SELECT COUNT(*) FROM notification_outbox) outbox
      `).get() as Record<string, number>),
    },
    {
      observations: 1,
      receipts: 1,
      audits: 1,
      replayClaims: 2,
      incidents: 1,
      timeline: 1,
      outbox: 1,
    },
  );
  sqlite.close();
});

test("ingress maps malformed, unauthorized, scoped, replayed, missing, and D1 failures to safe statuses", async () => {
  const { sqlite, port } = await database();
  const deps = dependencies(port);

  const unavailable = await routeCmsSignalIngress(
    await signedRequest("/v1/signals/cms"),
    { ...deps, signal: null },
  );
  assert.equal(unavailable?.status, 503);
  assert.deepEqual(await unavailable?.json(), {
    error: "service_unavailable",
  });

  const badAuth = await routeCmsSignalIngress(
    await signedRequest("/v1/signals/cms", payload(), {
      authorization: "Bearer wrong-service-token-0123456789",
    }),
    deps,
  );
  assert.equal(badAuth?.status, 401);
  assert.deepEqual(await badAuth?.json(), { error: "unauthorized" });

  const badSignature = await routeCmsSignalIngress(
    await signedRequest("/v1/signals/cms", payload(), {
      signature: `hmac-sha256:${"0".repeat(64)}`,
    }),
    deps,
  );
  assert.equal(badSignature?.status, 401);
  assert.deepEqual(await badSignature?.json(), { error: "unauthorized" });

  const wrongScope = await routeCmsSignalIngress(
    await signedRequest(
      "/v1/signals/cms",
      payload({ environment: "production" }),
    ),
    deps,
  );
  assert.equal(wrongScope?.status, 403);
  assert.deepEqual(await wrongScope?.json(), { error: "forbidden" });

  const stale = await routeCmsSignalIngress(
    await signedRequest(
      "/v1/signals/cms",
      payload({ sentAt: "2026-07-30T23:00:00.000Z" }),
    ),
    deps,
  );
  assert.equal(stale?.status, 400);
  assert.deepEqual(await stale?.json(), { error: "request_invalid" });

  assert.equal(
    (
      await routeCmsSignalIngress(
        await signedRequest("/v1/signals/cms"),
        deps,
      )
    )?.status,
    202,
  );
  const replay = await routeCmsSignalIngress(
    await signedRequest("/v1/signals/cms"),
    deps,
  );
  assert.equal(replay?.status, 409);
  assert.deepEqual(await replay?.json(), { error: "replay_rejected" });

  const invalidContentType = await routeCmsSignalIngress(
    await signedRequest("/v1/signals/cms", payload(), {
      contentType: "application/json; charset=utf-8",
    }),
    deps,
  );
  assert.equal(invalidContentType?.status, 415);

  const tooLarge = await routeCmsSignalIngress(
    new Request("https://guard.example/v1/signals/cms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(64 * 1_024 + 1),
    }),
    deps,
  );
  assert.equal(tooLarge?.status, 413);

  const failedDatabase: D1DatabasePort = {
    prepare: port.prepare.bind(port),
    async batch() {
      throw new Error("sensitive database failure");
    },
  };
  const databaseFailure = await routeCmsSignalIngress(
    await signedRequest(
      "/v1/signals/cms",
      payload({ sentAt: "2026-07-31T00:00:02.000Z" }),
    ),
    dependencies(failedDatabase),
  );
  assert.equal(databaseFailure?.status, 503);
  assert.deepEqual(await databaseFailure?.json(), {
    error: "service_unavailable",
  });

  const method = await routeCmsSignalIngress(
    new Request("https://guard.example/v1/signals/cms"),
    deps,
  );
  assert.equal(method?.status, 405);
  assert.equal(method?.headers.get("allow"), "POST");
  assert.equal(
    await routeCmsSignalIngress(
      new Request("https://guard.example/not-an-ingress"),
      deps,
    ),
    null,
  );
  sqlite.close();
});
