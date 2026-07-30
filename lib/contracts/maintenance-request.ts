import {
  bearerTokenMatches,
  ContractError,
  signHmacSha256,
  stableJson,
  verifyHmacSha256,
  type Environment,
} from "./ops-signal.ts";
import { sha256Hex } from "../security/safe-output.ts";

export { signHmacSha256, stableJson };

export interface MaintenanceRequest {
  schema: "maintenance-request-v1";
  event: "maintenance.requested";
  requestId: string;
  siteId: string;
  environment: Environment;
  requestedBy: string;
  reasonCode: string;
  requestedAt: number;
  expiresAt: number;
}

export interface UnsignedMaintenanceReceipt {
  schema: "maintenance-request-receipt-v1";
  event: "maintenance.requested.receipt";
  requestId: string;
  status: "accepted";
  recordedAt: number;
}

export interface SignedMaintenanceReceipt
  extends UnsignedMaintenanceReceipt {
  signature: string;
}

export interface MaintenanceRequestCredential {
  credentialId: string;
  siteId: string;
  environment: Environment;
  serviceToken: string;
  signingSecret: string;
  maxAgeSeconds: number;
  maxFutureSkewSeconds: number;
  maxDurationSeconds: number;
}

export interface VerifyMaintenanceRequestInput {
  rawBody: Uint8Array<ArrayBuffer>;
  authorization: string | null | undefined;
  signature: string | null | undefined;
  nowSeconds: number;
  credential: MaintenanceRequestCredential;
}

export interface VerifiedMaintenanceRequest {
  request: MaintenanceRequest;
  requestDigest: string;
  credentialId: string;
  verifiedAtSeconds: number;
}

export interface MaintenanceCredentialPairInput {
  dedicatedServiceToken?: string;
  dedicatedSigningSecret?: string;
  fallbackServiceToken?: string;
  fallbackSigningSecret?: string;
}

export interface MaintenanceCredentialPair {
  serviceToken: string;
  signingSecret: string;
}

const requestKeys = [
  "schema",
  "event",
  "requestId",
  "siteId",
  "environment",
  "requestedBy",
  "reasonCode",
  "requestedAt",
  "expiresAt",
] as const;
const receiptKeys = [
  "schema",
  "event",
  "requestId",
  "status",
  "recordedAt",
] as const;
const signedReceiptKeys = [...receiptKeys, "signature"] as const;
const safeIdentifier = /^[A-Za-z0-9_.:-]{1,128}$/u;
const safeReasonCode = /^[A-Za-z0-9_.:-]{3,128}$/u;

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
  const keys = Object.keys(value);
  const allowlist = new Set(allowed);
  if (
    keys.length !== allowed.length ||
    keys.some((key) => !allowlist.has(key))
  ) {
    invalid(code);
  }
}

function environment(value: unknown): Environment {
  return value === "staging" || value === "production"
    ? value
    : invalid("maintenance_environment_invalid");
}

function timestamp(value: unknown, code: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    invalid(code);
  }
  return value;
}

export function parseMaintenanceRequest(input: unknown): MaintenanceRequest {
  const value = record(input, "maintenance_request_invalid");
  strict(value, requestKeys, "maintenance_request_unknown_field");
  if (
    value.schema !== "maintenance-request-v1" ||
    value.event !== "maintenance.requested"
  ) {
    invalid("maintenance_schema_invalid");
  }
  if (
    typeof value.requestId !== "string" ||
    !safeIdentifier.test(value.requestId)
  ) {
    invalid("maintenance_request_id_invalid");
  }
  if (
    typeof value.siteId !== "string" ||
    !/^[a-z][a-z0-9-]{2,63}$/u.test(value.siteId)
  ) {
    invalid("maintenance_site_id_invalid");
  }
  if (
    typeof value.requestedBy !== "string" ||
    !safeIdentifier.test(value.requestedBy)
  ) {
    invalid("maintenance_requested_by_invalid");
  }
  if (
    typeof value.reasonCode !== "string" ||
    !safeReasonCode.test(value.reasonCode)
  ) {
    invalid("maintenance_reason_code_invalid");
  }
  return {
    schema: "maintenance-request-v1",
    event: "maintenance.requested",
    requestId: value.requestId,
    siteId: value.siteId,
    environment: environment(value.environment),
    requestedBy: value.requestedBy,
    reasonCode: value.reasonCode,
    requestedAt: timestamp(
      value.requestedAt,
      "maintenance_timestamp_invalid",
    ),
    expiresAt: timestamp(value.expiresAt, "maintenance_timestamp_invalid"),
  };
}

function parseUnsignedReceipt(input: unknown): UnsignedMaintenanceReceipt {
  const value = record(input, "maintenance_receipt_invalid");
  strict(value, receiptKeys, "maintenance_receipt_unknown_field");
  if (
    value.schema !== "maintenance-request-receipt-v1" ||
    value.event !== "maintenance.requested.receipt" ||
    value.status !== "accepted" ||
    typeof value.requestId !== "string" ||
    !safeIdentifier.test(value.requestId)
  ) {
    invalid("maintenance_receipt_invalid");
  }
  return {
    schema: "maintenance-request-receipt-v1",
    event: "maintenance.requested.receipt",
    requestId: value.requestId,
    status: "accepted",
    recordedAt: timestamp(
      value.recordedAt,
      "maintenance_receipt_invalid",
    ),
  };
}

export function parseMaintenanceReceipt(
  input: unknown,
): SignedMaintenanceReceipt {
  const value = record(input, "maintenance_receipt_invalid");
  strict(value, signedReceiptKeys, "maintenance_receipt_unknown_field");
  const unsigned: Record<string, unknown> = {};
  for (const key of receiptKeys) unsigned[key] = value[key];
  const parsed = parseUnsignedReceipt(unsigned);
  if (
    typeof value.signature !== "string" ||
    !/^hmac-sha256:[a-f0-9]{64}$/u.test(value.signature)
  ) {
    invalid("maintenance_receipt_signature_invalid");
  }
  return { ...parsed, signature: value.signature };
}

export function canonicalMaintenanceRequest(input: unknown): string {
  return stableJson(parseMaintenanceRequest(input));
}

export function selectMaintenanceCredentialPair(
  input: MaintenanceCredentialPairInput,
): MaintenanceCredentialPair | null {
  const dedicated =
    input.dedicatedServiceToken !== undefined ||
    input.dedicatedSigningSecret !== undefined;
  const serviceToken = dedicated
    ? input.dedicatedServiceToken
    : input.fallbackServiceToken;
  const signingSecret = dedicated
    ? input.dedicatedSigningSecret
    : input.fallbackSigningSecret;
  return serviceToken && signingSecret
    ? { serviceToken, signingSecret }
    : null;
}

function validCredential(
  credential: MaintenanceRequestCredential,
): boolean {
  const secretBytes = new TextEncoder().encode(credential.signingSecret);
  return (
    safeIdentifier.test(credential.credentialId) &&
    /^[a-z][a-z0-9-]{2,63}$/u.test(credential.siteId) &&
    (credential.environment === "staging" ||
      credential.environment === "production") &&
    credential.serviceToken.length >= 16 &&
    credential.serviceToken.length <= 4_096 &&
    !/[\r\n]/u.test(credential.serviceToken) &&
    secretBytes.byteLength >= 32 &&
    secretBytes.byteLength <= 4_096 &&
    Number.isInteger(credential.maxAgeSeconds) &&
    credential.maxAgeSeconds >= 1 &&
    credential.maxAgeSeconds <= 900 &&
    Number.isInteger(credential.maxFutureSkewSeconds) &&
    credential.maxFutureSkewSeconds >= 0 &&
    credential.maxFutureSkewSeconds <= 300 &&
    Number.isInteger(credential.maxDurationSeconds) &&
    credential.maxDurationSeconds >= 1 &&
    credential.maxDurationSeconds <= 900
  );
}

export async function verifyMaintenanceRequest(
  input: VerifyMaintenanceRequestInput,
): Promise<VerifiedMaintenanceRequest> {
  if (
    !(input.rawBody instanceof Uint8Array) ||
    input.rawBody.byteLength < 2 ||
    input.rawBody.byteLength > 64 * 1_024
  ) {
    invalid("maintenance_request_invalid");
  }
  if (!Number.isSafeInteger(input.nowSeconds)) {
    invalid("maintenance_clock_invalid");
  }
  if (!validCredential(input.credential)) {
    invalid("maintenance_credential_invalid");
  }
  const authorization = input.authorization;
  if (
    typeof authorization !== "string" ||
    !authorization.startsWith("Bearer ") ||
    /[\r\n,]/u.test(authorization)
  ) {
    invalid("maintenance_auth_invalid");
  }
  const candidate = authorization.slice("Bearer ".length);
  if (
    candidate.length < 16 ||
    candidate.length > 4_096 ||
    !(await bearerTokenMatches(
      candidate,
      input.credential.serviceToken,
    ))
  ) {
    invalid("maintenance_auth_invalid");
  }
  let validSignature = false;
  try {
    validSignature = await verifyHmacSha256(
      input.rawBody,
      input.signature,
      input.credential.signingSecret,
    );
  } catch {
    validSignature = false;
  }
  if (!validSignature) invalid("maintenance_signature_invalid");

  let rawText: string;
  try {
    rawText = new TextDecoder("utf-8", { fatal: true }).decode(input.rawBody);
  } catch {
    return invalid("maintenance_body_invalid");
  }
  let parsedInput: unknown;
  try {
    parsedInput = JSON.parse(rawText);
  } catch {
    return invalid("maintenance_body_invalid");
  }
  const request = parseMaintenanceRequest(parsedInput);
  if (stableJson(request) !== rawText) {
    invalid("maintenance_body_noncanonical");
  }
  if (
    request.siteId !== input.credential.siteId ||
    request.environment !== input.credential.environment
  ) {
    invalid("maintenance_scope_invalid");
  }
  const age = input.nowSeconds - request.requestedAt;
  if (age > input.credential.maxAgeSeconds) {
    invalid("maintenance_request_stale");
  }
  if (age < -input.credential.maxFutureSkewSeconds) {
    invalid("maintenance_request_from_future");
  }
  const duration = request.expiresAt - request.requestedAt;
  if (
    duration < 1 ||
    duration > input.credential.maxDurationSeconds ||
    request.expiresAt <= input.nowSeconds
  ) {
    invalid("maintenance_expiry_invalid");
  }
  return {
    request,
    requestDigest: await sha256Hex(input.rawBody),
    credentialId: input.credential.credentialId,
    verifiedAtSeconds: input.nowSeconds,
  };
}

export async function buildSignedMaintenanceReceipt(
  input: {
    requestId: string;
    recordedAt: number;
  },
  secret: string,
): Promise<SignedMaintenanceReceipt> {
  const unsigned = parseUnsignedReceipt({
    schema: "maintenance-request-receipt-v1",
    event: "maintenance.requested.receipt",
    requestId: input.requestId,
    status: "accepted",
    recordedAt: input.recordedAt,
  });
  return {
    ...unsigned,
    signature: await signHmacSha256(stableJson(unsigned), secret),
  };
}

export async function verifyMaintenanceReceipt(
  input: unknown,
  secret: string,
): Promise<boolean> {
  try {
    const receipt = parseMaintenanceReceipt(input);
    const { signature, ...unsigned } = receipt;
    return await verifyHmacSha256(
      new TextEncoder().encode(stableJson(unsigned)),
      signature,
      secret,
    );
  } catch {
    return false;
  }
}
