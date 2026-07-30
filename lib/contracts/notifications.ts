import { stableJson } from "./ops-signal.ts";
import {
  parseSafeNotificationEnvelope,
  sha256Hex,
  type SafeNotificationEnvelope,
} from "../security/safe-output.ts";

export interface CompiledNotificationDelivery {
  envelope: SafeNotificationEnvelope;
  body: string;
  payloadDigest: string;
}

export async function compileNotificationDelivery(
  input: unknown,
): Promise<CompiledNotificationDelivery> {
  const envelope = parseSafeNotificationEnvelope(input);
  const body = stableJson(envelope);
  return {
    envelope,
    body,
    payloadDigest: await sha256Hex(new TextEncoder().encode(body)),
  };
}
