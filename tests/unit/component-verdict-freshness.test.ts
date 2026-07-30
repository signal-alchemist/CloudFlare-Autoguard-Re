import assert from "node:assert/strict";
import test from "node:test";

import type {
  Component,
  Observation,
  ObservationSource,
  ObservationStatus,
} from "../../lib/contracts/ops-signal.ts";
import {
  classifyProviderUncertainty,
  evaluateComponentVerdict,
  evaluateRequiredComponents,
  type ComponentPolicyV1,
  type ComponentVerdict,
} from "../../lib/domain/component-verdict.ts";

const now = Date.parse("2026-07-31T02:00:00.000Z");

const policy: ComponentPolicyV1 = {
  schemaVersion: 1,
  policyVersion: "public-delivery-v1",
  siteId: "dfconnect",
  environment: "production",
  component: "public_delivery",
  checks: [
    {
      checkId: "public.apex",
      requiredSources: ["public_probe", "external_probe"],
      failureQuorum: 2,
      maxValiditySeconds: 180,
      maxFutureSkewSeconds: 30,
    },
  ],
};

function observation(
  id: string,
  source: ObservationSource,
  status: ObservationStatus,
  overrides: Partial<Observation> = {},
): Observation {
  return {
    schemaVersion: 1,
    observationId: `obs_${id.padEnd(32, "0").slice(0, 32)}`,
    siteId: "dfconnect",
    environment: "production",
    component: "public_delivery",
    checkId: "public.apex",
    status,
    reasonCode: `fixture_${status}`,
    observedAt: "2026-07-31T01:59:00.000Z",
    validUntil: "2026-07-31T02:01:00.000Z",
    source,
    scope: "https://dfconnect.jp/",
    evidenceId: `ev_${id.padEnd(32, "1").slice(0, 32)}`,
    correlationId: `correlation_${id}`,
    idempotencyKey: `probe:dfconnect:production:${id.padEnd(32, "2")}`,
    ...overrides,
  };
}

function gate(verdicts: readonly ComponentVerdict[]) {
  return evaluateRequiredComponents({
    siteId: "dfconnect",
    environment: "production",
    requiredComponents: ["public_delivery"],
    verdicts,
    nowMs: now,
  });
}

test("component verdicts are deterministic, quorum-aware, and fail closed for missing or stale evidence", () => {
  const localPass = observation("local", "public_probe", "pass");
  const externalPass = observation("external", "external_probe", "pass", {
    validUntil: "2026-07-31T02:00:30.000Z",
  });
  const healthy = evaluateComponentVerdict(
    policy,
    [externalPass, localPass],
    now,
  );
  assert.equal(healthy.state, "healthy");
  assert.equal(healthy.freshUntil, "2026-07-31T02:00:30.000Z");
  assert.deepEqual(healthy.reasonCodes, ["component_all_required_pass"]);
  assert.deepEqual(gate([healthy]), {
    decision: "allow",
    reasonCodes: ["all_required_components_healthy"],
    blockedComponents: [],
    freshUntil: "2026-07-31T02:00:30.000Z",
  });

  const missing = evaluateComponentVerdict(policy, [], now);
  assert.equal(missing.state, "unknown");
  assert.ok(missing.reasonCodes.includes("required_observation_missing"));
  assert.equal(gate([missing]).decision, "deny");

  const stale = evaluateComponentVerdict(
    policy,
    [
      observation("stale-local", "public_probe", "pass", {
        validUntil: "2026-07-31T02:00:00.000Z",
      }),
      externalPass,
    ],
    now,
  );
  assert.equal(stale.state, "unknown");
  assert.ok(stale.reasonCodes.includes("required_observation_stale"));

  const oldPass = observation("old-pass", "public_probe", "pass", {
    observedAt: "2026-07-31T01:58:00.000Z",
    validUntil: "2026-07-31T02:00:30.000Z",
  });
  const newestUnknown = evaluateComponentVerdict(
    policy,
    [
      oldPass,
      observation("new-unknown", "public_probe", "unknown"),
      externalPass,
    ],
    now,
  );
  assert.equal(newestUnknown.state, "unknown");
  assert.ok(
    newestUnknown.reasonCodes.includes("required_observation_unknown"),
  );
  assert.ok(!newestUnknown.observationIds.includes(oldPass.observationId));

  const providerCases = [
    [{ kind: "timeout" } as const, "provider_timeout"],
    [{ kind: "http", status: 403 } as const, "provider_forbidden"],
    [{ kind: "http", status: 429 } as const, "provider_rate_limited"],
    [{ kind: "http", status: 503 } as const, "provider_unavailable"],
    [{ kind: "schema_invalid" } as const, "provider_schema_invalid"],
  ] as const;
  for (const [input, reasonCode] of providerCases) {
    const result = classifyProviderUncertainty(input);
    assert.deepEqual(result, { status: "unknown", reasonCode });
    assert.doesNotMatch(JSON.stringify(result), /healthy|resource_missing/iu);
  }

  const oneFailure = evaluateComponentVerdict(
    policy,
    [localPass, observation("external-fail", "external_probe", "fail")],
    now,
  );
  assert.equal(oneFailure.state, "degraded");
  assert.equal(gate([oneFailure]).decision, "deny");

  const quorumFailure = evaluateComponentVerdict(
    policy,
    [
      observation("local-fail", "public_probe", "fail"),
      observation("external-fail-2", "external_probe", "fail"),
    ],
    now,
  );
  assert.equal(quorumFailure.state, "unhealthy");
  assert.equal(gate([quorumFailure]).decision, "deny");

  const wrongScopeCases: Partial<Observation>[] = [
    { siteId: "other" },
    { environment: "staging" },
    { component: "editorial" },
    { checkId: "public.other" },
    { source: "cms_ops_signal" },
  ];
  for (const wrongScope of wrongScopeCases) {
    const scoped = evaluateComponentVerdict(
      policy,
      [
        observation("wrong-scope", "public_probe", "pass", wrongScope),
        externalPass,
      ],
      now,
    );
    assert.equal(scoped.state, "unknown");
    assert.ok(scoped.reasonCodes.includes("required_observation_missing"));
  }

  const future = evaluateComponentVerdict(
    policy,
    [
      observation("future", "public_probe", "pass", {
        observedAt: "2026-07-31T02:00:31.000Z",
        validUntil: "2026-07-31T02:02:00.000Z",
      }),
      externalPass,
    ],
    now,
  );
  assert.equal(future.state, "unknown");
  assert.ok(future.reasonCodes.includes("observation_from_future"));

  const invalidValidity = evaluateComponentVerdict(
    policy,
    [
      observation("invalid-validity", "public_probe", "pass", {
        observedAt: "2026-07-31T01:59:00.000Z",
        validUntil: "2026-07-31T02:03:01.000Z",
      }),
      externalPass,
    ],
    now,
  );
  assert.equal(invalidValidity.state, "unknown");
  assert.ok(
    invalidValidity.reasonCodes.includes("observation_validity_invalid"),
  );

  const unsupported = evaluateComponentVerdict(
    policy,
    [observation("unsupported", "public_probe", "unsupported"), externalPass],
    now,
  );
  assert.equal(unsupported.state, "unknown");
  assert.ok(
    unsupported.reasonCodes.includes("required_observation_unsupported"),
  );

  const shuffled = evaluateComponentVerdict(
    policy,
    [localPass, externalPass],
    now,
  );
  assert.deepEqual(shuffled, healthy);

  const conflict = evaluateComponentVerdict(
    policy,
    [
      localPass,
      observation("local-conflict", "public_probe", "fail"),
      externalPass,
    ],
    now,
  );
  assert.equal(conflict.state, "unknown");
  assert.ok(conflict.reasonCodes.includes("observation_conflict"));

  const states: readonly ComponentVerdict["state"][] = [
    "degraded",
    "unhealthy",
    "unknown",
    "maintenance",
  ];
  for (const state of states) {
    const denied: ComponentVerdict = { ...healthy, state };
    assert.equal(gate([denied]).decision, "deny");
  }
  assert.equal(gate([]).decision, "deny");

  const wrongComponent: Component = "editorial";
  assert.equal(
    evaluateRequiredComponents({
      siteId: "dfconnect",
      environment: "production",
      requiredComponents: [wrongComponent],
      verdicts: [healthy],
      nowMs: now,
    }).decision,
    "deny",
  );
});
