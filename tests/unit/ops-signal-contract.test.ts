import assert from "node:assert/strict";
import test from "node:test";

import {
  parseCmsOpsSignalEnvelope,
  toObservation,
} from "../../lib/contracts/ops-signal.ts";

const sentAt = "2026-07-31T00:00:00.000Z";

test("accepts the current CMS runtime signal and creates one sanitized observation", async () => {
  const envelope = parseCmsOpsSignalEnvelope({
    schema: "autoguard-ops-signal-envelope-v1",
    environment: "staging",
    sentAt,
    signal: {
      schema: "ops-signal-v1",
      event: "worker.runtime_failure",
      schemaVersion: 1,
      fingerprint: "a".repeat(64),
      severity: "error",
      environment: "staging",
      service: "dfconnect-site-staging",
      occurredAt: sentAt,
      status: 500,
      method: "GET",
      route: "/healthz",
      exceptionName: "TypeError",
      message: "Unhandled Worker exception",
      requestId: "request_123",
      commit: "b".repeat(40),
    },
  });

  const observation = await toObservation(envelope, {
    siteId: "dfconnect",
    environment: "staging",
    validForSeconds: 180,
  });

  assert.equal(observation.schemaVersion, 1);
  assert.equal(observation.siteId, "dfconnect");
  assert.equal(observation.environment, "staging");
  assert.equal(observation.component, "deployment_integrity");
  assert.equal(observation.status, "fail");
  assert.equal(observation.reasonCode, "worker_runtime_failure");
  assert.equal(observation.observedAt, sentAt);
  assert.equal(observation.validUntil, "2026-07-31T00:03:00.000Z");
  assert.equal(observation.source, "cms_ops_signal");
  assert.equal(observation.scope, "/healthz");
  assert.match(observation.observationId, /^obs_[a-f0-9]{32}$/);
  assert.match(observation.evidenceId, /^ev_[a-f0-9]{32}$/);

  const serialized = JSON.stringify(observation);
  assert.doesNotMatch(serialized, /authorization|cookie|token|secret|@/iu);
  assert.doesNotMatch(serialized, /Unhandled Worker exception/);
});

test("accepts contact delivery failure without copying contact data", async () => {
  const envelope = parseCmsOpsSignalEnvelope({
    schema: "autoguard-ops-signal-envelope-v1",
    environment: "production",
    sentAt,
    signal: {
      schema: "ops-signal-v1",
      event: "contact.delivery_failure",
      signalId: "signal_123",
      environment: "production",
      service: "dfconnect-notification-production",
      occurredAt: sentAt,
      code: "CONTACT_DELIVERY_FAILED",
      correlationId: "correlation_123",
    },
  });

  const observation = await toObservation(envelope, {
    siteId: "dfconnect",
    environment: "production",
    validForSeconds: 180,
  });

  assert.equal(observation.component, "notification_delivery");
  assert.equal(observation.reasonCode, "contact_delivery_failed");
  assert.equal(observation.scope, "dfconnect-notification-production");
  assert.equal(observation.correlationId, "correlation_123");
});

