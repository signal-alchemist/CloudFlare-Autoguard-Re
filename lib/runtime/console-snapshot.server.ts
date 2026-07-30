import type { DashboardSnapshot } from "../ui/dashboard-model.ts";
import { readCloudflareGuardBindings } from "./cloudflare-bindings.server.ts";
import { loadConsoleSnapshotFromBindings } from "./console-snapshot.ts";

export async function loadConsoleSnapshot(): Promise<DashboardSnapshot> {
  return loadConsoleSnapshotFromBindings(readCloudflareGuardBindings());
}
