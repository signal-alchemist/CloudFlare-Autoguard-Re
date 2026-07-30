import assert from "node:assert/strict";
import test from "node:test";

import type { Environment } from "../../lib/contracts/ops-signal.ts";
import {
  routeOperationalReadRequest,
  secureJsonResponse,
  unknownV1Response,
  type OwnerReadAuthorization,
  type OperationalReadRouteDependencies,
} from "../../lib/http/operability.ts";
import type {
  CanonicalOperabilitySnapshotV1,
  GuardReadBindings,
} from "../../lib/services/canonical-operability.ts";

const scope = {
  siteId: "dfconnect",
  environment: "production" as const,
};

const snapshot: CanonicalOperabilitySnapshotV1 = {
  schema: "guard-operability-v1",
  siteId: scope.siteId,
  environment: scope.environment,
  generatedAt: "2026-07-31T08:00:00.000Z",
  overall: "unknown",
  components: [],
  gates: [],
  incidents: { active: 0, truncated: false, items: [] },
  notifications: {
    outbox: { pending: 0, enqueued: 0, blocked: 0 },
    deliveries: { total: 0, latestDeliveredAt: null },
  },
  deployment: { identity: { state: "missing" }, postDeploy: null },
  freeze: {
    active: false,
    count: 0,
    earliestExpiresAt: null,
    reasonCodes: [],
  },
  scheduler: {
    state: "missing",
    reasonCode: "scheduler_heartbeat_missing",
    observedAt: null,
    validUntil: null,
  },
  readiness: {
    status: "not_ready",
    checks: {
      runtimeScopePolicy: "not_ready",
      consoleAuthentication: "not_ready",
      databaseSchema: "ready",
      evidenceStorage: "not_ready",
      cmsCredentials: "not_ready",
      notificationPath: "not_ready",
      scheduledManifest: "ready",
      schedulerHeartbeat: "not_ready",
    },
  },
};

const bindings: GuardReadBindings = {
  GUARD_SITE_ID: scope.siteId,
  GUARD_ENVIRONMENT: scope.environment,
};

function allowedAuthorization(
  calls: Array<{ siteId: string; environment: Environment }>,
): OwnerReadAuthorization {
  return async (_request, requestedScope) => {
    calls.push(requestedScope);
    return null;
  };
}

function assertHeadParity(get: Response, head: Response): void {
  assert.equal(head.status, get.status);
  for (const header of [
    "cache-control",
    "content-type",
    "referrer-policy",
    "x-content-type-options",
    "x-frame-options",
    "x-robots-tag",
  ]) {
    assert.equal(head.headers.get(header), get.headers.get(header));
  }
}

test("liveness is dependency-free and GET/HEAD/method contracts are exact", async () => {
  let authCalls = 0;
  let readCalls = 0;
  const dependencies: OperationalReadRouteDependencies = {
    async authorizeOwner() {
      authCalls += 1;
      return null;
    },
    async loadSnapshot() {
      readCalls += 1;
      return snapshot;
    },
    clock: () => Date.parse(snapshot.generatedAt),
  };

  const get = await routeOperationalReadRequest(
    new Request("https://guard.example/live"),
    bindings,
    dependencies,
  );
  assert.ok(get);
  assert.equal(get.status, 200);
  assert.deepEqual(await get.json(), {
    schema: "guard-liveness-v1",
    status: "live",
  });
  assert.equal(get.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.equal(get.headers.get("x-content-type-options"), "nosniff");
  assert.equal(authCalls, 0);
  assert.equal(readCalls, 0);

  const headRequest = new Request("https://guard.example/live", {
    method: "HEAD",
  });
  const head = await routeOperationalReadRequest(
    headRequest,
    bindings,
    dependencies,
  );
  assert.ok(head);
  assertHeadParity(get, head);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.equal(authCalls, 0);
  assert.equal(readCalls, 0);

  const method = await routeOperationalReadRequest(
    new Request("https://guard.example/live", { method: "POST" }),
    bindings,
    dependencies,
  );
  assert.ok(method);
  assert.equal(method.status, 405);
  assert.equal(method.headers.get("allow"), "GET, HEAD");
  assert.deepEqual(await method.json(), { error: "method_not_allowed" });
  assert.equal(authCalls, 0);
  assert.equal(readCalls, 0);
});

test("ready and canonical reads authorize before any D1-backed work and keep HEAD parity", async () => {
  const deniedReads: string[] = [];
  const denied = await routeOperationalReadRequest(
    new Request("https://guard.example/ready"),
    bindings,
    {
      async authorizeOwner() {
        return secureJsonResponse(
          { error: "unauthorized" },
          { status: 401 },
        );
      },
      async loadSnapshot() {
        deniedReads.push("snapshot");
        return snapshot;
      },
      clock: () => Date.parse(snapshot.generatedAt),
    },
  );
  assert.ok(denied);
  assert.equal(denied.status, 401);
  assert.equal(deniedReads.length, 0);

  const deniedHead = await routeOperationalReadRequest(
    new Request("https://guard.example/ready", { method: "HEAD" }),
    bindings,
    {
      async authorizeOwner() {
        return secureJsonResponse(
          { error: "unauthorized" },
          { status: 401 },
        );
      },
      async loadSnapshot() {
        deniedReads.push("head-snapshot");
        return snapshot;
      },
      clock: () => Date.parse(snapshot.generatedAt),
    },
  );
  assert.ok(deniedHead);
  assertHeadParity(denied, deniedHead);
  assert.equal((await deniedHead.arrayBuffer()).byteLength, 0);
  assert.equal(deniedReads.length, 0);

  const authScopes: Array<{ siteId: string; environment: Environment }> = [];
  const readyDependencies: OperationalReadRouteDependencies = {
    authorizeOwner: allowedAuthorization(authScopes),
    async loadSnapshot() {
      return {
        ...snapshot,
        readiness: {
          ...snapshot.readiness,
          status: "ready",
        },
      };
    },
    clock: () => Date.parse(snapshot.generatedAt),
  };
  const ready = await routeOperationalReadRequest(
    new Request("https://guard.example/ready"),
    bindings,
    readyDependencies,
  );
  assert.ok(ready);
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), {
    schema: "guard-readiness-v1",
    status: "ready",
  });
  assert.deepEqual(authScopes, [scope]);

  const readyHead = await routeOperationalReadRequest(
    new Request("https://guard.example/ready", { method: "HEAD" }),
    bindings,
    readyDependencies,
  );
  assert.ok(readyHead);
  assertHeadParity(ready, readyHead);
  assert.equal((await readyHead.arrayBuffer()).byteLength, 0);

  const notReady = await routeOperationalReadRequest(
    new Request("https://guard.example/ready"),
    bindings,
    {
      ...readyDependencies,
      async loadSnapshot() {
        return snapshot;
      },
    },
  );
  assert.ok(notReady);
  assert.equal(notReady.status, 503);
  const notReadyText = await notReady.text();
  assert.deepEqual(JSON.parse(notReadyText), {
    schema: "guard-readiness-v1",
    status: "not_ready",
  });
  assert.doesNotMatch(notReadyText, /D1|token|heartbeat|secret/u);

  const notReadyHead = await routeOperationalReadRequest(
    new Request("https://guard.example/ready", { method: "HEAD" }),
    bindings,
    {
      ...readyDependencies,
      async loadSnapshot() {
        return snapshot;
      },
    },
  );
  assert.ok(notReadyHead);
  assertHeadParity(notReady, notReadyHead);
  assert.equal((await notReadyHead.arrayBuffer()).byteLength, 0);

  const canonicalUrl =
    "https://guard.example/v1/sites/dfconnect/environments/production/operability";
  const canonicalGet = await routeOperationalReadRequest(
    new Request(canonicalUrl),
    bindings,
    readyDependencies,
  );
  assert.ok(canonicalGet);
  assert.equal(canonicalGet.status, 200);
  assert.equal(
    ((await canonicalGet.json()) as { schema: string }).schema,
    "guard-operability-v1",
  );

  const canonicalHeadRequest = new Request(canonicalUrl, { method: "HEAD" });
  const canonicalHead = await routeOperationalReadRequest(
    canonicalHeadRequest,
    bindings,
    readyDependencies,
  );
  assert.ok(canonicalHead);
  assertHeadParity(canonicalGet, canonicalHead);
  assert.equal((await canonicalHead.arrayBuffer()).byteLength, 0);

  const unavailableGet = await routeOperationalReadRequest(
    new Request(canonicalUrl),
    bindings,
    {
      authorizeOwner: allowedAuthorization([]),
      async loadSnapshot() {
        throw new Error("private-d1-detail");
      },
      clock: () => Date.parse(snapshot.generatedAt),
    },
  );
  assert.ok(unavailableGet);
  assert.equal(unavailableGet.status, 503);
  assert.deepEqual(await unavailableGet.json(), {
    error: "service_unavailable",
  });

  const unavailableHead = await routeOperationalReadRequest(
    new Request(canonicalUrl, { method: "HEAD" }),
    bindings,
    {
      authorizeOwner: allowedAuthorization([]),
      async loadSnapshot() {
        throw new Error("private-d1-detail");
      },
      clock: () => Date.parse(snapshot.generatedAt),
    },
  );
  assert.ok(unavailableHead);
  assertHeadParity(unavailableGet, unavailableHead);
  assert.equal((await unavailableHead.arrayBuffer()).byteLength, 0);
});

test("scope mismatch is forbidden without a read and unknown v1 paths are JSON 404", async () => {
  let reads = 0;
  const mismatch = await routeOperationalReadRequest(
    new Request(
      "https://guard.example/v1/sites/other-site/environments/production/operability",
    ),
    bindings,
    {
      authorizeOwner: allowedAuthorization([]),
      async loadSnapshot() {
        reads += 1;
        return snapshot;
      },
      clock: () => Date.parse(snapshot.generatedAt),
    },
  );
  assert.ok(mismatch);
  assert.equal(mismatch.status, 403);
  assert.deepEqual(await mismatch.json(), { error: "forbidden" });
  assert.equal(reads, 0);

  const unauthenticatedMismatch = await routeOperationalReadRequest(
    new Request(
      "https://guard.example/v1/sites/other-site/environments/production/operability",
      { method: "HEAD" },
    ),
    bindings,
    {
      async authorizeOwner() {
        return secureJsonResponse(
          { error: "unauthorized" },
          { status: 401 },
        );
      },
      async loadSnapshot() {
        reads += 1;
        return snapshot;
      },
      clock: () => Date.parse(snapshot.generatedAt),
    },
  );
  assert.ok(unauthenticatedMismatch);
  assert.equal(unauthenticatedMismatch.status, 401);
  assert.equal(
    (await unauthenticatedMismatch.arrayBuffer()).byteLength,
    0,
  );
  assert.equal(reads, 0);

  const forbiddenHead = await routeOperationalReadRequest(
    new Request(
      "https://guard.example/v1/sites/other-site/environments/production/operability",
      { method: "HEAD" },
    ),
    bindings,
    {
      authorizeOwner: allowedAuthorization([]),
      async loadSnapshot() {
        reads += 1;
        return snapshot;
      },
      clock: () => Date.parse(snapshot.generatedAt),
    },
  );
  assert.ok(forbiddenHead);
  assertHeadParity(mismatch, forbiddenHead);
  assert.equal((await forbiddenHead.arrayBuffer()).byteLength, 0);
  assert.equal(reads, 0);

  const unknown = unknownV1Response(
    new Request("https://guard.example/v1/not-a-route"),
  );
  assert.equal(unknown.status, 404);
  assert.deepEqual(await unknown.json(), { error: "not_found" });
  assert.equal(unknown.headers.get("cache-control"), "private, no-store, max-age=0");

  const unknownHead = unknownV1Response(
    new Request("https://guard.example/v1/not-a-route", {
      method: "HEAD",
    }),
  );
  assert.equal(unknownHead.status, 404);
  assertHeadParity(unknown, unknownHead);
  assert.equal((await unknownHead.arrayBuffer()).byteLength, 0);
});
