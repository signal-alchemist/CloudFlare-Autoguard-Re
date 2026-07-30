import type { Environment } from "../contracts/ops-signal.ts";
import {
  loadCanonicalOperabilityFromBindings,
  type GuardReadBindings,
} from "../services/canonical-operability.ts";
import {
  createUnavailableDashboardSnapshot,
  toDashboardSnapshot,
  type DashboardSnapshot,
} from "../ui/dashboard-model.ts";

function fallbackScope(bindings?: GuardReadBindings): {
  siteId: string;
  environment: Environment;
} {
  const siteId =
    typeof bindings?.GUARD_SITE_ID === "string" &&
    /^[a-z][a-z0-9-]{2,63}$/u.test(bindings.GUARD_SITE_ID)
      ? bindings.GUARD_SITE_ID
      : "dfconnect";
  const environment =
    bindings?.GUARD_ENVIRONMENT === "staging" ||
    bindings?.GUARD_ENVIRONMENT === "production"
      ? bindings.GUARD_ENVIRONMENT
      : "production";
  return { siteId, environment };
}

export async function loadConsoleSnapshotFromBindings(
  bindings: GuardReadBindings,
  clock: () => number = Date.now,
): Promise<DashboardSnapshot> {
  const scope = fallbackScope(bindings);
  try {
    return toDashboardSnapshot(
      await loadCanonicalOperabilityFromBindings(bindings, clock),
    );
  } catch {
    return createUnavailableDashboardSnapshot(
      scope.environment,
      scope.siteId,
    );
  }
}
