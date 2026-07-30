import type {
  Environment,
} from "../contracts/ops-signal.ts";
import type {
  UnsignedOperationalGateCompat,
} from "../contracts/operational-gate-compat.ts";
import type { PostDeployRequest } from "../contracts/post-deploy.ts";
import type { ComponentVerdict } from "../domain/component-verdict.ts";
import {
  evaluateDeploymentRuntimeIdentity,
  type DeploymentRuntimeIdentityDecision,
} from "../domain/deployment-runtime-identity.ts";
import {
  evaluateOperationGate,
} from "../domain/gate-policy.ts";
import type { CompatGateProjectionPort } from "../http/compat-gate.ts";
import type {
  DeploymentRuntimeIdentityReader,
} from "../repositories/deployment-runtime-identities.ts";
import type {
  PostDeployCheckerPort,
  PostDeployCheckResult,
} from "./post-deploy.ts";
import {
  postDeployInfrastructureReasonCode,
} from "./post-deploy.ts";

export interface OperationalStateRepository {
  readVerdicts(input: {
    siteId: string;
    environment: Environment;
    nowMs: number;
  }): Promise<readonly ComponentVerdict[]>;
  hasActiveFreeze(input: {
    siteId: string;
    environment: Environment;
    nowMs: number;
  }): Promise<boolean>;
}

export interface GateProjectionDependencies {
  repository: OperationalStateRepository;
  clock(): number;
}

export interface PostDeployProjectionDependencies
  extends GateProjectionDependencies {
  runtimeIdentities: DeploymentRuntimeIdentityReader;
}

function failClosedCompat(
  siteId: string,
  environment: Environment,
  nowSeconds: number,
): UnsignedOperationalGateCompat {
  return {
    siteId,
    environment,
    gates: {
      contentPublish: "deny",
      siteDeploy: "deny",
    },
    checkedAt: nowSeconds,
    freshUntil: nowSeconds + 30,
    freeze: false,
  };
}

function freshUntilSeconds(
  values: readonly (string | null)[],
  fallback: number,
): number {
  const parsed = values
    .filter((value): value is string => value !== null)
    .map((value) => Math.floor(Date.parse(value) / 1_000))
    .filter(Number.isSafeInteger);
  return parsed.length === values.length
    ? Math.min(...parsed)
    : fallback;
}

export function createCompatGateProjection(
  dependencies: GateProjectionDependencies,
): CompatGateProjectionPort {
  return {
    async read(input) {
      const clockMs = dependencies.clock();
      if (
        !Number.isFinite(clockMs) ||
        Math.abs(Math.floor(clockMs / 1_000) - input.nowSeconds) > 5
      ) {
        return failClosedCompat(
          input.siteId,
          input.environment,
          input.nowSeconds,
        );
      }
      try {
        const scope = {
          siteId: input.siteId,
          environment: input.environment,
          nowMs: input.nowSeconds * 1_000,
        };
        const [verdicts, freeze] = await Promise.all([
          dependencies.repository.readVerdicts(scope),
          dependencies.repository.hasActiveFreeze(scope),
        ]);
        const contentPublish = evaluateOperationGate({
          siteId: input.siteId,
          environment: input.environment,
          operation: "contentPublish",
          verdicts,
          nowMs: input.nowSeconds * 1_000,
          activeFreeze: freeze,
        });
        const siteDeploy = evaluateOperationGate({
          siteId: input.siteId,
          environment: input.environment,
          operation: "siteDeploy",
          verdicts,
          nowMs: input.nowSeconds * 1_000,
          activeFreeze: freeze,
        });
        const bothAllow =
          contentPublish.decision === "allow" &&
          siteDeploy.decision === "allow";
        return {
          siteId: input.siteId,
          environment: input.environment,
          gates: {
            contentPublish: contentPublish.decision,
            siteDeploy: siteDeploy.decision,
          },
          checkedAt: input.nowSeconds,
          freshUntil: bothAllow
            ? freshUntilSeconds(
                [
                  contentPublish.freshUntil,
                  siteDeploy.freshUntil,
                ],
                input.nowSeconds + 30,
              )
            : input.nowSeconds + 30,
          freeze,
        };
      } catch {
        return failClosedCompat(
          input.siteId,
          input.environment,
          input.nowSeconds,
        );
      }
    },
  };
}

function unknownResult(
  checkedAt: number,
  reasonCode = "post_deploy_operational_state_unknown",
): PostDeployCheckResult {
  return {
    outcome: "unknown",
    reasonCode,
    checkedAt,
  };
}

export function createPostDeployOperationalChecker(
  dependencies: PostDeployProjectionDependencies,
): PostDeployCheckerPort {
  return {
    async check(request: PostDeployRequest) {
      const nowMs = dependencies.clock();
      const checkedAt = Math.floor(nowMs / 1_000);
      if (!Number.isFinite(nowMs)) {
        return unknownResult(
          request.requestedAt,
          postDeployInfrastructureReasonCode,
        );
      }
      let identityDecision: DeploymentRuntimeIdentityDecision;
      try {
        const identity = await dependencies.runtimeIdentities.readLatest({
          siteId: request.siteId,
          environment: request.environment,
        });
        identityDecision = evaluateDeploymentRuntimeIdentity(
          request,
          identity,
          nowMs,
        );
      } catch {
        return unknownResult(
          checkedAt,
          postDeployInfrastructureReasonCode,
        );
      }
      if (!identityDecision.matched) {
        return unknownResult(checkedAt, identityDecision.reasonCode);
      }
      try {
        const [verdicts, freeze] = await Promise.all([
          dependencies.repository.readVerdicts({
            siteId: request.siteId,
            environment: request.environment,
            nowMs,
          }),
          dependencies.repository.hasActiveFreeze({
            siteId: request.siteId,
            environment: request.environment,
            nowMs,
          }),
        ]);
        const evaluation = evaluateOperationGate({
          siteId: request.siteId,
          environment: request.environment,
          operation: "siteDeploy",
          verdicts,
          nowMs,
          activeFreeze: freeze,
        });
        if (evaluation.decision === "allow") {
          const freshUntil =
            evaluation.freshUntil === null
              ? Number.NaN
              : Math.floor(
                  Date.parse(evaluation.freshUntil) / 1_000,
                );
          if (
            !Number.isSafeInteger(freshUntil) ||
            freshUntil <= checkedAt
          ) {
            return unknownResult(checkedAt);
          }
          const boundedFreshUntil = Math.min(
            freshUntil,
            identityDecision.freshUntil,
          );
          if (boundedFreshUntil <= checkedAt) {
            return unknownResult(
              checkedAt,
              "post_deploy_runtime_identity_stale",
            );
          }
          return {
            outcome: "pass",
            reasonCode: "post_deploy_checks_passed",
            checkedAt,
            freshUntil: boundedFreshUntil,
          };
        }
        const confirmedFailure = evaluation.reasonCodes.includes(
          "required_component_unhealthy",
        );
        return confirmedFailure
          ? {
              outcome: "fail",
              reasonCode: "post_deploy_required_component_unhealthy",
              checkedAt,
            }
          : unknownResult(checkedAt);
      } catch {
        return unknownResult(
          checkedAt,
          postDeployInfrastructureReasonCode,
        );
      }
    },
  };
}
