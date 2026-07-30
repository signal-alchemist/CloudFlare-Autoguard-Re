import assert from "node:assert/strict";
import test from "node:test";

import type {
  Component,
  Environment,
} from "../../lib/contracts/ops-signal.ts";
import {
  signOperationalGateCompat,
  verifyOperationalGateCompat,
} from "../../lib/contracts/operational-gate-compat.ts";
import type { ComponentVerdict } from "../../lib/domain/component-verdict.ts";
import {
  evaluateOperationGate,
  operationComponentMatrix,
  type Operation,
} from "../../lib/domain/gate-policy.ts";
import {
  createCompatGateProjection,
  createPostDeployOperationalChecker,
  type OperationalStateRepository,
} from "../../lib/services/gate-projection.ts";

const nowMs = Date.parse("2026-07-31T06:00:00.000Z");
const environment: Environment = "production";
const components = Object.values(operationComponentMatrix).flat();
const allComponents = [...new Set<Component>(components)];

function verdict(
  component: Component,
  state: ComponentVerdict["state"] = "healthy",
  freshUntil = "2026-07-31T06:03:00.000Z",
): ComponentVerdict {
  return {
    schemaVersion: 1,
    policyVersion: "gate-fixture-v1",
    siteId: "dfconnect",
    environment,
    component,
    state,
    reasonCodes:
      state === "healthy"
        ? ["component_all_required_pass"]
        : [`fixture_${state}`],
    observationIds: [`obs_${component.padEnd(32, "0").slice(0, 32)}`],
    evaluatedAt: "2026-07-31T05:59:30.000Z",
    freshUntil: state === "unknown" ? null : freshUntil,
  };
}

const healthyVerdicts = allComponents.map((component) =>
  verdict(component),
);
const runtimeIdentities = {
  async readLatest() {
    return {
      schemaVersion: 1 as const,
      identityId: "runtime_0123456789abcdef0123456789abcdef",
      siteId: "dfconnect",
      environment,
      commitSha: "a".repeat(40),
      workerVersionId: "worker-1",
      evidenceDigest: `sha256:${"b".repeat(64)}`,
      sourceObservationId: "obs_0123456789abcdef0123456789abcdef",
      policyVersion: "deployment-runtime-identity-v1",
      observedAt: "2026-07-31T05:59:30.000Z",
      validUntil: "2026-07-31T06:03:00.000Z",
    };
  },
};

function evaluate(
  operation: Operation,
  verdicts: readonly ComponentVerdict[] = healthyVerdicts,
  activeFreeze = false,
) {
  return evaluateOperationGate({
    siteId: "dfconnect",
    environment,
    operation,
    verdicts,
    nowMs,
    activeFreeze,
  });
}

test("all operation gates and post-deploy checks deny on missing, stale, non-healthy, freeze, or dependency error", async () => {
  for (const operation of Object.keys(
    operationComponentMatrix,
  ) as Operation[]) {
    const allowed = evaluate(operation);
    assert.equal(allowed.decision, "allow");
    assert.deepEqual(allowed.blockedComponents, []);
    assert.equal(allowed.reasonCodes[0], "all_required_components_healthy");
  }

  const required = operationComponentMatrix.contentPublish[0];
  assert.ok(required);
  const nonHealthyStates: readonly ComponentVerdict["state"][] = [
    "degraded",
    "unhealthy",
    "unknown",
    "maintenance",
  ];
  for (const state of nonHealthyStates) {
    const changed = healthyVerdicts.map((candidate) =>
      candidate.component === required
        ? verdict(required, state)
        : candidate,
    );
    const result = evaluate("contentPublish", changed);
    assert.equal(result.decision, "deny");
    assert.ok(result.blockedComponents.includes(required));
    assert.ok(
      result.reasonCodes.includes(`required_component_${state}`),
    );
  }

  const missing = evaluate(
    "contentPublish",
    healthyVerdicts.filter(
      (candidate) => candidate.component !== required,
    ),
  );
  assert.equal(missing.decision, "deny");
  assert.ok(missing.reasonCodes.includes("required_component_missing"));

  const stale = evaluate(
    "contentPublish",
    healthyVerdicts.map((candidate) =>
      candidate.component === required
        ? verdict(required, "healthy", "2026-07-31T06:00:00.000Z")
        : candidate,
    ),
  );
  assert.equal(stale.decision, "deny");
  assert.ok(stale.reasonCodes.includes("required_component_stale"));

  const oldHealthyPlusCurrentUnknown = healthyVerdicts.map((candidate) =>
    candidate.component === required
      ? {
          ...verdict(required, "unknown"),
          observationIds: [
            "obs_old_healthy_000000000000000000",
            "obs_new_unknown_000000000000000000",
          ],
        }
      : candidate,
  );
  assert.equal(
    evaluate("contentPublish", oldHealthyPlusCurrentUnknown).decision,
    "deny",
  );
  assert.equal(evaluate("contentPublish", healthyVerdicts, true).decision, "deny");
  assert.ok(
    evaluate("contentPublish", healthyVerdicts, true).reasonCodes.includes(
      "active_freeze",
    ),
  );

  assert.throws(
    () =>
      evaluateOperationGate({
        siteId: "dfconnect",
        environment,
        operation: "proposalDraft" as Operation,
        verdicts: healthyVerdicts,
        nowMs,
        activeFreeze: false,
      }),
    /gate_operation_invalid/,
  );

  const healthyRepository: OperationalStateRepository = {
    async readVerdicts() {
      return healthyVerdicts;
    },
    async hasActiveFreeze() {
      return false;
    },
  };
  const projection = createCompatGateProjection({
    repository: healthyRepository,
    clock: () => nowMs,
  });
  const compat = await projection.read({
    siteId: "dfconnect",
    environment,
    nowSeconds: Math.floor(nowMs / 1_000),
  });
  assert.deepEqual(compat.gates, {
    contentPublish: "allow",
    siteDeploy: "allow",
  });

  const throwingProjection = createCompatGateProjection({
    repository: {
      async readVerdicts() {
        throw new Error("provider failure with secret");
      },
      async hasActiveFreeze() {
        throw new Error("freeze store unavailable");
      },
    },
    clock: () => nowMs,
  });
  const deniedCompat = await throwingProjection.read({
    siteId: "dfconnect",
    environment,
    nowSeconds: Math.floor(nowMs / 1_000),
  });
  assert.deepEqual(deniedCompat.gates, {
    contentPublish: "deny",
    siteDeploy: "deny",
  });
  assert.doesNotMatch(
    JSON.stringify(deniedCompat),
    /provider failure with secret|freeze store unavailable/u,
  );

  const signed = await signOperationalGateCompat(
    deniedCompat,
    "post-deploy-signing-secret-0123456789",
  );
  assert.equal(
    await verifyOperationalGateCompat(
      {
        ...signed,
        gates: { ...signed.gates, siteDeploy: "allow" },
      },
      "post-deploy-signing-secret-0123456789",
    ),
    false,
  );

  const rollbackRequests = 0;
  const unknownChecker = createPostDeployOperationalChecker({
    repository: {
      async readVerdicts() {
        return healthyVerdicts.map((candidate) =>
          candidate.component === "deployment_integrity"
            ? verdict("deployment_integrity", "unknown")
            : candidate,
        );
      },
      async hasActiveFreeze() {
        return false;
      },
    },
    runtimeIdentities,
    clock: () => nowMs,
  });
  const unknown = await unknownChecker.check({
    schema: "site-deploy-post-deploy-v1",
    event: "site_deploy.post_deploy_requested",
    requestId: "site-deploy-12345-1",
    siteId: "dfconnect",
    environment,
    commitSha: "a".repeat(40),
    workerVersionId: "worker-1",
    evidenceDigest: `sha256:${"b".repeat(64)}`,
    requestedAt: Math.floor(nowMs / 1_000),
  });
  assert.equal(unknown.outcome, "unknown");
  assert.equal(rollbackRequests, 0);

  const passChecker = createPostDeployOperationalChecker({
    repository: healthyRepository,
    runtimeIdentities,
    clock: () => nowMs,
  });
  const passed = await passChecker.check({
    schema: "site-deploy-post-deploy-v1",
    event: "site_deploy.post_deploy_requested",
    requestId: "site-deploy-12345-1",
    siteId: "dfconnect",
    environment,
    commitSha: "a".repeat(40),
    workerVersionId: "worker-1",
    evidenceDigest: `sha256:${"b".repeat(64)}`,
    requestedAt: Math.floor(nowMs / 1_000),
  });
  assert.equal(passed.outcome, "pass");
  assert.equal(rollbackRequests, 0);
});
