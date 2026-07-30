import {
  ContractError,
  type Component,
  type Environment,
} from "../contracts/ops-signal.ts";
import {
  evaluateRequiredComponents,
  type ComponentVerdict,
} from "./component-verdict.ts";

export type Operation =
  | "contentPublish"
  | "siteDeploy"
  | "contactAccept"
  | "destructiveRecovery";

export const operationComponentMatrix: Readonly<
  Record<Operation, readonly Component[]>
> = {
  contentPublish: [
    "public_delivery",
    "editorial",
    "media_delivery",
    "deployment_integrity",
    "autoguard_control_plane",
  ],
  siteDeploy: [
    "public_delivery",
    "deployment_integrity",
    "recovery_readiness",
    "autoguard_control_plane",
  ],
  contactAccept: [
    "contact_intake",
    "notification_delivery",
    "autoguard_control_plane",
  ],
  destructiveRecovery: [
    "deployment_integrity",
    "recovery_readiness",
    "autoguard_control_plane",
  ],
};

export interface EvaluateOperationGateInput {
  siteId: string;
  environment: Environment;
  operation: Operation;
  verdicts: readonly ComponentVerdict[];
  nowMs: number;
  activeFreeze: boolean;
}

export interface OperationGateEvaluation {
  schemaVersion: 1;
  siteId: string;
  environment: Environment;
  operation: Operation;
  decision: "allow" | "deny";
  reasonCodes: readonly string[];
  blockedComponents: readonly Component[];
  evaluatedAt: string;
  freshUntil: string | null;
  freeze: boolean;
}

function invalid(code: string): never {
  throw new ContractError(code);
}

export function evaluateOperationGate(
  input: EvaluateOperationGateInput,
): OperationGateEvaluation {
  if (
    !/^[a-z][a-z0-9-]{2,63}$/u.test(input.siteId) ||
    (input.environment !== "staging" &&
      input.environment !== "production") ||
    !Object.hasOwn(operationComponentMatrix, input.operation) ||
    !Number.isFinite(input.nowMs) ||
    typeof input.activeFreeze !== "boolean"
  ) {
    invalid("gate_operation_invalid");
  }
  const required = operationComponentMatrix[input.operation];
  const componentDecision = evaluateRequiredComponents({
    siteId: input.siteId,
    environment: input.environment,
    requiredComponents: required,
    verdicts: input.verdicts,
    nowMs: input.nowMs,
  });
  const frozen = input.activeFreeze;
  return {
    schemaVersion: 1,
    siteId: input.siteId,
    environment: input.environment,
    operation: input.operation,
    decision:
      !frozen && componentDecision.decision === "allow"
        ? "allow"
        : "deny",
    reasonCodes: frozen
      ? ["active_freeze"]
      : componentDecision.reasonCodes,
    blockedComponents: frozen
      ? [...required]
      : componentDecision.blockedComponents,
    evaluatedAt: new Date(input.nowMs).toISOString(),
    freshUntil: frozen ? null : componentDecision.freshUntil,
    freeze: frozen,
  };
}
