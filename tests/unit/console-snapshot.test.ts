import assert from "node:assert/strict";
import test from "node:test";

import { loadConsoleSnapshotFromBindings } from "../../lib/runtime/console-snapshot.ts";

test("console snapshot loader fails closed without importing native Worker bindings", async () => {
  const snapshot = await loadConsoleSnapshotFromBindings({
    GUARD_SITE_ID: "dfconnect",
    GUARD_ENVIRONMENT: "staging",
  });

  assert.equal(snapshot.siteId, "dfconnect");
  assert.equal(snapshot.environment, "staging");
  assert.equal(snapshot.dataAvailability, "UNAVAILABLE");
  assert.equal(snapshot.operability, "UNKNOWN");
  assert.equal(snapshot.incidents.active, null);
  assert.equal(snapshot.components.length, 8);
  assert.ok(
    snapshot.components.every(
      (component) => component.activeIncidentCount === null,
    ),
  );
  assert.ok(snapshot.gates.every((gate) => gate.decision === "DENY"));
});
