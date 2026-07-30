/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { resolveOperationalPolicySet } from "../config/sites/dfconnect.operational-policy.ts";
import { handleCompatGateRequest } from "../lib/http/compat-gate.ts";
import {
  routeCmsSignalIngress,
  type CmsSignalHttpDependencies,
} from "../lib/http/cms-signal.ts";
import { handlePostDeployRequest } from "../lib/http/post-deploy.ts";
import {
  applyConsoleSecurityHeaders,
  authorizeConsoleRequest,
  consoleAccessErrorResponse,
  createConsoleCspNonce,
  prepareConsoleHtmlRequest,
  verifyCloudflareAccessRequest,
  verifyLocalConsoleRequest,
  verifySitesPrivateRequest,
  type ConsoleAccessDecision,
  type ConsoleEnvironment,
  type ConsoleIdentityVerifier,
} from "../lib/http/console-access.ts";
import {
  D1OperationalStateRepository,
  type D1OperationalDatabasePort,
} from "../lib/repositories/operational-state.ts";
import {
  D1DeploymentRuntimeIdentityRepository,
} from "../lib/repositories/deployment-runtime-identities.ts";
import { D1PostDeployRepository } from "../lib/repositories/post-deploy.ts";
import type { D1DatabasePort } from "../lib/repositories/observations.ts";
import {
  createCompatGateProjection,
  createPostDeployOperationalChecker,
  type OperationalStateRepository,
} from "../lib/services/gate-projection.ts";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  GUARD_SITE_ID?: string;
  GUARD_ENVIRONMENT?: "staging" | "production";
  CMS_GATE_SERVICE_TOKEN?: string;
  CMS_GATE_SIGNING_SECRET?: string;
  CMS_SIGNAL_SERVICE_TOKEN?: string;
  CMS_SIGNAL_SIGNING_SECRET?: string;
  CMS_POST_DEPLOY_SERVICE_TOKEN?: string;
  CMS_POST_DEPLOY_SIGNING_SECRET?: string;
  CONSOLE_AUTH_MODE?:
    | "cloudflare-access"
    | "sites-private"
    | "local-development";
  CONSOLE_ACCESS_AUDIENCE?: string;
  CONSOLE_ACCESS_ISSUER?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

const unavailableOperationalState: OperationalStateRepository = {
  async readVerdicts() {
    throw new Error("operational_state_unavailable");
  },
  async hasActiveFreeze() {
    throw new Error("operational_state_unavailable");
  },
};

function operationalState(env: Env): OperationalStateRepository {
  if (!env.GUARD_SITE_ID || !env.GUARD_ENVIRONMENT || !env.DB) {
    return unavailableOperationalState;
  }
  const policySet = resolveOperationalPolicySet(
    env.GUARD_SITE_ID,
    env.GUARD_ENVIRONMENT,
  );
  if (policySet === null) return unavailableOperationalState;
  try {
    return new D1OperationalStateRepository(
      env.DB as unknown as D1OperationalDatabasePort,
      policySet,
    );
  } catch {
    return unavailableOperationalState;
  }
}

function unavailableJson(): Response {
  return Response.json(
    { error: "service_unavailable" },
    {
      status: 503,
      headers: { "cache-control": "no-store" },
    },
  );
}

function cmsSignalDependencies(
  env: Env,
): CmsSignalHttpDependencies | null {
  if (!env.GUARD_SITE_ID || !env.GUARD_ENVIRONMENT || !env.DB) return null;
  const hasDedicatedCredential =
    env.CMS_SIGNAL_SERVICE_TOKEN !== undefined ||
    env.CMS_SIGNAL_SIGNING_SECRET !== undefined;
  const token = hasDedicatedCredential
    ? env.CMS_SIGNAL_SERVICE_TOKEN
    : env.CMS_GATE_SERVICE_TOKEN;
  const signingSecret = hasDedicatedCredential
    ? env.CMS_SIGNAL_SIGNING_SECRET
    : env.CMS_GATE_SIGNING_SECRET;
  if (!token || !signingSecret) return null;
  return {
    credentials: [
      {
        credentialId: `cms-${env.GUARD_ENVIRONMENT}-v1`,
        token,
        signingSecret,
        siteId: env.GUARD_SITE_ID,
        environment: env.GUARD_ENVIRONMENT,
        maxAgeSeconds: 120,
        maxFutureSkewSeconds: 30,
        validForSeconds: 180,
      },
    ],
    database: env.DB as unknown as D1DatabasePort,
    clock: Date.now,
  };
}

function handleGateRequest(request: Request, env: Env): Promise<Response> {
  if (
    !env.GUARD_SITE_ID ||
    !env.GUARD_ENVIRONMENT ||
    !env.CMS_GATE_SERVICE_TOKEN ||
    !env.CMS_GATE_SIGNING_SECRET
  ) {
    return Promise.resolve(unavailableJson());
  }
  return handleCompatGateRequest(
    request,
    {
      siteId: env.GUARD_SITE_ID,
      environment: env.GUARD_ENVIRONMENT,
      serviceToken: env.CMS_GATE_SERVICE_TOKEN,
      signingSecret: env.CMS_GATE_SIGNING_SECRET,
      clock: Date.now,
    },
    createCompatGateProjection({
      repository: operationalState(env),
      clock: Date.now,
    }),
  );
}

function unavailableConsole(): Response {
  const decision: ConsoleAccessDecision = {
    allowed: false,
    status: 503,
    code: "service_unavailable",
  };
  return consoleAccessErrorResponse(decision);
}

function consoleEnvironment(
  value: Env["GUARD_ENVIRONMENT"],
): ConsoleEnvironment | null {
  return value === "production" || value === "staging" ? value : null;
}

async function handleConsoleRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1";
  const localMode =
    loopback &&
    (env.CONSOLE_AUTH_MODE === undefined ||
      env.CONSOLE_AUTH_MODE === "local-development");
  const siteId = env.GUARD_SITE_ID ?? (localMode ? "dfconnect" : undefined);
  const environment =
    consoleEnvironment(env.GUARD_ENVIRONMENT) ??
    (localMode ? "production" : null);
  const accessAudience =
    env.CONSOLE_ACCESS_AUDIENCE ??
    (localMode ? "guard-local-development" : undefined);
  if (!siteId || environment === null || !accessAudience) {
    return unavailableConsole();
  }

  let verifier: ConsoleIdentityVerifier;
  if (localMode) {
    verifier = (candidate) =>
      verifyLocalConsoleRequest(candidate, accessAudience);
  } else if (env.CONSOLE_AUTH_MODE === "sites-private") {
    verifier = (candidate) =>
      verifySitesPrivateRequest(candidate, accessAudience);
  } else if (
    env.CONSOLE_AUTH_MODE === "cloudflare-access" &&
    env.CONSOLE_ACCESS_ISSUER
  ) {
    verifier = (candidate) =>
      verifyCloudflareAccessRequest(candidate, {
        issuer: env.CONSOLE_ACCESS_ISSUER!,
        audience: accessAudience,
      });
  } else {
    return unavailableConsole();
  }

  const scope = { siteId, environment };
  const decision = await authorizeConsoleRequest(
    request,
    {
      policy: {
        ...scope,
        accessAudience,
      },
      requestedScope: scope,
    },
    verifier,
  );
  if (!decision.allowed) return consoleAccessErrorResponse(decision);

  const nonce = createConsoleCspNonce();
  const securedRequest = prepareConsoleHtmlRequest(request, nonce, scope);
  let response: Response;
  if (url.pathname === "/_vinext/image") {
    const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
    response = await handleImageOptimization(
      securedRequest,
      {
        fetchAsset: (path) =>
          env.ASSETS.fetch(new Request(new URL(path, securedRequest.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body)
            .transform(width > 0 ? { width } : {})
            .output({ format, quality });
          return result.response();
        },
      },
      allowedWidths,
    );
  } else {
    response = await handler.fetch(securedRequest, env, ctx);
  }
  return applyConsoleSecurityHeaders(response, nonce);
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    const cmsIngress = await routeCmsSignalIngress(request, {
      signal: cmsSignalDependencies(env),
      gate: (gateRequest) => handleGateRequest(gateRequest, env),
    });
    if (cmsIngress !== null) return cmsIngress;

    if (url.pathname === "/v1/post-deploy-checks") {
      if (
        !env.GUARD_SITE_ID ||
        !env.GUARD_ENVIRONMENT ||
        !env.DB ||
        !env.CMS_POST_DEPLOY_SERVICE_TOKEN ||
        env.CMS_POST_DEPLOY_SERVICE_TOKEN.length < 16 ||
        env.CMS_POST_DEPLOY_SERVICE_TOKEN.length > 4_096 ||
        /[\r\n]/u.test(env.CMS_POST_DEPLOY_SERVICE_TOKEN) ||
        !env.CMS_POST_DEPLOY_SIGNING_SECRET ||
        new TextEncoder().encode(
          env.CMS_POST_DEPLOY_SIGNING_SECRET,
        ).byteLength < 32
      ) {
        return unavailableJson();
      }
      return handlePostDeployRequest(request, {
        credential: {
          siteId: env.GUARD_SITE_ID,
          environment: env.GUARD_ENVIRONMENT,
          serviceToken: env.CMS_POST_DEPLOY_SERVICE_TOKEN,
          signingSecret: env.CMS_POST_DEPLOY_SIGNING_SECRET,
          maxAgeSeconds: 300,
          maxFutureSkewSeconds: 30,
        },
        repository: new D1PostDeployRepository(
          env.DB as unknown as D1DatabasePort,
        ),
        checker: createPostDeployOperationalChecker({
          repository: operationalState(env),
          runtimeIdentities:
            new D1DeploymentRuntimeIdentityRepository(
              env.DB as unknown as D1DatabasePort,
            ),
          clock: Date.now,
        }),
        clockSeconds: () => Math.floor(Date.now() / 1_000),
      });
    }

    return handleConsoleRequest(request, env, ctx);
  },
};

export default worker;
