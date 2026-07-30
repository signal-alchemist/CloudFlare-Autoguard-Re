import {
  ContractError,
  stableJson,
  verifyCmsOpsSignalRequest,
  type CmsSignalCredential,
} from "../contracts/ops-signal.ts";
import {
  D1ObservationRepository,
  D1ReplayStore,
  type D1DatabasePort,
} from "../repositories/observations.ts";

const maximumBodyBytes = 64 * 1_024;

export interface CmsSignalHttpDependencies {
  credentials: readonly CmsSignalCredential[];
  database: D1DatabasePort;
  clock(): number;
}

export interface CmsSignalIngressDependencies {
  signal: CmsSignalHttpDependencies | null;
  gate(request: Request): Promise<Response>;
}

class BodyTooLargeError extends Error {}

function json(
  body: unknown,
  status: number,
  headers: HeadersInit = {},
): Response {
  return new Response(stableJson(body), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });
}

async function readLimitedBody(
  request: Request,
): Promise<Uint8Array<ArrayBuffer>> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/u.test(contentLength)) {
      throw new ContractError("ops_request_invalid");
    }
    if (Number(contentLength) > maximumBodyBytes) {
      throw new BodyTooLargeError();
    }
  }
  if (request.body === null) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumBodyBytes) {
        await reader.cancel().catch(() => undefined);
        throw new BodyTooLargeError();
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function contractErrorResponse(error: ContractError): Response {
  if (
    error.code === "ops_auth_invalid" ||
    error.code === "ops_signature_invalid"
  ) {
    return json({ error: "unauthorized" }, 401);
  }
  if (error.code === "ops_scope_invalid") {
    return json({ error: "forbidden" }, 403);
  }
  if (
    error.code === "ops_replay_detected" ||
    error.code === "observation_idempotency_conflict"
  ) {
    return json({ error: "replay_rejected" }, 409);
  }
  if (
    error.code === "ops_credential_invalid" ||
    error.code === "ops_credential_duplicate" ||
    error.code === "ops_signing_secret_invalid" ||
    error.code === "replay_claim_invalid"
  ) {
    return json({ error: "service_unavailable" }, 503);
  }
  return json({ error: "request_invalid" }, 400);
}

export async function handleCmsSignalRequest(
  request: Request,
  dependencies: CmsSignalHttpDependencies,
): Promise<Response> {
  if (request.method !== "POST") {
    return json(
      { error: "method_not_allowed" },
      405,
      { allow: "POST" },
    );
  }
  if (request.headers.get("content-type") !== "application/json") {
    return json({ error: "content_type_invalid" }, 415);
  }

  let rawBody: Uint8Array<ArrayBuffer>;
  try {
    rawBody = await readLimitedBody(request);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return json({ error: "payload_too_large" }, 413);
    }
    return error instanceof ContractError
      ? contractErrorResponse(error)
      : json({ error: "request_invalid" }, 400);
  }

  try {
    const now = dependencies.clock();
    const verified = await verifyCmsOpsSignalRequest({
      rawBody,
      authorization: request.headers.get("authorization"),
      signature: request.headers.get("x-dfconnect-signature"),
      now,
      credentials: dependencies.credentials,
      replayStore: new D1ReplayStore(dependencies.database),
    });
    const receipt = await new D1ObservationRepository(
      dependencies.database,
    ).record(verified.observation, new Date(now).toISOString());
    return json(
      {
        schema: "cms-signal-receipt-v1",
        status: receipt.status,
        observationId: receipt.observation.observationId,
        siteId: receipt.observation.siteId,
        environment: receipt.observation.environment,
        correlationId: receipt.observation.correlationId,
      },
      receipt.status === "accepted" ? 202 : 200,
    );
  } catch (error) {
    return error instanceof ContractError
      ? contractErrorResponse(error)
      : json({ error: "service_unavailable" }, 503);
  }
}

export async function routeCmsSignalIngress(
  request: Request,
  dependencies: CmsSignalIngressDependencies,
): Promise<Response | null> {
  const pathname = new URL(request.url).pathname;
  if (pathname === "/v1/signals/cms") {
    if (request.method !== "POST") {
      return json(
        { error: "method_not_allowed" },
        405,
        { allow: "POST" },
      );
    }
    return dependencies.signal === null
      ? json({ error: "service_unavailable" }, 503)
      : handleCmsSignalRequest(request, dependencies.signal);
  }
  if (pathname !== "/compat/v1/gate") return null;
  if (request.method === "POST") {
    return dependencies.signal === null
      ? json({ error: "service_unavailable" }, 503)
      : handleCmsSignalRequest(request, dependencies.signal);
  }
  if (request.method === "GET") {
    try {
      return await dependencies.gate(request);
    } catch {
      return json({ error: "service_unavailable" }, 503);
    }
  }
  return json(
    { error: "method_not_allowed" },
    405,
    { allow: "GET, POST" },
  );
}
