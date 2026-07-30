import {
  ContractError,
  type Component,
  type Observation,
} from "../contracts/ops-signal.ts";
import type { IncidentSeverity } from "./incidents.ts";

export const INCIDENT_SEVERITY_POLICY_VERSION =
  "incident-severity-v1";

const productionSeverity = {
  public_delivery: "sev2",
  editorial: "sev3",
  contact_intake: "sev2",
  media_delivery: "sev3",
  notification_delivery: "sev2",
  deployment_integrity: "sev2",
  recovery_readiness: "sev3",
  autoguard_control_plane: "sev2",
} as const satisfies Readonly<Record<Component, IncidentSeverity>>;

export function incidentSeverityForFailure(
  observation: Pick<
    Observation,
    "component" | "environment" | "status"
  >,
): IncidentSeverity {
  if (observation.status !== "fail") {
    throw new ContractError("incident_failure_status_required");
  }
  if (observation.environment === "staging") return "sev3";
  if (observation.environment !== "production") {
    throw new ContractError("incident_failure_environment_invalid");
  }
  return productionSeverity[observation.component] ??
    (() => {
      throw new ContractError("incident_failure_component_invalid");
    })();
}
