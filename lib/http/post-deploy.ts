import {
  ContractError,
  stableJson,
} from "../contracts/ops-signal.ts";
import {
  verifyPostDeployRequest,
  type PostDeployCredential,
} from "../contracts/post-deploy.ts";
import {
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
    const code =
      error instanceof ContractError ? error.code : "post_deploy_failed";
    const status =
      code === "post_deploy_auth_invalid" ||
      code === "post_deploy_signature_invalid"
        ? 401
        : code === "post_deploy_idempotency_conflict"
          ? 409
          : 400;
    return json({ error: code }, status);
  }
}
