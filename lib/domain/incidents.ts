import {
  ContractError,
  stableJson,
  type Component,
  type Environment,
  type ObservationSource,
} from "../contracts/ops-signal.ts";

export type IncidentSeverity = "sev1" | "sev2" | "sev3" | "sev4";
export type IncidentState =
  | "open"
  | "acknowledged"
  | "mitigating"
  | "monitoring"
  | "resolved"
  | "manual_required";

export interface IncidentIdentity {
  siteId: string;
  environment: Environment;
  component: Component;
  reasonCode: string;
  scope: string;
}

export interface Incident extends IncidentIdentity {
  incidentId: string;
  fingerprint: string;
  severity: IncidentSeverity;
  state: IncidentState;
  openedAt: string;
  updatedAt: string;
}

export interface IncidentResolutionEvidence {
  consecutiveHealthyResults: number;
  sources: readonly ObservationSource[];
  humanAcknowledged: boolean;
}

export interface IncidentResolutionPolicy {
  minimumConsecutiveHealthy: Readonly<
    Record<IncidentSeverity, number>
  >;
  requiredSources: readonly ObservationSource[];
}

const componentValues = new Set<Component>([
  "public_delivery",
  "editorial",
  "contact_intake",
  "media_delivery",
  "notification_delivery",
  "deployment_integrity",
  "recovery_readiness",
  "autoguard_control_plane",
]);
const severityValues = new Set<IncidentSeverity>([
  "sev1",
  "sev2",
  "sev3",
  "sev4",
]);
const allowedTransitions: Readonly<
  Record<IncidentState, readonly IncidentState[]>
> = {
  open: ["acknowledged", "manual_required"],
  acknowledged: ["mitigating", "manual_required"],
  mitigating: ["monitoring", "manual_required"],
  monitoring: ["mitigating", "resolved", "manual_required"],
  resolved: [],
  manual_required: ["acknowledged"],
};

function invalid(code: string): never {
  throw new ContractError(code);
}

function safeIdentifier(value: string, maximum = 128): boolean {
  return (
    value.length > 0 &&
    value.length <= maximum &&
    /^[A-Za-z0-9_.:-]+$/u.test(value)
  );
}

export function validateIncidentIdentity(
  identity: IncidentIdentity,
): void {
  if (
    !/^[a-z][a-z0-9-]{2,63}$/u.test(identity.siteId) ||
    (identity.environment !== "staging" &&
      identity.environment !== "production") ||
    !componentValues.has(identity.component) ||
    !safeIdentifier(identity.reasonCode) ||
    identity.scope.length < 1 ||
    identity.scope.length > 512 ||
    /[\u0000-\u001f\u007f?#@]/u.test(identity.scope)
  ) {
    invalid("incident_identity_invalid");
  }
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function incidentFingerprint(
  identity: IncidentIdentity,
): Promise<string> {
  validateIncidentIdentity(identity);
  return sha256(
    stableJson({
      component: identity.component,
      environment: identity.environment,
      reasonCode: identity.reasonCode,
      scope: identity.scope,
      siteId: identity.siteId,
    }),
  );
}

function validateResolutionPolicy(
  policy: IncidentResolutionPolicy,
): void {
  if (
    policy.requiredSources.length < 1 ||
    new Set(policy.requiredSources).size !== policy.requiredSources.length ||
    [...severityValues].some(
      (severity) =>
        !Number.isInteger(
          policy.minimumConsecutiveHealthy[severity],
        ) ||
        policy.minimumConsecutiveHealthy[severity] < 1 ||
        policy.minimumConsecutiveHealthy[severity] > 100,
    )
  ) {
    invalid("incident_resolution_policy_invalid");
  }
}

export function assertIncidentTransition(
  incident: Incident,
  toState: IncidentState,
  policy: IncidentResolutionPolicy,
  resolutionEvidence?: IncidentResolutionEvidence,
): void {
  validateResolutionPolicy(policy);
  if (!allowedTransitions[incident.state].includes(toState)) {
    invalid("incident_transition_invalid");
  }
  if (toState !== "resolved") return;
  if (
    resolutionEvidence === undefined ||
    !resolutionEvidence.humanAcknowledged ||
    !Number.isInteger(
      resolutionEvidence.consecutiveHealthyResults,
    ) ||
    resolutionEvidence.consecutiveHealthyResults <
      policy.minimumConsecutiveHealthy[incident.severity] ||
    new Set(resolutionEvidence.sources).size !==
      resolutionEvidence.sources.length ||
    policy.requiredSources.some(
      (source) => !resolutionEvidence.sources.includes(source),
    )
  ) {
    invalid("incident_resolution_evidence_insufficient");
  }
}

export function validateIncidentSeverity(
  severity: IncidentSeverity,
): void {
  if (!severityValues.has(severity)) invalid("incident_severity_invalid");
}
