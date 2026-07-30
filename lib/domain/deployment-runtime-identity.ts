import {
  ContractError,
  type Environment,
} from "../contracts/ops-signal.ts";
import type { PostDeployRequest } from "../contracts/post-deploy.ts";

export interface DeploymentRuntimeIdentity {
  schemaVersion: 1;
  identityId: string;
  siteId: string;
  environment: Environment;
  commitSha: string;
  workerVersionId: string;
  evidenceDigest: string;
  sourceObservationId: string;
  policyVersion: string;
  observedAt: string;
  validUntil: string;
}

export type DeploymentRuntimeIdentityDecision =
  | {
      matched: true;
      identityId: string;
      freshUntil: number;
    }
  | {
      matched: false;
      reasonCode:
        | "post_deploy_runtime_identity_missing"
        | "post_deploy_runtime_identity_stale"
        | "post_deploy_runtime_identity_mismatch";
    };

function invalid(): never {
  throw new ContractError("deployment_runtime_identity_invalid");
}

function canonicalIso(value: string): number {
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  ) {
    invalid();
  }
  return milliseconds;
}

export function validateDeploymentRuntimeIdentity(
  identity: DeploymentRuntimeIdentity,
): void {
  if (
    identity.schemaVersion !== 1 ||
    typeof identity.identityId !== "string" ||
    !/^runtime_[a-f0-9]{32}$/u.test(identity.identityId) ||
    typeof identity.siteId !== "string" ||
    !/^[a-z][a-z0-9-]{2,63}$/u.test(identity.siteId) ||
    (identity.environment !== "staging" &&
      identity.environment !== "production") ||
    typeof identity.commitSha !== "string" ||
    !/^[a-f0-9]{40}$/u.test(identity.commitSha) ||
    typeof identity.workerVersionId !== "string" ||
    !/^[a-z0-9][a-z0-9.:-]{2,127}$/u.test(
      identity.workerVersionId,
    ) ||
    typeof identity.evidenceDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(identity.evidenceDigest) ||
    typeof identity.sourceObservationId !== "string" ||
    !/^obs_[a-f0-9]{32}$/u.test(identity.sourceObservationId) ||
    typeof identity.policyVersion !== "string" ||
    identity.policyVersion !== "deployment-runtime-identity-v1"
  ) {
    invalid();
  }
  if (
    typeof identity.observedAt !== "string" ||
    typeof identity.validUntil !== "string"
  ) {
    invalid();
  }
  const observedAt = canonicalIso(identity.observedAt);
  const validUntil = canonicalIso(identity.validUntil);
  if (
    validUntil <= observedAt ||
    validUntil > observedAt + 300_000
  ) {
    invalid();
  }
}

export function evaluateDeploymentRuntimeIdentity(
  request: PostDeployRequest,
  identity: DeploymentRuntimeIdentity | null,
  nowMs: number,
): DeploymentRuntimeIdentityDecision {
  if (identity === null) {
    return {
      matched: false,
      reasonCode: "post_deploy_runtime_identity_missing",
    };
  }
  validateDeploymentRuntimeIdentity(identity);
  const observedAt = Date.parse(identity.observedAt);
  const validUntil = Date.parse(identity.validUntil);
  if (
    !Number.isFinite(nowMs) ||
    observedAt > nowMs + 30_000 ||
    validUntil <= nowMs
  ) {
    return {
      matched: false,
      reasonCode: "post_deploy_runtime_identity_stale",
    };
  }
  if (
    identity.siteId !== request.siteId ||
    identity.environment !== request.environment ||
    identity.commitSha !== request.commitSha ||
    identity.workerVersionId !== request.workerVersionId ||
    identity.evidenceDigest !== request.evidenceDigest
  ) {
    return {
      matched: false,
      reasonCode: "post_deploy_runtime_identity_mismatch",
    };
  }
  return {
    matched: true,
    identityId: identity.identityId,
    freshUntil: Math.floor(validUntil / 1_000),
  };
}
