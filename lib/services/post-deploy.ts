import {
  ContractError,
} from "../contracts/ops-signal.ts";
import {
  buildSignedPostDeployVerdict,
  type PostDeployRequest,
  type SignedPostDeployVerdict,
  type VerifiedPostDeployRequest,
} from "../contracts/post-deploy.ts";
import {
  type D1PostDeployRepository,
  type PostDeployOutcome,
} from "../repositories/post-deploy.ts";

export const postDeployInfrastructureReasonCode =
  "post_deploy_infrastructure_unavailable";

export interface PostDeployCheckResult {
  outcome: PostDeployOutcome;
  reasonCode: string;
  checkedAt: number;
  freshUntil?: number;
}

export interface PostDeployCheckerPort {
  check(request: PostDeployRequest): Promise<PostDeployCheckResult>;
}

export interface ProcessPostDeployDependencies {
  repository: D1PostDeployRepository;
  checker: PostDeployCheckerPort;
  signingSecret: string;
}

export interface ProcessPostDeployResult {
  status: "completed" | "duplicate" | "in_progress";
  outcome: PostDeployOutcome;
  reasonCode: string;
  receipt: SignedPostDeployVerdict | null;
}

function invalid(code: string): never {
  throw new ContractError(code);
}

function validateCheckResult(
  request: PostDeployRequest,
  result: PostDeployCheckResult,
): void {
  if (
    !/^[A-Za-z0-9_.:-]{1,128}$/u.test(result.reasonCode) ||
    !Number.isSafeInteger(result.checkedAt) ||
    result.checkedAt < request.requestedAt - 30 ||
    result.checkedAt > request.requestedAt + 300 ||
    (result.outcome !== "pass" &&
      result.outcome !== "fail" &&
      result.outcome !== "unknown")
  ) {
    invalid("post_deploy_check_result_invalid");
  }
  if (
    result.outcome === "pass" &&
    (!Number.isSafeInteger(result.freshUntil) ||
      result.freshUntil! <= result.checkedAt ||
      result.freshUntil! > result.checkedAt + 3_600)
  ) {
    invalid("post_deploy_check_freshness_invalid");
  }
}

export async function processPostDeployRequest(
  verified: VerifiedPostDeployRequest,
  dependencies: ProcessPostDeployDependencies,
): Promise<ProcessPostDeployResult> {
  const claim = await dependencies.repository.claim(verified);
  if (claim.receipt) {
    return {
      status: "duplicate",
      outcome: "pass",
      reasonCode: "post_deploy_checks_passed",
      receipt: claim.receipt,
    };
  }
  if (claim.status === "existing") {
    return {
      status: claim.state === "claimed" ? "in_progress" : "duplicate",
      outcome: claim.state === "claimed" ? "unknown" : claim.state,
      reasonCode:
        claim.state === "claimed"
          ? "post_deploy_check_in_progress"
          : claim.reasonCode ?? `post_deploy_checks_${claim.state}`,
      receipt: null,
    };
  }

  let check: PostDeployCheckResult;
  try {
    check = await dependencies.checker.check(verified.request);
    validateCheckResult(verified.request, check);
  } catch {
    check = {
      outcome: "unknown",
      reasonCode: postDeployInfrastructureReasonCode,
      checkedAt: verified.verifiedAtSeconds,
    };
  }
  let receipt: SignedPostDeployVerdict | null = null;
  if (check.outcome === "pass") {
    receipt = await buildSignedPostDeployVerdict(
      {
        requestId: verified.request.requestId,
        siteId: verified.request.siteId,
        environment: verified.request.environment,
        commitSha: verified.request.commitSha,
        decision: "allow",
        checkedAt: check.checkedAt,
        freshUntil: check.freshUntil!,
      },
      dependencies.signingSecret,
    );
  }
  await dependencies.repository.complete({
    requestId: verified.request.requestId,
    outcome: check.outcome,
    reasonCode: check.reasonCode,
    checkedAt: check.checkedAt,
    receipt,
  });
  return {
    status: "completed",
    outcome: check.outcome,
    reasonCode: check.reasonCode,
    receipt,
  };
}
