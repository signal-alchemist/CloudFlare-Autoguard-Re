import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import {
  DatabaseSync,
  type SQLInputValue,
  type StatementSync,
} from "node:sqlite";
import test from "node:test";

import { dfconnectProductionManifest } from "../../config/sites/dfconnect.production.ts";
import {
  createCloudflareWorkerPublicDeliveryProbePorts,
} from "../../lib/adapters/cloudflare-worker-public-delivery.ts";
import {
  compilePublicDeliveryManifest,
  runPublicDeliveryCheck,
  type CloudflareWorkerPublicDeliveryProbePorts,
  type PublicDeliveryWorkerExchangeRequest,
  type PublicDeliveryWorkerExchangeResult,
} from "../../lib/probes/public-delivery.ts";
import type {
  D1DatabasePort,
  D1PreparedStatementPort,
  D1RunResult,
} from "../../lib/repositories/observations.ts";
import {
  runDfconnectScheduledPublicDelivery,
  SCHEDULED_PUBLIC_DELIVERY_CRON,
} from "../../lib/services/scheduled-public-delivery.ts";
import {
  dispatchConfiguredPendingNotifications,
} from "../../worker/notification.ts";

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

class FailingStatement implements D1PreparedStatementPort {
  readonly inner: D1PreparedStatementPort;
  readonly sql: string;
  readonly values: readonly unknown[];
  readonly failCheckId: string;

  constructor(
    inner: D1PreparedStatementPort,
    sql: string,
    failCheckId: string,
    values: readonly unknown[] = [],
  ) {
    this.inner = inner;
    this.sql = sql;
    this.failCheckId = failCheckId;
    this.values = values;
  }

  bind(...values: unknown[]): D1PreparedStatementPort {
    return new FailingStatement(
      this.inner.bind(...values),
      this.sql,
      this.failCheckId,
      values,
    );
  }

  first<T>(): Promise<T | null> {
    return this.inner.first<T>();
  }

  run(): Promise<D1RunResult> {
    if (
      this.sql.includes("INSERT OR IGNORE INTO observations") &&
      this.values[5] === this.failCheckId
    ) {
      return Promise.reject(new Error("simulated_d1_write_failure"));
    }
    return this.inner.run();
  }
}

class SelectiveFailingD1 implements D1DatabasePort {
  readonly base: NodeSqliteD1;
  readonly failCheckId: string;

  constructor(base: NodeSqliteD1, failCheckId: string) {
    this.base = base;
    this.failCheckId = failCheckId;
  }

  prepare(sql: string): D1PreparedStatementPort {
    return new FailingStatement(
      this.base.prepare(sql),
      sql,
      this.failCheckId,
    );
  }

  async batch(
    statements: readonly D1PreparedStatementPort[],
  ): Promise<D1RunResult[]> {
    const results: D1RunResult[] = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
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
  for (const migration of migrations) sqlite.exec(migration);
  return { sqlite, port: new NodeSqliteD1(sqlite) };
}

const manifest = compilePublicDeliveryManifest(
  dfconnectProductionManifest,
);
const scheduledTime = Date.parse("2026-07-31T04:00:00.000Z");
const receivedAt = "2026-07-31T04:00:02.000Z";
const healthyRoot =
  '<html><head><link rel="canonical" href="https://dfconnect.jp/"></head>' +
  "<body>Web運用の、</body></html>";

function observedDns() {
  return {
    kind: "observed" as const,
    value: {
      addresses: ["104.21.35.80", "172.67.145.42"],
      ttlSeconds: 300,
    },
  };
}

function response(
  overrides: Partial<{
    status: number;
    headers: Readonly<Record<string, string>>;
    body: Uint8Array;
    bodyTooLarge: boolean;
    elapsedMs: number;
  }> = {},
): PublicDeliveryWorkerExchangeResult {
  return {
    kind: "response",
    value: {
      status: overrides.status ?? 200,
      headers:
        overrides.headers ??
        {
          "content-type": "text/html; charset=utf-8",
          "x-content-type-options": "nosniff",
        },
      body:
        overrides.body ??
        new TextEncoder().encode(healthyRoot),
      bodyTooLarge: overrides.bodyTooLarge ?? false,
      elapsedMs: overrides.elapsedMs ?? 80,
    },
  };
}

function workerPorts(
  exchange: (
    request: PublicDeliveryWorkerExchangeRequest,
  ) => Promise<PublicDeliveryWorkerExchangeResult> |
    PublicDeliveryWorkerExchangeResult,
): CloudflareWorkerPublicDeliveryProbePorts {
  return {
    mode: "cloudflare-worker",
    async resolve() {
      return observedDns();
    },
    async exchange(request) {
      return exchange(request);
    },
  };
}

async function apexResult(
  exchange: (
    request: PublicDeliveryWorkerExchangeRequest,
  ) => Promise<PublicDeliveryWorkerExchangeResult> |
    PublicDeliveryWorkerExchangeResult,
  seconds: number,
) {
  return runPublicDeliveryCheck({
    manifest,
    selection: {
      siteId: "dfconnect",
      environment: "production",
      checkId: "public.apex",
    },
    ports: workerPorts(exchange),
    now: scheduledTime + seconds * 1_000,
    correlationId: `scheduled-${scheduledTime + seconds * 1_000}`,
  });
}

test("Workers fetch never fabricates DNS/peer/TLS proof and preserves fail versus unknown", async () => {
  const matching = await apexResult(() => response(), 0);
  assert.equal(matching.observation.status, "unknown");
  assert.equal(
    matching.observation.reasonCode,
    "worker_transport_attestation_unavailable",
  );
  assert.equal(matching.evidence.connection.availability, "unavailable");
  assert.equal(matching.evidence.tls.availability, "unavailable");
  assert.equal(matching.evidence.tls.authorized, null);

  const mismatch = await apexResult(
    () => response({ status: 418 }),
    1,
  );
  assert.equal(mismatch.observation.status, "fail");
  assert.equal(mismatch.observation.reasonCode, "http_status_unexpected");

  const rateLimited = await apexResult(
    () => response({ status: 429 }),
    2,
  );
  assert.equal(rateLimited.observation.status, "unknown");
  assert.equal(
    rateLimited.observation.reasonCode,
    "http_response_indeterminate",
  );

  const offOrigin = await apexResult(
    () =>
      response({
        status: 302,
        headers: {
          location: "https://attacker.example/private?secret=value",
        },
        body: new Uint8Array(),
      }),
    3,
  );
  assert.equal(offOrigin.observation.status, "fail");
  assert.equal(offOrigin.observation.reasonCode, "http_off_origin_redirect");
  assert.doesNotMatch(
    JSON.stringify(offOrigin.evidence),
    /attacker|secret|104\.21\.35\.80/iu,
  );

  const timeout = await apexResult(
    async () => ({
      kind: "unavailable",
      reasonCode: "probe_timeout",
    }),
    4,
  );
  assert.equal(timeout.observation.status, "unknown");
  assert.equal(timeout.observation.reasonCode, "probe_timeout");
});

test("Cloudflare adapter bounds and sanitizes platform fetch without inventing transport fields", async () => {
  const calls: Array<{
    url: string;
    init: RequestInit | undefined;
  }> = [];
  let monotonic = 100;
  const ports = createCloudflareWorkerPublicDeliveryProbePorts({
    resolver: {
      async resolve4() {
        return [
          { address: "104.21.35.80", ttl: 300 },
          { address: "172.67.145.42", ttl: 300 },
        ];
      },
      async resolve6() {
        return [];
      },
    },
    async fetcher(input, init) {
      calls.push({ url: String(input), init });
      return new Response(healthyRoot, {
        status: 200,
        headers: {
          "content-type": "text/html",
          "x-content-type-options": "nosniff",
          "set-cookie": "session=private",
          "x-private-debug": "private-value",
        },
      });
    },
    monotonicClock() {
      monotonic += 25;
      return monotonic;
    },
    timeoutSignal() {
      return new AbortController().signal;
    },
  });

  assert.deepEqual(await ports.resolve("dfconnect.jp"), observedDns());
  const exchange = await ports.exchange({
    url: "https://dfconnect.jp/",
    method: "GET",
    maxResponseBytes: 131_072,
    timeoutMs: 3_000,
    requiredHeaders: ["x-content-type-options"],
  });
  assert.equal(exchange.kind, "response");
  if (exchange.kind !== "response") assert.fail("expected response");
  assert.deepEqual(exchange.value.headers, {
    "content-type": "text/html",
    "x-content-type-options": "present",
  });
  assert.equal(exchange.value.elapsedMs, 25);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://dfconnect.jp/");
  assert.equal(calls[0]?.init?.redirect, "manual");
  assert.equal(calls[0]?.init?.cache, "no-store");
  assert.equal(calls[0]?.init?.credentials, "omit");
  const requestHeaders = new Headers(calls[0]?.init?.headers);
  assert.equal(requestHeaders.has("authorization"), false);
  assert.equal(requestHeaders.has("cookie"), false);
  assert.doesNotMatch(
    JSON.stringify(exchange),
    /session|private-value|connectedAddress|daysRemaining/iu,
  );
});

function healthyScheduledExchange(
  request: PublicDeliveryWorkerExchangeRequest,
): PublicDeliveryWorkerExchangeResult {
  const url = new URL(request.url);
  const headers: Record<string, string> = {
    "x-content-type-options": "nosniff",
  };
  let status = 200;
  let body = new Uint8Array();

  if (request.method === "HEAD") {
    headers["content-type"] = "text/html";
  } else if (url.pathname === "/" && url.hostname === "dfconnect.jp") {
    headers["content-type"] = "text/html; charset=utf-8";
    body = new TextEncoder().encode(healthyRoot);
  } else if (
    url.pathname === "/" &&
    url.hostname === "www.dfconnect.jp"
  ) {
    headers["content-type"] = "text/html; charset=utf-8";
    body = new TextEncoder().encode(healthyRoot);
  } else if (url.pathname === "/pricing/") {
    headers["content-type"] = "text/html";
    body = new TextEncoder().encode(
      '<link rel="canonical" href="https://dfconnect.jp/pricing/">' +
        "料金一覧",
    );
  } else if (url.pathname === "/__autoguard-not-found__") {
    status = 404;
    headers["content-type"] = "text/html";
    body = new TextEncoder().encode("ページが見つかりません");
  } else if (url.pathname === "/robots.txt") {
    headers["content-type"] = "text/plain";
    body = new TextEncoder().encode(
      "Sitemap: https://dfconnect.jp/sitemap.xml",
    );
  } else if (url.pathname === "/sitemap.xml") {
    headers["content-type"] = "application/xml";
    body = new TextEncoder().encode("<urlset></urlset>");
  } else if (
    url.pathname === "/assets/images/dfconnect-mark.png"
  ) {
    headers["content-type"] = "image/png";
    body = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
  } else {
    throw new Error(`unexpected reviewed target: ${url.origin}${url.pathname}`);
  }

  return response({ status, headers, body });
}

function onePublicFailureExchange(
  request: PublicDeliveryWorkerExchangeRequest,
): PublicDeliveryWorkerExchangeResult {
  if (
    request.method === "GET" &&
    request.url === "https://dfconnect.jp/"
  ) {
    return response({ status: 418 });
  }
  return healthyScheduledExchange(request);
}

test("scheduled producer stores only the checked-in manifest, is bounded/idempotent, and writes heartbeat last with the correct actor", async () => {
  const { sqlite, port } = await database();
  let active = 0;
  let maximumActive = 0;
  const exchanged: string[] = [];
  const ports = workerPorts(async (request) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    exchanged.push(`${request.method} ${request.url}`);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    const result = healthyScheduledExchange(request);
    active -= 1;
    return result;
  });

  const input = {
    database: port as D1DatabasePort,
    ports,
    scheduledTime,
    cron: SCHEDULED_PUBLIC_DELIVERY_CRON,
    configuredSiteId: "dfconnect",
    configuredEnvironment: "production" as const,
    receivedAt,
  };
  const first = await runDfconnectScheduledPublicDelivery(input);
  assert.equal(first.targetObservations.length, manifest.checks.length);
  assert.equal(first.heartbeat.status, "pass");
  assert.equal(first.heartbeat.reasonCode, "scheduled_cycle_persisted");
  assert.ok(maximumActive <= 4);

  const rows = sqlite.prepare(`
    SELECT component, check_id, status, reason_code, source, scope,
      idempotency_key
    FROM observations
    ORDER BY rowid
  `).all() as Array<Record<string, unknown>>;
  assert.equal(rows.length, manifest.checks.length + 1);
  assert.deepEqual(
    rows.slice(0, manifest.checks.length).map((row) => row.check_id).sort(),
    manifest.checks.map((check) => check.checkId).sort(),
  );
  assert.deepEqual({ ...rows.at(-1) }, {
    component: "autoguard_control_plane",
    check_id: "guard.scheduler.public_delivery",
    status: "pass",
    reason_code: "scheduled_cycle_persisted",
    source: "autoguard_self",
    scope: "scheduled:dfconnect:production:public-delivery",
    idempotency_key:
      `scheduled:dfconnect:production:${scheduledTime}:` +
      "guard.scheduler.public_delivery",
  });
  assert.equal(
    rows.find((row) => row.check_id === "public.dns.apex")?.status,
    "pass",
  );
  assert.equal(
    rows.find((row) => row.check_id === "public.tls.apex")?.status,
    "unknown",
  );
  assert.equal(
    rows.find((row) => row.check_id === "public.apex")?.status,
    "unknown",
  );

  const audit = sqlite.prepare(`
    SELECT actor_id, policy_version, COUNT(*) count
    FROM audit_events
    GROUP BY actor_id, policy_version
  `).all() as Array<Record<string, unknown>>;
  assert.deepEqual(audit.map((row) => ({ ...row })), [
    {
      actor_id: "scheduled-public-producer",
      policy_version: "dfconnect-public-delivery-v1",
      count: manifest.checks.length + 1,
    },
  ]);
  assert.doesNotMatch(
    JSON.stringify(rows),
    /Web運用|料金一覧|Sitemap:|set-cookie|104\.21\.35\.80/iu,
  );
  assert.ok(
    exchanged.every((entry) =>
      manifest.checks.some(
        (check) => entry === `${check.method} ${check.url}`,
      ),
    ),
  );

  const exchangesAfterFirstRun = exchanged.length;
  const duplicate = await runDfconnectScheduledPublicDelivery(input);
  assert.equal(duplicate.heartbeat.status, "pass");
  assert.equal(exchanged.length, exchangesAfterFirstRun);
  assert.equal(
    (
      sqlite.prepare(
        "SELECT COUNT(*) count FROM observations",
      ).get() as { count: number }
    ).count,
    manifest.checks.length + 1,
  );
  assert.equal(
    (
      sqlite.prepare(
        "SELECT COUNT(*) count FROM audit_events",
      ).get() as { count: number }
    ).count,
    manifest.checks.length + 1,
  );
  sqlite.close();
});

test("scheduled FAIL creates one pending notification and a persisted observation repairs without re-probing", async () => {
  const { sqlite, port } = await database();
  let exchanges = 0;
  const input = {
    database: port as D1DatabasePort,
    ports: workerPorts((request) => {
      exchanges += 1;
      return onePublicFailureExchange(request);
    }),
    scheduledTime: scheduledTime + 120_000,
    cron: SCHEDULED_PUBLIC_DELIVERY_CRON,
    configuredSiteId: "dfconnect",
    configuredEnvironment: "production" as const,
    receivedAt: "2026-07-31T04:02:02.000Z",
  };
  const first = await runDfconnectScheduledPublicDelivery(input);
  assert.equal(
    first.targetObservations.filter(
      (observation) => observation.status === "fail",
    ).length,
    1,
  );
  assert.equal(first.heartbeat.status, "pass");
  assert.deepEqual(
    {
      ...(sqlite.prepare(`
        SELECT
          (SELECT COUNT(*) FROM incidents) incidents,
          (SELECT COUNT(*) FROM incident_timeline) timeline,
          (SELECT COUNT(*) FROM notification_outbox) outbox
      `).get() as Record<string, number>),
    },
    { incidents: 1, timeline: 1, outbox: 1 },
  );
  const missingQueue = await dispatchConfiguredPendingNotifications({
    DB: port,
    GUARD_SITE_ID: "dfconnect",
    GUARD_ENVIRONMENT: "production",
  });
  assert.deepEqual(missingQueue, {
    selected: 0,
    enqueued: 0,
    blocked: 0,
    retainedPending: 0,
  });
  const failedQueue = await dispatchConfiguredPendingNotifications({
    DB: port,
    GUARD_SITE_ID: "dfconnect",
    GUARD_ENVIRONMENT: "production",
    NOTIFICATION_QUEUE: {
      async send() {
        throw new Error("CANARY_QUEUE_SEND_FAILURE");
      },
    },
  });
  assert.deepEqual(failedQueue, {
    selected: 1,
    enqueued: 0,
    blocked: 0,
    retainedPending: 1,
  });
  assert.deepEqual(
    {
      ...(sqlite.prepare(`
        SELECT
          (SELECT status FROM notification_outbox LIMIT 1) outboxStatus,
          (SELECT status FROM observations
            WHERE check_id = 'guard.scheduler.public_delivery'
            LIMIT 1) heartbeatStatus
      `).get() as Record<string, string>),
    },
    { outboxStatus: "pending", heartbeatStatus: "pass" },
  );

  sqlite.exec("DELETE FROM notification_outbox");
  sqlite.exec("DELETE FROM incident_timeline");
  sqlite.exec("DELETE FROM incidents");
  exchanges = 0;
  const repaired = await runDfconnectScheduledPublicDelivery(input);
  assert.equal(repaired.heartbeat.status, "pass");
  assert.equal(exchanges, 0);
  assert.deepEqual(
    {
      ...(sqlite.prepare(`
        SELECT
          (SELECT COUNT(*) FROM incidents) incidents,
          (SELECT COUNT(*) FROM incident_timeline) timeline,
          (SELECT COUNT(*) FROM notification_outbox) outbox
      `).get() as Record<string, number>),
    },
    { incidents: 1, timeline: 1, outbox: 1 },
  );
  sqlite.close();
});

test("scheduled notification reconciliation failure preserves the FAIL observation and prevents a passing heartbeat", async () => {
  const { sqlite, port } = await database();
  const failureTime = scheduledTime + 180_000;
  await assert.rejects(
    runDfconnectScheduledPublicDelivery({
      database: new RejectingOutboxD1(port),
      ports: workerPorts(onePublicFailureExchange),
      scheduledTime: failureTime,
      cron: SCHEDULED_PUBLIC_DELIVERY_CRON,
      configuredSiteId: "dfconnect",
      configuredEnvironment: "production",
      receivedAt: "2026-07-31T04:03:02.000Z",
    }),
    /scheduled_cycle_incomplete/u,
  );
  assert.equal(
    (
      sqlite.prepare(`
        SELECT COUNT(*) count
        FROM observations
        WHERE status = 'fail'
      `).get() as { count: number }
    ).count,
    1,
  );
  assert.deepEqual(
    {
      ...(sqlite.prepare(`
        SELECT
          (SELECT COUNT(*) FROM incidents) incidents,
          (SELECT COUNT(*) FROM incident_timeline) timeline,
          (SELECT COUNT(*) FROM notification_outbox) outbox,
          (SELECT COUNT(*) FROM observations
            WHERE check_id = 'guard.scheduler.public_delivery'
              AND status = 'pass') passingHeartbeats
      `).get() as Record<string, number>),
    },
    {
      incidents: 0,
      timeline: 0,
      outbox: 0,
      passingHeartbeats: 0,
    },
  );
  sqlite.close();
});

test("configuration and D1 failures never leave a passing scheduler heartbeat", async () => {
  {
    const { sqlite, port } = await database();
    let exchanges = 0;
    await assert.rejects(
      runDfconnectScheduledPublicDelivery({
        database: port,
        ports: workerPorts(() => {
          exchanges += 1;
          return healthyScheduledExchange({
            url: "https://dfconnect.jp/",
            method: "GET",
            maxResponseBytes: 131_072,
            timeoutMs: 3_000,
            requiredHeaders: [],
          });
        }),
        scheduledTime,
        cron: SCHEDULED_PUBLIC_DELIVERY_CRON,
        configuredSiteId: "dfconnect",
        configuredEnvironment: "staging",
        receivedAt,
      }),
      /scheduled_configuration_invalid/u,
    );
    assert.equal(exchanges, 0);
    const heartbeat = sqlite.prepare(`
      SELECT status, reason_code
      FROM observations
      WHERE check_id = 'guard.scheduler.public_delivery'
    `).get();
    assert.deepEqual({ ...heartbeat }, {
      status: "unknown",
      reason_code: "scheduled_configuration_invalid",
    });
    sqlite.close();
  }

  {
    const { sqlite, port } = await database();
    const failing = new SelectiveFailingD1(port, "public.pricing");
    await assert.rejects(
      runDfconnectScheduledPublicDelivery({
        database: failing,
        ports: workerPorts(healthyScheduledExchange),
        scheduledTime: scheduledTime + 60_000,
        cron: SCHEDULED_PUBLIC_DELIVERY_CRON,
        configuredSiteId: "dfconnect",
        configuredEnvironment: "production",
        receivedAt: "2026-07-31T04:01:02.000Z",
      }),
      /scheduled_cycle_incomplete/u,
    );
    const heartbeat = sqlite.prepare(`
      SELECT status, reason_code
      FROM observations
      WHERE check_id = 'guard.scheduler.public_delivery'
    `).get();
    assert.deepEqual({ ...heartbeat }, {
      status: "unknown",
      reason_code: "scheduled_cycle_incomplete",
    });
    assert.equal(
      (
        sqlite.prepare(`
          SELECT COUNT(*) count
          FROM observations
          WHERE check_id = 'guard.scheduler.public_delivery'
            AND status = 'pass'
        `).get() as { count: number }
      ).count,
      0,
    );
    sqlite.close();
  }
});
