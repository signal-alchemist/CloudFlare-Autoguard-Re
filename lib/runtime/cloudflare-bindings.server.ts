import { env } from "cloudflare:workers";

import type { GuardReadBindings } from "../services/canonical-operability.ts";

export function readCloudflareGuardBindings(): GuardReadBindings {
  return env as unknown as GuardReadBindings;
}
