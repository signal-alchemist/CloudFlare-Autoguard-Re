import {
  ContractError,
  stableJson,
} from "../contracts/ops-signal.ts";
import {
  verifyPostDeployRequest,
  type PostDeployCredential,
} from "../contracts/post-deploy.ts";
import {
  postDeployInfrastructureReasonCode,
  processPostDeployRequest,
  type PostDeployCheckerPort,
} from "../services/post-deploy.ts";
import type { D1PostDeployRepository } from "../repositories/post-deploy.ts";

export interface PostDeployHttpDependencies {
  credential: PostDeployCredential;
  repository: D1PostDeployRepository;
  checker: PostDeployCheckerPort;
  clockSeconds(): number;
}

function json(body: unknown, status: number): Response {
  return new Response(stableJson(body), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json",
    },
  });
}

function unavailable(): Response {
  return json({ error: "service_unavailable" }, 503);
}

const malformedRequestCodes = new Set([
  "post_deploy_request_invalid",
  "post_deploy_request_unknown_field",
  "post_deploy_schema_invalid",
  "post_deploy_request_id_invalid",
  "post_deploy_site_id_invalid",
  "post_deploy_environment_invalid",
  "post_deploy_commit_sha_invalid",
  "post_deploy_worker_version_invalid",
  "post_deploy_evidence_digest_invalid",
  "post_deploy_timestamp_invalid",
  "post_deploy_body_invalid",
  "post_deploy_body_noncanonical",
  "post_deploy_request_stale",
  "post_deploy_request_from_future",
]);

export async function handlePostDeployRequest(
  request: Request,
  dependencies: PostDeployHttpDependencies,
): Promise<Response> {
  if (request.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }
  if (request.headers.get("content-type") !== "application/json") {
    return json({ error: "content_type_invalid" }, 415);
  }
  let rawBody: Uint8Array<ArrayBuffer>;
  try {
    rawBody = new Uint8Array(await request.arrayBuffer());
  } catch {
    return json({ error: "request_invalid" }, 400);
  }
  try {
    const verified = await verifyPostDeployRequest({
      rawBody,
      authorization: request.headers.get("authorization"),
      signature: request.headers.get("x-dfconnect-signature"),
      nowSeconds: dependencies.clockSeconds(),
      credential: dependencies.credential,
    });
    const result = await processPostDeployRequest(verified, {
      repository: dependencies.repository,
      checker: dependencies.checker,
      signingSecret: dependencies.credential.signingSecret,
    });
    if (result.receipt) return json(result.receipt, 200);
    if (result.reasonCode === postDeployInfrastructureReasonCode) {
      return unavailable();
    }
    return json(
      {
        schema: "post-deploy-evaluation-v1",
        requestId: verified.request.requestId,
        outcome: result.outcome,
        reasonCode: result.reasonCode,
      },
      result.outcome === "fail" ? 409 : 503,
    );
  } catch (error) {
    if (!(error instanceof ContractError)) return unavailable();
    if (
      error.code === "post_deploy_auth_invalid" ||
      error.code === "post_deploy_signature_invalid"
    ) {
      return json({ error: "unauthorized" }, 401);
    }
    if (error.code === "post_deploy_scope_invalid") {
      return json({ error: "forbidden" }, 403);
    }
    if (error.code === "post_deploy_idempotency_conflict") {
      return json({ error: "idempotency_conflict" }, 409);
    }
    return malformedRequestCodes.has(error.code)
      ? json({ error: "request_invalid" }, 400)
      : unavailable();
  }
}
