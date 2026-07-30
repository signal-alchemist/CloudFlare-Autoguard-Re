import {
  ContractError,
  type Component,
  type Environment,
} from "../contracts/ops-signal.ts";
import type {
  IncidentSeverity,
  IncidentState,
} from "../domain/incidents.ts";

export interface AdapterEvidenceContext {
  siteId: string;
  environment: Environment;
  component: Component;
  checkId: string;
  evidenceId: string;
  observedAt: string;
  adapterVersion: string;
  reviewedOrigin: string;
}

export interface SafeAdapterEvidence {
  schema: "safe-adapter-evidence-v1";
  siteId: string;
  environment: Environment;
  component: Component;
  checkId: string;
  evidenceId: string;
  observedAt: string;
  adapterVersion: string;
  statusCode: number;
  contentType: string;
  bodySha256: string;
  latencyMs: number;
  redirectPath: string;
  tlsProtocol: "TLSv1.2" | "TLSv1.3";
  tlsDaysRemaining: number;
  providerCode: string;
  resourceVersion: string;
}

export type SanitizeAdapterEvidenceResult =
  | {
      ok: true;
      evidence: SafeAdapterEvidence;
    }
  | {
      ok: false;
      observationStatus: "unknown";
      reasonCode: "evidence_sanitization_failed";
      evidence: null;
    };

export interface SafeIncidentProjection {
  incidentId: string;
  siteId: string;
  environment: Environment;
  component: Component;
  severity: IncidentSeverity;
  state: IncidentState;
  reasonCode: string;
  scope: string;
  evidenceId: string;
  observedAt: string;
  correlationId: string;
}

export interface SafeNotificationEnvelope
  extends SafeIncidentProjection {
  schema: "safe-notification-envelope-v1";
  deliveryKey: string;
}

export interface SafeLogFields {
  incidentId: string;
  siteId: string;
  environment: Environment;
  component: Component;
  severity: IncidentSeverity;
  state: IncidentState;
  reasonCode: string;
  evidenceId: string;
  correlationId: string;
}

export interface SafeIncidentApi {
  incidentId: string;
  siteId: string;
  environment: Environment;
  component: Component;
  severity: IncidentSeverity;
  state: IncidentState;
  reasonCode: string;
  scope: string;
  evidenceId: string;
  observedAt: string;
}

const contextKeys = [
  "siteId",
  "environment",
  "component",
  "checkId",
  "evidenceId",
  "observedAt",
  "adapterVersion",
  "reviewedOrigin",
] as const;
const incidentKeys = [
  "incidentId",
  "siteId",
  "environment",
  "component",
  "severity",
  "state",
  "reasonCode",
  "scope",
  "evidenceId",
  "observedAt",
  "correlationId",
] as const;
const notificationKeys = [
  "schema",
  "deliveryKey",
  ...incidentKeys,
] as const;
const components = new Set<Component>([
  "public_delivery",
  "editorial",
  "contact_intake",
  "media_delivery",
  "notification_delivery",
  "deployment_integrity",
  "recovery_readiness",
  "autoguard_control_plane",
]);
const severities = new Set<IncidentSeverity>([
  "sev1",
  "sev2",
  "sev3",
  "sev4",
]);
const states = new Set<IncidentState>([
  "open",
  "acknowledged",
  "mitigating",
  "monitoring",
  "resolved",
  "manual_required",
]);

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

function identifier(
  value: unknown,
  code: string,
  maximum = 128,
): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    !/^[A-Za-z0-9_.:-]+$/u.test(value)
  ) {
    invalid(code);
  }
  return value;
}

function environment(value: unknown, code: string): Environment {
  if (value !== "staging" && value !== "production") invalid(code);
  return value;
}

function component(value: unknown, code: string): Component {
  if (typeof value !== "string" || !components.has(value as Component)) {
    invalid(code);
  }
  return value as Component;
}

function canonicalIso(value: unknown, code: string): string {
  if (typeof value !== "string") invalid(code);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) invalid(code);
  const canonical = new Date(milliseconds).toISOString();
  if (canonical !== value) invalid(code);
  return canonical;
}

function safeScope(value: unknown, code: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 512 ||
    /[\u0000-\u001f\u007f?#@]/u.test(value)
  ) {
    invalid(code);
  }
  if (value.startsWith("http")) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return invalid(code);
    }
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      invalid(code);
    }
  }
  return value;
}

function compileOrigin(value: unknown, code: string): string {
  if (typeof value !== "string") invalid(code);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid(code);
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    invalid(code);
  }
  return url.origin;
}

function parseContext(input: unknown): AdapterEvidenceContext {
  const value = record(input, "evidence_context_invalid");
  strict(value, contextKeys, "evidence_context_unknown_field");
  const evidenceId =
    typeof value.evidenceId === "string" &&
    /^ev_[a-f0-9]{32}$/u.test(value.evidenceId)
      ? value.evidenceId
      : invalid("evidence_id_invalid");
  return {
    siteId:
      typeof value.siteId === "string" &&
      /^[a-z][a-z0-9-]{2,63}$/u.test(value.siteId)
        ? value.siteId
        : invalid("evidence_site_invalid"),
    environment: environment(
      value.environment,
      "evidence_environment_invalid",
    ),
    component: component(value.component, "evidence_component_invalid"),
    checkId: identifier(value.checkId, "evidence_check_id_invalid"),
    evidenceId,
    observedAt: canonicalIso(
      value.observedAt,
      "evidence_observed_at_invalid",
    ),
    adapterVersion: identifier(
      value.adapterVersion,
      "evidence_adapter_version_invalid",
    ),
    reviewedOrigin: compileOrigin(
      value.reviewedOrigin,
      "evidence_reviewed_origin_invalid",
    ),
  };
}

function integer(
  value: unknown,
  minimum: number,
  maximum: number,
  code: string,
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    invalid(code);
  }
  return value;
}

export async function sha256Hex(
  value: Uint8Array,
): Promise<string> {
  const bytes = Uint8Array.from(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function sanitizationFailure(): SanitizeAdapterEvidenceResult {
  return {
    ok: false,
    observationStatus: "unknown",
    reasonCode: "evidence_sanitization_failed",
    evidence: null,
  };
}

export async function sanitizeAdapterEvidence(
  trustedContext: unknown,
  untrustedResult: unknown,
): Promise<SanitizeAdapterEvidenceResult> {
  try {
    const context = parseContext(trustedContext);
    const raw = record(untrustedResult, "adapter_evidence_invalid");
    const statusCode = integer(
      raw.statusCode,
      100,
      599,
      "adapter_status_invalid",
    );
    const headers = record(raw.headers, "adapter_headers_invalid");
    const rawContentType = headers["content-type"];
    if (typeof rawContentType !== "string") {
      invalid("adapter_content_type_invalid");
    }
    const contentType = rawContentType
      .split(";", 1)[0]!
      .trim()
      .toLowerCase();
    if (!/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/u.test(contentType)) {
      invalid("adapter_content_type_invalid");
    }
    if (!(raw.body instanceof Uint8Array)) {
      invalid("adapter_body_invalid");
    }
    if (raw.body.byteLength > 1_048_576) {
      invalid("adapter_body_too_large");
    }
    const latencyMs = integer(
      raw.elapsedMs,
      0,
      30_000,
      "adapter_latency_invalid",
    );
    if (typeof raw.redirectUrl !== "string") {
      invalid("adapter_redirect_invalid");
    }
    let redirect: URL;
    try {
      redirect = new URL(raw.redirectUrl);
    } catch {
      return sanitizationFailure();
    }
    if (
      redirect.origin !== context.reviewedOrigin ||
      redirect.username !== "" ||
      redirect.password !== "" ||
      redirect.search !== "" ||
      redirect.hash !== ""
    ) {
      invalid("adapter_redirect_invalid");
    }
    const tls = record(raw.tls, "adapter_tls_invalid");
    const tlsProtocol =
      tls.protocol === "TLSv1.2" || tls.protocol === "TLSv1.3"
        ? tls.protocol
        : invalid("adapter_tls_protocol_invalid");
    const tlsDaysRemaining = integer(
      tls.daysRemaining,
      0,
      825,
      "adapter_tls_days_invalid",
    );
    const providerCode = identifier(
      raw.providerCode,
      "adapter_provider_code_invalid",
      32,
    );
    const resourceVersion = identifier(
      raw.resourceVersion,
      "adapter_resource_version_invalid",
    );
    return {
      ok: true,
      evidence: {
        schema: "safe-adapter-evidence-v1",
        siteId: context.siteId,
        environment: context.environment,
        component: context.component,
        checkId: context.checkId,
        evidenceId: context.evidenceId,
        observedAt: context.observedAt,
        adapterVersion: context.adapterVersion,
        statusCode,
        contentType,
        bodySha256: await sha256Hex(raw.body),
        latencyMs,
        redirectPath: redirect.pathname,
        tlsProtocol,
        tlsDaysRemaining,
        providerCode,
        resourceVersion,
      },
    };
  } catch {
    return sanitizationFailure();
  }
}

function parseIncidentProjection(input: unknown): SafeIncidentProjection {
  const value = record(input, "safe_incident_invalid");
  strict(value, incidentKeys, "safe_incident_unknown_field");
  const severity =
    typeof value.severity === "string" &&
    severities.has(value.severity as IncidentSeverity)
      ? (value.severity as IncidentSeverity)
      : invalid("safe_incident_severity_invalid");
  const state =
    typeof value.state === "string" &&
    states.has(value.state as IncidentState)
      ? (value.state as IncidentState)
      : invalid("safe_incident_state_invalid");
  const incidentId =
    typeof value.incidentId === "string" &&
    /^inc_[a-f0-9]{32}$/u.test(value.incidentId)
      ? value.incidentId
      : invalid("safe_incident_id_invalid");
  const evidenceId =
    typeof value.evidenceId === "string" &&
    /^ev_[a-f0-9]{32}$/u.test(value.evidenceId)
      ? value.evidenceId
      : invalid("safe_incident_evidence_id_invalid");
  return {
    incidentId,
    siteId:
      typeof value.siteId === "string" &&
      /^[a-z][a-z0-9-]{2,63}$/u.test(value.siteId)
        ? value.siteId
        : invalid("safe_incident_site_invalid"),
    environment: environment(
      value.environment,
      "safe_incident_environment_invalid",
    ),
    component: component(
      value.component,
      "safe_incident_component_invalid",
    ),
    severity,
    state,
    reasonCode: identifier(
      value.reasonCode,
      "safe_incident_reason_invalid",
    ),
    scope: safeScope(value.scope, "safe_incident_scope_invalid"),
    evidenceId,
    observedAt: canonicalIso(
      value.observedAt,
      "safe_incident_observed_at_invalid",
    ),
    correlationId: identifier(
      value.correlationId,
      "safe_incident_correlation_id_invalid",
    ),
  };
}

export function toSafeNotification(
  input: unknown,
): SafeNotificationEnvelope {
  const incident = parseIncidentProjection(input);
  return {
    schema: "safe-notification-envelope-v1",
    deliveryKey: `notify:${incident.incidentId}:${incident.evidenceId}`,
    ...incident,
  };
}

export function parseSafeNotificationEnvelope(
  input: unknown,
): SafeNotificationEnvelope {
  const value = record(input, "safe_notification_invalid");
  strict(value, notificationKeys, "safe_notification_unknown_field");
  if (value.schema !== "safe-notification-envelope-v1") {
    invalid("safe_notification_schema_invalid");
  }
  const deliveryKey = identifier(
    value.deliveryKey,
    "safe_notification_delivery_key_invalid",
    180,
  );
  const incidentInput: Record<string, unknown> = {};
  for (const key of incidentKeys) incidentInput[key] = value[key];
  const incident = parseIncidentProjection(incidentInput);
  const expected = `notify:${incident.incidentId}:${incident.evidenceId}`;
  if (deliveryKey !== expected) {
    invalid("safe_notification_delivery_key_mismatch");
  }
  return {
    schema: "safe-notification-envelope-v1",
    deliveryKey,
    ...incident,
  };
}

export function toSafeLogFields(input: unknown): SafeLogFields {
  const incident = parseIncidentProjection(input);
  return {
    incidentId: incident.incidentId,
    siteId: incident.siteId,
    environment: incident.environment,
    component: incident.component,
    severity: incident.severity,
    state: incident.state,
    reasonCode: incident.reasonCode,
    evidenceId: incident.evidenceId,
    correlationId: incident.correlationId,
  };
}

export function toSafeIncidentApi(input: unknown): SafeIncidentApi {
  const incident = parseIncidentProjection(input);
  return {
    incidentId: incident.incidentId,
    siteId: incident.siteId,
    environment: incident.environment,
    component: incident.component,
    severity: incident.severity,
    state: incident.state,
    reasonCode: incident.reasonCode,
    scope: incident.scope,
    evidenceId: incident.evidenceId,
    observedAt: incident.observedAt,
  };
}
