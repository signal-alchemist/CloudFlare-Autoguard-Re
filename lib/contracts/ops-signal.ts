import { classifyCmsSignal } from "../domain/cms-component.ts";

export type Environment = "staging" | "production";

export type Component =
  | "public_delivery"
  | "editorial"
  | "contact_intake"
  | "media_delivery"
  | "notification_delivery"
  | "deployment_integrity"
  | "recovery_readiness"
  | "autoguard_control_plane";

export type ObservationStatus =
  | "pass"
  | "fail"
  | "degraded"
  | "unknown"
  | "unsupported";

export type ObservationSource =
  | "cms_ops_signal"
  | "public_probe"
  | "external_probe"
  | "provider_api"
  | "autoguard_self"
  | "post_deploy";

interface RuntimeFailureSignal {
  schema: "ops-signal-v1";
  event: "worker.runtime_failure";
  fingerprint: string;
  environment: Environment;
  service: string;
  occurredAt: string;
  status: number;
  method: string;
  route: "/api/contact" | "/healthz" | "/img/:width/:object-key" | "/other";
  exceptionName: string;
  correlationId: string;
}

interface ContactDeliveryFailureSignal {
  schema: "ops-signal-v1";
  event: "contact.delivery_failure";
  signalId: string;
  environment: Environment;
  service: string;
  occurredAt: string;
  code: "CONTACT_DELIVERY_FAILED";
  correlationId: string;
}

export type CmsOpsSignal =
  | RuntimeFailureSignal
  | ContactDeliveryFailureSignal;

export interface CmsOpsSignalEnvelope {
  schema: "autoguard-ops-signal-envelope-v1";
  environment: Environment;
  signal: CmsOpsSignal;
  sentAt: string;
}

export interface Observation {
  schemaVersion: 1;
  observationId: string;
  siteId: string;
  environment: Environment;
  component: Component;
  checkId: string;
  status: ObservationStatus;
  reasonCode: string;
  observedAt: string;
  validUntil: string;
  source: ObservationSource;
  scope: string;
  evidenceId: string;
  correlationId: string;
  idempotencyKey: string;
}

export interface ObservationPolicy {
  siteId: string;
  environment: Environment;
  validForSeconds: number;
}

export interface CmsSignalCredential extends ObservationPolicy {
  credentialId: string;
  token: string;
  signingSecret: string;
  maxAgeSeconds: number;
  maxFutureSkewSeconds: number;
}

export interface ReplayStore {
  claim(key: string, expiresAt: number): Promise<boolean>;
}

export interface VerifiedCmsOpsSignal {
  credentialId: string;
  observation: Observation;
}

export interface VerifyCmsOpsSignalRequest {
  rawBody: Uint8Array<ArrayBuffer>;
  authorization: string | null | undefined;
  signature: string | null | undefined;
  now: number;
  credentials: readonly CmsSignalCredential[];
  replayStore: ReplayStore;
}

export class ContractError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "ContractError";
    this.code = code;
  }
}

function invalid(code: string): never {
  throw new ContractError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(
  value: unknown,
  code: string,
): Record<string, unknown> {
  return isRecord(value) ? value : invalid(code);
}

function requireStrictKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  code: string,
): void {
  const allowlist = new Set(allowed);
  if (Object.keys(value).some((key) => !allowlist.has(key))) invalid(code);
}

function requireEnvironment(
  value: unknown,
  code: string,
): Environment {
  return value === "staging" || value === "production"
    ? value
    : invalid(code);
}

function requireIdentifier(
  value: unknown,
  maximum: number,
  code: string,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    !/^[A-Za-z0-9_.:-]+$/u.test(value)
  ) {
    invalid(code);
  }
  return value;
}

function requireIsoDate(value: unknown, code: string): string {
  if (typeof value !== "string") invalid(code);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) invalid(code);
  return new Date(milliseconds).toISOString();
}

function requireString(
  value: unknown,
  minimum: number,
  maximum: number,
  code: string,
): string {
  if (
    typeof value !== "string" ||
    value.length < minimum ||
    value.length > maximum
  ) {
    invalid(code);
  }
  return value;
}

function parseRuntimeFailure(
  input: Record<string, unknown>,
): RuntimeFailureSignal {
  requireStrictKeys(
    input,
    [
      "schema",
      "event",
      "schemaVersion",
      "fingerprint",
      "severity",
      "environment",
      "service",
      "occurredAt",
      "status",
      "method",
      "route",
      "exceptionName",
      "message",
      "cfRay",
      "requestId",
      "commit",
    ],
    "ops_signal_unknown_field",
  );
  if (
    input.schema !== "ops-signal-v1" ||
    input.event !== "worker.runtime_failure" ||
    input.schemaVersion !== 1 ||
    input.severity !== "error"
  ) {
    invalid("ops_signal_schema_invalid");
  }
  if (
    typeof input.fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/u.test(input.fingerprint)
  ) {
    invalid("ops_signal_fingerprint_invalid");
  }
  if (
    typeof input.status !== "number" ||
    !Number.isInteger(input.status) ||
    input.status < 100 ||
    input.status > 599
  ) {
    invalid("ops_signal_status_invalid");
  }
  const route = input.route;
  if (
    route !== "/api/contact" &&
    route !== "/healthz" &&
    route !== "/img/:width/:object-key" &&
    route !== "/other"
  ) {
    invalid("ops_signal_route_invalid");
  }

  requireString(input.message, 1, 160, "ops_signal_message_invalid");
  requireIdentifier(
    input.exceptionName,
    64,
    "ops_signal_exception_invalid",
  );
  requireIdentifier(input.method, 16, "ops_signal_method_invalid");
  if (input.cfRay !== undefined) {
    requireIdentifier(input.cfRay, 64, "ops_signal_cf_ray_invalid");
  }
  if (input.commit !== undefined) {
    requireIdentifier(input.commit, 64, "ops_signal_commit_invalid");
  }

  const fingerprint = input.fingerprint;
  const requestId =
    input.requestId === undefined
      ? fingerprint
      : requireIdentifier(input.requestId, 128, "ops_signal_request_id_invalid");

  return {
    schema: "ops-signal-v1",
    event: "worker.runtime_failure",
    fingerprint,
    environment: requireEnvironment(
      input.environment,
      "ops_signal_environment_invalid",
    ),
    service: requireIdentifier(
      input.service,
      128,
      "ops_signal_service_invalid",
    ),
    occurredAt: requireIsoDate(
      input.occurredAt,
      "ops_signal_occurred_at_invalid",
    ),
    status: input.status,
    method: requireIdentifier(
      input.method,
      16,
      "ops_signal_method_invalid",
    ),
    route,
    exceptionName: requireIdentifier(
      input.exceptionName,
      64,
      "ops_signal_exception_invalid",
    ),
    correlationId: requestId,
  };
}

function parseContactDeliveryFailure(
  input: Record<string, unknown>,
): ContactDeliveryFailureSignal {
  requireStrictKeys(
    input,
    [
      "schema",
      "event",
      "signalId",
      "environment",
      "service",
      "occurredAt",
      "code",
      "correlationId",
    ],
    "ops_signal_unknown_field",
  );
  if (
    input.schema !== "ops-signal-v1" ||
    input.event !== "contact.delivery_failure" ||
    input.code !== "CONTACT_DELIVERY_FAILED"
  ) {
    invalid("ops_signal_schema_invalid");
  }
  return {
    schema: "ops-signal-v1",
    event: "contact.delivery_failure",
    signalId: requireIdentifier(
      input.signalId,
      128,
      "ops_signal_signal_id_invalid",
    ),
    environment: requireEnvironment(
      input.environment,
      "ops_signal_environment_invalid",
    ),
    service: requireIdentifier(
      input.service,
      128,
      "ops_signal_service_invalid",
    ),
    occurredAt: requireIsoDate(
      input.occurredAt,
      "ops_signal_occurred_at_invalid",
    ),
    code: "CONTACT_DELIVERY_FAILED",
    correlationId: requireIdentifier(
      input.correlationId,
      128,
      "ops_signal_correlation_id_invalid",
    ),
  };
}

export function parseCmsOpsSignalEnvelope(
  input: unknown,
): CmsOpsSignalEnvelope {
  const envelope = requireRecord(input, "ops_envelope_invalid");
  requireStrictKeys(
    envelope,
    ["schema", "environment", "signal", "sentAt"],
    "ops_envelope_unknown_field",
  );
  if (envelope.schema !== "autoguard-ops-signal-envelope-v1") {
    invalid("ops_envelope_schema_invalid");
  }
  const environment = requireEnvironment(
    envelope.environment,
    "ops_envelope_environment_invalid",
  );
  const signalInput = requireRecord(
    envelope.signal,
    "ops_signal_invalid",
  );
  const signal =
    signalInput.event === "worker.runtime_failure"
      ? parseRuntimeFailure(signalInput)
      : signalInput.event === "contact.delivery_failure"
        ? parseContactDeliveryFailure(signalInput)
        : invalid("ops_signal_event_invalid");
  if (signal.environment !== environment) {
    invalid("ops_signal_environment_mismatch");
  }
  return {
    schema: "autoguard-ops-signal-envelope-v1",
    environment,
    signal,
    sentAt: requireIsoDate(envelope.sentAt, "ops_envelope_sent_at_invalid"),
  };
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stable(item)]),
    );
  }
  return value;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(stable(value));
}

async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stableJson(value));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function secretBytes(
  value: string,
  code: string,
): Uint8Array<ArrayBuffer> {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength < 32 || bytes.byteLength > 4_096) invalid(code);
  return bytes;
}

function signatureBytes(value: unknown): Uint8Array<ArrayBuffer> {
  if (
    typeof value !== "string" ||
    !/^hmac-sha256:[a-f0-9]{64}$/u.test(value)
  ) {
    invalid("ops_signature_invalid");
  }
  const hex = value.slice("hmac-sha256:".length);
  return Uint8Array.from(
    { length: 32 },
    (_, index) => Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16),
  );
}

export async function signHmacSha256(
  value: string | Uint8Array<ArrayBuffer>,
  secret: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes(secret, "ops_signing_secret_invalid"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      typeof value === "string" ? new TextEncoder().encode(value) : value,
    ),
  );
  return `hmac-sha256:${Array.from(digest, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

async function verifyHmacSha256(
  value: Uint8Array<ArrayBuffer>,
  signature: unknown,
  secret: string,
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes(secret, "ops_signing_secret_invalid"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    "HMAC",
    key,
    signatureBytes(signature),
    value,
  );
}

async function bearerTokenMatches(
  candidate: string,
  configured: string,
): Promise<boolean> {
  const challenge = new TextEncoder().encode(
    "cloudflare-guard-bearer-check-v1",
  );
  const configuredKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(configured),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = await crypto.subtle.sign(
    "HMAC",
    configuredKey,
    challenge,
  );
  const candidateKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(candidate),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("HMAC", candidateKey, expected, challenge);
}

async function credentialFor(
  authorization: string | null | undefined,
  credentials: readonly CmsSignalCredential[],
): Promise<CmsSignalCredential> {
  if (
    typeof authorization !== "string" ||
    authorization.length > 4_103 ||
    !authorization.startsWith("Bearer ") ||
    /[\r\n]/u.test(authorization)
  ) {
    invalid("ops_auth_invalid");
  }
  const token = authorization.slice("Bearer ".length);
  if (token.length < 16 || token.length > 4_096) invalid("ops_auth_invalid");
  const matches: CmsSignalCredential[] = [];
  for (const credential of credentials) {
    validateCredential(credential);
    if (await bearerTokenMatches(token, credential.token)) {
      matches.push(credential);
    }
  }
  if (matches.length > 1) invalid("ops_credential_duplicate");
  return matches[0] ?? invalid("ops_auth_invalid");
}

function validateCredential(credential: CmsSignalCredential): void {
  requireIdentifier(
    credential.credentialId,
    128,
    "ops_credential_invalid",
  );
  if (
    credential.token.length < 16 ||
    credential.token.length > 4_096 ||
    /[\r\n]/u.test(credential.token) ||
    !/^[a-z][a-z0-9-]{2,63}$/u.test(credential.siteId) ||
    (credential.environment !== "staging" &&
      credential.environment !== "production") ||
    !Number.isInteger(credential.maxAgeSeconds) ||
    credential.maxAgeSeconds < 1 ||
    credential.maxAgeSeconds > 900 ||
    !Number.isInteger(credential.maxFutureSkewSeconds) ||
    credential.maxFutureSkewSeconds < 0 ||
    credential.maxFutureSkewSeconds > 300 ||
    !Number.isInteger(credential.validForSeconds) ||
    credential.validForSeconds < 1 ||
    credential.validForSeconds > 86_400
  ) {
    invalid("ops_credential_invalid");
  }
  secretBytes(credential.signingSecret, "ops_credential_invalid");
}

export async function verifyCmsOpsSignalRequest(
  request: VerifyCmsOpsSignalRequest,
): Promise<VerifiedCmsOpsSignal> {
  if (
    !(request.rawBody instanceof Uint8Array) ||
    request.rawBody.byteLength > 64 * 1_024 ||
    !Number.isFinite(request.now)
  ) {
    invalid("ops_request_invalid");
  }
  const credential = await credentialFor(
    request.authorization,
    request.credentials,
  );
  validateCredential(credential);
  if (
    !(await verifyHmacSha256(
      request.rawBody,
      request.signature,
      credential.signingSecret,
    ))
  ) {
    invalid("ops_signature_invalid");
  }

  let rawText: string;
  try {
    rawText = new TextDecoder("utf-8", { fatal: true }).decode(
      request.rawBody,
    );
  } catch {
    invalid("ops_body_invalid_utf8");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    invalid("ops_body_invalid");
  }
  if (stableJson(parsed) !== rawText) {
    invalid("ops_body_noncanonical");
  }
  const envelope = parseCmsOpsSignalEnvelope(parsed);
  if (envelope.environment !== credential.environment) {
    invalid("ops_scope_invalid");
  }
  const ageMilliseconds = request.now - Date.parse(envelope.sentAt);
  if (ageMilliseconds > credential.maxAgeSeconds * 1_000) {
    invalid("ops_envelope_stale");
  }
  if (ageMilliseconds < -credential.maxFutureSkewSeconds * 1_000) {
    invalid("ops_envelope_from_future");
  }

  const observation = await toObservation(envelope, credential);
  const requestDigest = Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", request.rawBody),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  const replayKey = `request:${credential.credentialId}:${requestDigest}`;
  const expiresAt = Math.ceil(
    (request.now +
      Math.max(credential.maxAgeSeconds, credential.maxFutureSkewSeconds) *
        1_000) /
      1_000,
  );
  if (
    !(await request.replayStore.claim(
      replayKey,
      expiresAt,
    ))
  ) {
    invalid("ops_replay_detected");
  }

  return {
    credentialId: credential.credentialId,
    observation,
  };
}

export async function toObservation(
  envelope: CmsOpsSignalEnvelope,
  policy: ObservationPolicy,
): Promise<Observation> {
  if (
    !/^[a-z][a-z0-9-]{2,63}$/u.test(policy.siteId) ||
    policy.environment !== envelope.environment ||
    !Number.isInteger(policy.validForSeconds) ||
    policy.validForSeconds < 1 ||
    policy.validForSeconds > 86_400
  ) {
    invalid("observation_policy_invalid");
  }

  const signal = envelope.signal;
  const identity =
    signal.event === "worker.runtime_failure"
      ? signal.fingerprint
      : signal.signalId;
  const classification = classifyCmsSignal(signal);
  const observedAt = signal.occurredAt;
  const validUntil = new Date(
    Date.parse(observedAt) + policy.validForSeconds * 1_000,
  ).toISOString();
  const idempotencyKey = [
    "cms",
    policy.siteId,
    envelope.environment,
    signal.event,
    identity,
  ].join(":");
  const material = {
    schemaVersion: 1,
    siteId: policy.siteId,
    environment: envelope.environment,
    component: classification.component,
    checkId: classification.checkId,
    status: classification.status,
    reasonCode: classification.reasonCode,
    observedAt,
    validUntil,
    source: "cms_ops_signal",
    scope: classification.scope,
    correlationId: signal.correlationId,
    idempotencyKey,
  } as const;
  const digest = await sha256(material);

  return {
    ...material,
    observationId: `obs_${digest.slice(0, 32)}`,
    evidenceId: `ev_${digest.slice(32, 64)}`,
  };
}
