import {
  ContractError,
  signHmacSha256,
  stableJson,
  verifyHmacSha256,
  type Environment,
} from "./ops-signal.ts";

export type OperationalGateDecision = "allow" | "deny";

export interface UnsignedOperationalGateCompat {
  siteId: string;
  environment: Environment;
  gates: {
    contentPublish: OperationalGateDecision;
    siteDeploy: OperationalGateDecision;
  };
  checkedAt: number;
  freshUntil: number;
  freeze: boolean;
}

export interface SignedOperationalGateCompat
  extends UnsignedOperationalGateCompat {
  signature: string;
}

const unsignedKeys = [
  "siteId",
  "environment",
  "gates",
  "checkedAt",
  "freshUntil",
  "freeze",
] as const;
const signedKeys = [...unsignedKeys, "signature"] as const;
const gateKeys = ["contentPublish", "siteDeploy"] as const;

function invalid(code: string): never {
  throw new ContractError(code);
}

function record(
  value: unknown,
  code: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(code);
  }
  return value as Record<string, unknown>;
}

function strict(
  value: Record<string, unknown>,
  allowed: readonly string[],
  code: string,
): void {
  const allowlist = new Set(allowed);
  if (Object.keys(value).some((key) => !allowlist.has(key))) invalid(code);
}

function decision(value: unknown): OperationalGateDecision {
  return value === "allow" || value === "deny"
    ? value
    : invalid("operational_gate_decision_invalid");
}

function unsigned(
  input: unknown,
): UnsignedOperationalGateCompat {
  const value = record(input, "operational_gate_invalid");
  strict(value, unsignedKeys, "operational_gate_unknown_field");
  if (
    typeof value.siteId !== "string" ||
    !/^[a-z][a-z0-9-]{2,63}$/u.test(value.siteId)
  ) {
    invalid("operational_gate_site_invalid");
  }
  const environment =
    value.environment === "staging" ||
    value.environment === "production"
      ? value.environment
      : invalid("operational_gate_environment_invalid");
  const gates = record(
    value.gates,
    "operational_gate_decisions_invalid",
  );
  strict(gates, gateKeys, "operational_gate_decisions_unknown_field");
  if (
    typeof value.checkedAt !== "number" ||
    !Number.isSafeInteger(value.checkedAt) ||
    value.checkedAt < 1 ||
    typeof value.freshUntil !== "number" ||
    !Number.isSafeInteger(value.freshUntil) ||
    value.freshUntil <= value.checkedAt ||
    value.freshUntil > value.checkedAt + 3_600 ||
    typeof value.freeze !== "boolean"
  ) {
    invalid("operational_gate_freshness_invalid");
  }
  return {
    siteId: value.siteId,
    environment,
    gates: {
      contentPublish: decision(gates.contentPublish),
      siteDeploy: decision(gates.siteDeploy),
    },
    checkedAt: value.checkedAt,
    freshUntil: value.freshUntil,
    freeze: value.freeze,
  };
}

function signed(input: unknown): SignedOperationalGateCompat {
  const value = record(input, "operational_gate_invalid");
  strict(value, signedKeys, "operational_gate_unknown_field");
  const unsignedInput: Record<string, unknown> = {};
  for (const key of unsignedKeys) unsignedInput[key] = value[key];
  const parsed = unsigned(unsignedInput);
  if (
    typeof value.signature !== "string" ||
    !/^hmac-sha256:[a-f0-9]{64}$/u.test(value.signature)
  ) {
    invalid("operational_gate_signature_invalid");
  }
  return { ...parsed, signature: value.signature };
}

export function canonicalOperationalGatePayload(
  input: unknown,
): string {
  return stableJson(unsigned(input));
}

export async function signOperationalGateCompat(
  input: unknown,
  secret: string,
): Promise<SignedOperationalGateCompat> {
  const parsed = unsigned(input);
  return {
    ...parsed,
    signature: await signHmacSha256(stableJson(parsed), secret),
  };
}

export async function verifyOperationalGateCompat(
  input: unknown,
  secret: string,
): Promise<boolean> {
  try {
    const parsed = signed(input);
    const { signature, ...payload } = parsed;
    return verifyHmacSha256(
      new TextEncoder().encode(stableJson(payload)),
      signature,
      secret,
    );
  } catch {
    return false;
  }
}
