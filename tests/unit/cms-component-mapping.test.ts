import assert from "node:assert/strict";
import test from "node:test";

import {
  parseCmsOpsSignalEnvelope,
  toObservation,
  type Component,
} from "../../lib/contracts/ops-signal.ts";

const sentAt = "2026-07-31T01:00:00.000Z";

function runtimeEnvelope(
  route: "/api/contact" | "/healthz" | "/img/:width/:object-key" | "/other",
  service: string,
) {
  return parseCmsOpsSignalEnvelope({
    schema: "autoguard-ops-signal-envelope-v1",
    environment: "production",
    sentAt,
    signal: {
      schema: "ops-signal-v1",
      event: "worker.runtime_failure",
      schemaVersion: 1,
      fingerprint: "c".repeat(64),
      severity: "error",
      environment: "production",
      service,
      occurredAt: sentAt,
      status: 500,
      method: "POST",
      route,
      exceptionName: "TypeError",
      message: "sanitized runtime failure",
      requestId: "request_component_mapping",
    },
  });
}

test("CMS failure-only signals map to exactly one isolated component without inferring health", async () => {
  const cases: readonly [
    route: "/api/contact" | "/healthz" | "/img/:width/:object-key" | "/other",
    component: Component,
  ][] = [
    ["/api/contact", "contact_intake"],
    ["/img/:width/:object-key", "media_delivery"],
    ["/healthz", "deployment_integrity"],
    ["/other", "editorial"],
  ];

  for (const [route, component] of cases) {
    const envelope = runtimeEnvelope(
      route,
      "misleading-public-delivery-service-name",
    );
    const observation = await toObservation(envelope, {
      siteId: "dfconnect",
      environment: "production",
      validForSeconds: 180,
    });
    assert.equal(observation.component, component);
    assert.notEqual(observation.component, "public_delivery");
    assert.equal(observation.status, "fail");
    assert.equal(observation.reasonCode, "worker_runtime_failure");
    assert.equal(observation.checkId, "cms_ops.worker_runtime");
    assert.equal(observation.scope, route);
    assert.equal(observation.correlationId, "request_component_mapping");
  }

  const contact = parseCmsOpsSignalEnvelope({
    schema: "autoguard-ops-signal-envelope-v1",
    environment: "production",
    sentAt,
    signal: {
      schema: "ops-signal-v1",
      event: "contact.delivery_failure",
      signalId: "signal_component_mapping",
      environment: "production",
      service: "misleading-contact-intake-service-name",
      occurredAt: sentAt,
      code: "CONTACT_DELIVERY_FAILED",
      correlationId: "correlation_component_mapping",
    },
  });
  const contactObservation = await toObservation(contact, {
    siteId: "dfconnect",
    environment: "production",
    validForSeconds: 180,
  });
  assert.equal(contactObservation.component, "notification_delivery");
  assert.equal(contactObservation.reasonCode, "contact_delivery_failed");
  assert.equal(contactObservation.checkId, "cms_ops.contact_delivery");

  assert.throws(
    () =>
      parseCmsOpsSignalEnvelope({
        schema: "autoguard-ops-signal-envelope-v1",
        environment: "production",
        sentAt,
        signal: {
          schema: "ops-signal-v1",
          event: "contact.received",
          environment: "production",
        },
      }),
    /ops_signal_event_invalid/,
  );
});
