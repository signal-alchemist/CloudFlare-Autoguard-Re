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
  source: "cms_ops_signal";
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

async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(stable(value)));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function componentFor(signal: CmsOpsSignal): Component {
  if (signal.event === "contact.delivery_failure") {
    return "notification_delivery";
  }
  if (signal.route === "/api/contact") return "contact_intake";
  if (signal.route === "/img/:width/:object-key") return "media_delivery";
  if (signal.route === "/healthz") return "deployment_integrity";
  return "public_delivery";
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
  const component = componentFor(signal);
  const scope =
    signal.event === "worker.runtime_failure" ? signal.route : signal.service;
  const reasonCode =
    signal.event === "worker.runtime_failure"
      ? "worker_runtime_failure"
      : "contact_delivery_failed";
  const checkId =
    signal.event === "worker.runtime_failure"
      ? "cms_ops.worker_runtime"
      : "cms_ops.contact_delivery";
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
    component,
    checkId,
    status: "fail",
    reasonCode,
    observedAt,
    validUntil,
    source: "cms_ops_signal",
    scope,
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

