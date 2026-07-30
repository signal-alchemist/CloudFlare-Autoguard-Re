import {
  ContractError,
  stableJson,
  type Component,
  type Environment,
  type Observation,
  type ObservationSource,
} from "../contracts/ops-signal.ts";

export type ComponentState =
  | "healthy"
  | "degraded"
  | "unhealthy"
  | "unknown"
  | "maintenance";

export interface RequiredCheckPolicy {
  checkId: string;
  requiredSources: readonly ObservationSource[];
  failureQuorum: number;
  maxValiditySeconds: number;
  maxFutureSkewSeconds: number;
}

export interface ComponentPolicyV1 {
  schemaVersion: 1;
  policyVersion: string;
  siteId: string;
  environment: Environment;
  component: Component;
  checks: readonly RequiredCheckPolicy[];
}

export interface ComponentVerdict {
  schemaVersion: 1;
  policyVersion: string;
  siteId: string;
  environment: Environment;
  component: Component;
  state: ComponentState;
  reasonCodes: readonly string[];
  observationIds: readonly string[];
  evaluatedAt: string;
  freshUntil: string | null;
}

export interface RequiredComponentsInput {
  siteId: string;
  environment: Environment;
  requiredComponents: readonly Component[];
  verdicts: readonly ComponentVerdict[];
  nowMs: number;
}

export interface RequiredComponentsDecision {
  decision: "allow" | "deny";
  reasonCodes: readonly string[];
  blockedComponents: readonly Component[];
  freshUntil: string | null;
}

export type ProviderUncertainty =
  | { kind: "timeout" }
  | { kind: "http"; status: number }
  | { kind: "schema_invalid" };

export interface UnknownObservationDecision {
  status: "unknown";
  reasonCode:
    | "provider_timeout"
    | "provider_forbidden"
    | "provider_rate_limited"
    | "provider_unavailable"
    | "provider_schema_invalid"
    | "provider_response_unexpected";
}

const safeIdentifier = /^[A-Za-z0-9_.:-]+$/u;

function invalid(code: string): never {
  throw new ContractError(code);
}

function validIdentifier(value: string, maximum = 128): boolean {
  return (
    value.length > 0 &&
    value.length <= maximum &&
    safeIdentifier.test(value)
  );
}

function validatePolicy(policy: ComponentPolicyV1): void {
  if (
    policy.schemaVersion !== 1 ||
    !validIdentifier(policy.policyVersion) ||
    !/^[a-z][a-z0-9-]{2,63}$/u.test(policy.siteId) ||
    policy.checks.length < 1 ||
    policy.checks.length > 64
  ) {
    invalid("component_policy_invalid");
  }
  const checkIds = new Set<string>();
  for (const check of policy.checks) {
    if (
      !validIdentifier(check.checkId) ||
      checkIds.has(check.checkId) ||
      check.requiredSources.length < 1 ||
      new Set(check.requiredSources).size !== check.requiredSources.length ||
      !Number.isInteger(check.failureQuorum) ||
      check.failureQuorum < 1 ||
      check.failureQuorum > check.requiredSources.length ||
      !Number.isInteger(check.maxValiditySeconds) ||
      check.maxValiditySeconds < 1 ||
      check.maxValiditySeconds > 86_400 ||
      !Number.isInteger(check.maxFutureSkewSeconds) ||
      check.maxFutureSkewSeconds < 0 ||
      check.maxFutureSkewSeconds > 3_600
    ) {
      invalid("component_check_policy_invalid");
    }
    checkIds.add(check.checkId);
  }
}

function matchingObservations(
  policy: ComponentPolicyV1,
  check: RequiredCheckPolicy,
  source: ObservationSource,
  observations: readonly Observation[],
): readonly Observation[] {
  return observations.filter(
    (observation) =>
      observation.siteId === policy.siteId &&
      observation.environment === policy.environment &&
      observation.component === policy.component &&
      observation.checkId === check.checkId &&
      observation.source === source,
  );
}

function conflictMaterial(observation: Observation): string {
  return stableJson({
    status: observation.status,
    reasonCode: observation.reasonCode,
    validUntil: observation.validUntil,
    scope: observation.scope,
    evidenceId: observation.evidenceId,
  });
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export function evaluateComponentVerdict(
  policy: ComponentPolicyV1,
  observations: readonly Observation[],
  nowMs: number,
): ComponentVerdict {
  validatePolicy(policy);
  if (!Number.isFinite(nowMs)) invalid("component_evaluation_time_invalid");

  const reasons = new Set<string>();
  const observationIds = new Set<string>();
  let hasUnknown = false;
  let hasDegraded = false;
  let hasQuorumFailure = false;
  let minimumFreshUntil: number | null = null;

  for (const check of policy.checks) {
    let failureCount = 0;
    for (const source of check.requiredSources) {
      const candidates = matchingObservations(
        policy,
        check,
        source,
        observations,
      );
      if (candidates.length === 0) {
        hasUnknown = true;
        reasons.add("required_observation_missing");
        continue;
      }
      const dated = candidates
        .map((observation) => ({
          observation,
          observedAtMs: Date.parse(observation.observedAt),
        }))
        .sort(
          (left, right) =>
            right.observedAtMs - left.observedAtMs ||
            left.observation.observationId.localeCompare(
              right.observation.observationId,
            ),
        );
      const selectedAt = dated[0]?.observedAtMs;
      if (selectedAt === undefined || !Number.isFinite(selectedAt)) {
        hasUnknown = true;
        reasons.add("observation_validity_invalid");
        for (const candidate of candidates) {
          observationIds.add(candidate.observationId);
        }
        continue;
      }
      const latest = dated
        .filter((candidate) => candidate.observedAtMs === selectedAt)
        .map((candidate) => candidate.observation);
      for (const candidate of latest) {
        observationIds.add(candidate.observationId);
      }
      if (
        new Set(latest.map(conflictMaterial)).size > 1
      ) {
        hasUnknown = true;
        reasons.add("observation_conflict");
        continue;
      }
      const selected = latest[0]!;
      const validUntilMs = Date.parse(selected.validUntil);
      if (
        selectedAt > nowMs + check.maxFutureSkewSeconds * 1_000
      ) {
        hasUnknown = true;
        reasons.add("observation_from_future");
        continue;
      }
      if (
        !Number.isFinite(validUntilMs) ||
        validUntilMs <= selectedAt ||
        validUntilMs >
          selectedAt + check.maxValiditySeconds * 1_000
      ) {
        hasUnknown = true;
        reasons.add("observation_validity_invalid");
        continue;
      }
      if (validUntilMs <= nowMs) {
        hasUnknown = true;
        reasons.add("required_observation_stale");
        continue;
      }
      minimumFreshUntil =
        minimumFreshUntil === null
          ? validUntilMs
          : Math.min(minimumFreshUntil, validUntilMs);

      if (selected.status === "fail") {
        failureCount += 1;
        reasons.add("required_observation_failed");
      } else if (selected.status === "degraded") {
        hasDegraded = true;
        reasons.add("required_observation_degraded");
      } else if (selected.status === "unknown") {
        hasUnknown = true;
        reasons.add("required_observation_unknown");
      } else if (selected.status === "unsupported") {
        hasUnknown = true;
        reasons.add("required_observation_unsupported");
      }
    }
    if (failureCount >= check.failureQuorum) {
      hasQuorumFailure = true;
    } else if (failureCount > 0) {
      hasDegraded = true;
    }
  }

  const state: ComponentState = hasQuorumFailure
    ? "unhealthy"
    : hasUnknown
      ? "unknown"
      : hasDegraded
        ? "degraded"
        : "healthy";
  if (state === "healthy") reasons.add("component_all_required_pass");

  return {
    schemaVersion: 1,
    policyVersion: policy.policyVersion,
    siteId: policy.siteId,
    environment: policy.environment,
    component: policy.component,
    state,
    reasonCodes: sortedUnique(reasons),
    observationIds: sortedUnique(observationIds),
    evaluatedAt: new Date(nowMs).toISOString(),
    freshUntil:
      state === "unknown" || minimumFreshUntil === null
        ? null
        : new Date(minimumFreshUntil).toISOString(),
  };
}

export function evaluateRequiredComponents(
  input: RequiredComponentsInput,
): RequiredComponentsDecision {
  if (
    !Number.isFinite(input.nowMs) ||
    !/^[a-z][a-z0-9-]{2,63}$/u.test(input.siteId) ||
    input.requiredComponents.length < 1 ||
    new Set(input.requiredComponents).size !== input.requiredComponents.length
  ) {
    invalid("required_components_input_invalid");
  }
  const blocked = new Set<Component>();
  const reasons = new Set<string>();
  let minimumFreshUntil: number | null = null;

  for (const component of input.requiredComponents) {
    const matching = input.verdicts.filter(
      (verdict) =>
        verdict.siteId === input.siteId &&
        verdict.environment === input.environment &&
        verdict.component === component,
    );
    if (matching.length !== 1) {
      blocked.add(component);
      reasons.add(
        matching.length === 0
          ? "required_component_missing"
          : "required_component_conflict",
      );
      continue;
    }
    const verdict = matching[0]!;
    if (verdict.state !== "healthy") {
      blocked.add(component);
      reasons.add(`required_component_${verdict.state}`);
      continue;
    }
    const freshUntilMs =
      verdict.freshUntil === null ? Number.NaN : Date.parse(verdict.freshUntil);
    if (!Number.isFinite(freshUntilMs) || freshUntilMs <= input.nowMs) {
      blocked.add(component);
      reasons.add("required_component_stale");
      continue;
    }
    minimumFreshUntil =
      minimumFreshUntil === null
        ? freshUntilMs
        : Math.min(minimumFreshUntil, freshUntilMs);
  }

  if (blocked.size === 0) reasons.add("all_required_components_healthy");
  return {
    decision: blocked.size === 0 ? "allow" : "deny",
    reasonCodes: sortedUnique(reasons),
    blockedComponents: [...blocked].sort((left, right) =>
      left.localeCompare(right),
    ),
    freshUntil:
      blocked.size === 0 && minimumFreshUntil !== null
        ? new Date(minimumFreshUntil).toISOString()
        : null,
  };
}

export function classifyProviderUncertainty(
  input: ProviderUncertainty,
): UnknownObservationDecision {
  if (input.kind === "timeout") {
    return { status: "unknown", reasonCode: "provider_timeout" };
  }
  if (input.kind === "schema_invalid") {
    return {
      status: "unknown",
      reasonCode: "provider_schema_invalid",
    };
  }
  if (
    !Number.isInteger(input.status) ||
    input.status < 100 ||
    input.status > 599
  ) {
    invalid("provider_status_invalid");
  }
  const reasonCode =
    input.status === 403
      ? "provider_forbidden"
      : input.status === 429
        ? "provider_rate_limited"
        : input.status >= 500
          ? "provider_unavailable"
          : "provider_response_unexpected";
  return { status: "unknown", reasonCode };
}
