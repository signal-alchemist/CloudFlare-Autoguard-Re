import {
  stableJson,
  verifyMaintenanceRequest,
  type MaintenanceRequestCredential,
} from "../contracts/maintenance-request.ts";
import { ContractError } from "../contracts/ops-signal.ts";
import type { D1MaintenanceRequestRepository } from "../repositories/maintenance-requests.ts";
import { processMaintenanceRequest } from "../services/maintenance-request.ts";

const maximumBodyBytes = 64 * 1_024;
const malformedRequestCodes = new Set([
  "maintenance_request_invalid",
  "maintenance_request_unknown_field",
  "maintenance_schema_invalid",
  "maintenance_request_id_invalid",
  "maintenance_site_id_invalid",
  "maintenance_environment_invalid",
  "maintenance_requested_by_invalid",
  "maintenance_reason_code_invalid",
  "maintenance_timestamp_invalid",
  "maintenance_body_invalid",
  "maintenance_body_noncanonical",
  "maintenance_request_stale",
  "maintenance_request_from_future",
  "maintenance_expiry_invalid",
]);

export interface MaintenanceRequestHttpDependencies {
  credential: MaintenanceRequestCredential;
  repository: D1MaintenanceRequestRepository;
  clockSeconds(): number;
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

function unavailable(): Response {
  return json({ error: "service_unavailable" }, 503);
}

async function readLimitedBody(
  request: Request,
): Promise<Uint8Array<ArrayBuffer>> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/u.test(contentLength)) {
      throw new ContractError("maintenance_request_invalid");
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
    error.code === "maintenance_auth_invalid" ||
    error.code === "maintenance_signature_invalid"
  ) {
    return json({ error: "unauthorized" }, 401);
  }
  if (error.code === "maintenance_scope_invalid") {
    return json({ error: "forbidden" }, 403);
  }
  if (error.code === "maintenance_idempotency_conflict") {
    return json({ error: "idempotency_conflict" }, 409);
  }
  return malformedRequestCodes.has(error.code)
    ? json({ error: "request_invalid" }, 400)
    : unavailable();
}

export async function handleMaintenanceRequest(
  request: Request,
  dependencies: MaintenanceRequestHttpDependencies,
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
    const verified = await verifyMaintenanceRequest({
      rawBody,
      authorization: request.headers.get("authorization"),
      signature: request.headers.get("x-dfconnect-signature"),
      nowSeconds: dependencies.clockSeconds(),
      credential: dependencies.credential,
    });
    const result = await processMaintenanceRequest(verified, {
      repository: dependencies.repository,
      signingSecret: dependencies.credential.signingSecret,
    });
    return json(
      result.receipt,
      result.status === "accepted" ? 202 : 200,
    );
  } catch (error) {
    return error instanceof ContractError
      ? contractErrorResponse(error)
      : unavailable();
  }
}
