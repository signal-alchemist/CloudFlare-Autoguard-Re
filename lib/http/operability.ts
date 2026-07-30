import type { Environment } from "../contracts/ops-signal.ts";
import type {
  CanonicalOperabilitySnapshotV1,
  GuardReadBindings,
} from "../services/canonical-operability.ts";

export type OwnerReadAuthorization = (
  request: Request,
  requestedScope: {
    siteId: string;
    environment: Environment;
  },
) => Promise<Response | null>;

export interface OperationalReadRouteDependencies {
  authorizeOwner: OwnerReadAuthorization;
  loadSnapshot(
    bindings: GuardReadBindings,
    clock: () => number,
  ): Promise<CanonicalOperabilitySnapshotV1>;
  clock(): number;
}

const securityHeaders = {
  "cache-control": "private, no-store, max-age=0",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "x-robots-tag": "noindex, nofollow, noarchive",
} as const;

export function secureJsonResponse(
  body: unknown,
  init: ResponseInit = {},
): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  for (const [name, value] of Object.entries(securityHeaders)) {
    headers.set(name, value);
  }
  return new Response(JSON.stringify(body), {
    ...init,
    headers,
  });
}

export function stripHeadResponse(
  request: Request,
  response: Response,
): Response {
  if (request.method !== "HEAD") return response;
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function methodNotAllowed(request: Request): Response | null {
  if (request.method === "GET" || request.method === "HEAD") return null;
  return secureJsonResponse(
    { error: "method_not_allowed" },
    {
      status: 405,
      headers: { allow: "GET, HEAD" },
    },
  );
}

function environment(value: string): Environment | null {
  return value === "staging" || value === "production" ? value : null;
}

function serverScope(
  bindings: GuardReadBindings,
): { siteId: string; environment: Environment } | null {
  const serverEnvironment = bindings.GUARD_ENVIRONMENT;
  if (
    typeof bindings.GUARD_SITE_ID !== "string" ||
    !/^[a-z][a-z0-9-]{2,63}$/u.test(bindings.GUARD_SITE_ID) ||
    (serverEnvironment !== "staging" &&
      serverEnvironment !== "production")
  ) {
    return null;
  }
  return {
    siteId: bindings.GUARD_SITE_ID,
    environment: serverEnvironment,
  };
}

function canonicalScope(
  pathname: string,
): { siteId: string; environment: Environment } | null {
  const match =
    /^\/v1\/sites\/([a-z][a-z0-9-]{2,63})\/environments\/(staging|production)\/operability$/u.exec(
      pathname,
    );
  if (!match) return null;
  const parsedEnvironment = environment(match[2]!);
  return parsedEnvironment === null
    ? null
    : { siteId: match[1]!, environment: parsedEnvironment };
}

function forbidden(): Response {
  return secureJsonResponse({ error: "forbidden" }, { status: 403 });
}

function unavailable(): Response {
  return secureJsonResponse(
    { error: "service_unavailable" },
    { status: 503 },
  );
}

async function routeOperationalReadRequestBody(
  request: Request,
  bindings: GuardReadBindings,
  dependencies: OperationalReadRouteDependencies,
): Promise<Response | null> {
  const pathname = new URL(request.url).pathname;
  if (pathname === "/live") {
    const disallowed = methodNotAllowed(request);
    return (
      disallowed ??
      secureJsonResponse({
        schema: "guard-liveness-v1",
        status: "live",
      })
    );
  }

  const requestedCanonicalScope = canonicalScope(pathname);
  const readiness = pathname === "/ready";
  if (!readiness && requestedCanonicalScope === null) return null;

  const disallowed = methodNotAllowed(request);
  if (disallowed) return disallowed;
  const configuredScope = serverScope(bindings);
  const requestedScope = requestedCanonicalScope ?? configuredScope;
  if (requestedScope === null) return unavailable();

  const denied = await dependencies.authorizeOwner(
    request,
    requestedScope,
  );
  if (denied) return denied;
  if (
    configuredScope === null ||
    requestedScope.siteId !== configuredScope.siteId ||
    requestedScope.environment !== configuredScope.environment
  ) {
    return forbidden();
  }

  let snapshot: CanonicalOperabilitySnapshotV1;
  try {
    snapshot = await dependencies.loadSnapshot(
      bindings,
      dependencies.clock,
    );
  } catch {
    return readiness
      ? secureJsonResponse(
          {
            schema: "guard-readiness-v1",
            status: "not_ready",
          },
          { status: 503 },
        )
      : unavailable();
  }

  if (readiness) {
    return secureJsonResponse(
      {
        schema: "guard-readiness-v1",
        status: snapshot.readiness.status,
      },
      {
        status: snapshot.readiness.status === "ready" ? 200 : 503,
      },
    );
  }
  return secureJsonResponse(snapshot);
}

export async function routeOperationalReadRequest(
  request: Request,
  bindings: GuardReadBindings,
  dependencies: OperationalReadRouteDependencies,
): Promise<Response | null> {
  const response = await routeOperationalReadRequestBody(
    request,
    bindings,
    dependencies,
  );
  return response === null ? null : stripHeadResponse(request, response);
}

export function unknownV1Response(request: Request): Response {
  return stripHeadResponse(
    request,
    secureJsonResponse({ error: "not_found" }, { status: 404 }),
  );
}
