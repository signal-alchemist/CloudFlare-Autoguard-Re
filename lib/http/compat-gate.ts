import {
  bearerTokenMatches,
  stableJson,
  type Environment,
} from "../contracts/ops-signal.ts";
import {
  signOperationalGateCompat,
  type SignedOperationalGateCompat,
  type UnsignedOperationalGateCompat,
} from "../contracts/operational-gate-compat.ts";

export interface CompatGateConfiguration {
  siteId: string;
  environment: Environment;
  serviceToken: string;
  signingSecret: string;
  clock(): number;
}

export interface CompatGateProjectionPort {
  read(input: {
    siteId: string;
    environment: Environment;
    nowSeconds: number;
  }): Promise<UnsignedOperationalGateCompat>;
}

function response(
  body: unknown,
  status: number,
  headers: HeadersInit = {},
): Response {
  return new Response(stableJson(body), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json",
      ...headers,
    },
  });
}

function validConfiguration(
  configuration: CompatGateConfiguration,
): boolean {
  return (
    /^[a-z][a-z0-9-]{2,63}$/u.test(configuration.siteId) &&
    (configuration.environment === "staging" ||
      configuration.environment === "production") &&
    configuration.serviceToken.length >= 16 &&
    configuration.serviceToken.length <= 4_096 &&
    !/[\r\n]/u.test(configuration.serviceToken) &&
    new TextEncoder().encode(configuration.signingSecret).byteLength >= 32 &&
    Number.isFinite(configuration.clock())
  );
}

async function authorized(
  request: Request,
  configuredToken: string,
): Promise<boolean> {
  const authorization = request.headers.get("authorization");
  if (
    authorization === null ||
    !authorization.startsWith("Bearer ") ||
    /[\r\n,]/u.test(authorization)
  ) {
    return false;
  }
  const candidate = authorization.slice("Bearer ".length);
  if (candidate.length < 16 || candidate.length > 4_096) return false;
  try {
    return await bearerTokenMatches(candidate, configuredToken);
  } catch {
    return false;
  }
}

function failClosed(
  configuration: CompatGateConfiguration,
  nowSeconds: number,
): UnsignedOperationalGateCompat {
  return {
    siteId: configuration.siteId,
    environment: configuration.environment,
    gates: {
      contentPublish: "deny",
      siteDeploy: "deny",
    },
    checkedAt: nowSeconds,
    freshUntil: nowSeconds + 30,
    freeze: false,
  };
}

export async function handleCompatGateRequest(
  request: Request,
  configuration: CompatGateConfiguration,
  projection: CompatGateProjectionPort,
): Promise<Response> {
  if (request.method !== "GET") {
    return response(
      { error: "method_not_allowed" },
      405,
      { allow: "GET" },
    );
  }
  if (!validConfiguration(configuration)) {
    return response({ error: "service_unavailable" }, 503);
  }
  if (!(await authorized(request, configuration.serviceToken))) {
    return response({ error: "unauthorized" }, 401);
  }
  const nowSeconds = Math.floor(configuration.clock() / 1_000);
  let payload: SignedOperationalGateCompat;
  try {
    const candidate = await projection.read({
      siteId: configuration.siteId,
      environment: configuration.environment,
      nowSeconds,
    });
    payload = await signOperationalGateCompat(
      candidate,
      configuration.signingSecret,
    );
  } catch {
    payload = await signOperationalGateCompat(
      failClosed(configuration, nowSeconds),
      configuration.signingSecret,
    );
  }
  return response(payload, 200);
}
