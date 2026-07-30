import type { ComponentPolicyV1 } from "../../lib/domain/component-verdict.ts";
import type { OperationalPolicySetV1 } from "../../lib/repositories/operational-state.ts";
import { dfconnectProductionManifest } from "./dfconnect.production.ts";

const publicDeliveryPolicy = {
  schemaVersion: 1,
  policyVersion: "dfconnect-public-delivery-v1",
  siteId: "dfconnect",
  environment: "production",
  component: "public_delivery",
  checks: dfconnectProductionManifest.checks.map((check) => ({
    checkId: check.checkId,
    requiredSources: ["public_probe", "external_probe"] as const,
    failureQuorum: 2,
    maxValiditySeconds: check.validForSeconds,
    maxFutureSkewSeconds: 30,
  })),
} satisfies ComponentPolicyV1;

export const dfconnectProductionOperationalPolicy = {
  schemaVersion: 1,
  policySetVersion: "dfconnect-production-operational-v1",
  siteId: "dfconnect",
  environment: "production",
  components: [publicDeliveryPolicy],
} satisfies OperationalPolicySetV1;

export function resolveOperationalPolicySet(
  siteId: string,
  environment: "staging" | "production",
): OperationalPolicySetV1 | null {
  return siteId === dfconnectProductionOperationalPolicy.siteId &&
    environment === dfconnectProductionOperationalPolicy.environment
    ? dfconnectProductionOperationalPolicy
    : null;
}
