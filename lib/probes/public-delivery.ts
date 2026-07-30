import {
  ContractError,
  stableJson,
  type Environment,
  type Observation,
  type ObservationStatus,
} from "../contracts/ops-signal.ts";

export type PublicDeliveryCheckKind = "dns" | "tls" | "http";
export type PublicDeliveryMethod = "GET" | "HEAD";

export interface PublicDeliveryExpect {
  status?: number;
  contentTypePrefix?: string;
  bodyMarker?: string;
  canonical?: string;
  requiredHeaders: readonly string[];
}

export interface PublicDeliveryCheck {
  checkId: string;
  kind: PublicDeliveryCheckKind;
  url: string;
  method: PublicDeliveryMethod;
  validForSeconds: number;
  maxRedirects: number;
  maxResponseBytes: number;
  maxElapsedMs: number;
  tlsMinDaysRemaining: number;
  expect: PublicDeliveryExpect;
}

export interface PublicDeliveryManifest {
  schema: "public-delivery-manifest-v1";
  siteId: string;
  environment: Environment;
  allowedOrigins: readonly string[];
  checks: readonly PublicDeliveryCheck[];
}

export interface PublicDeliveryDnsResult {
  addresses: readonly string[];
  ttlSeconds: number;
}

export interface PublicDeliveryTlsEvidence {
  authorized: boolean;
  protocol: string;
  daysRemaining: number;
  sniHostname: string;
}

export interface PublicDeliveryExchangeRequest {
  url: string;
  method: PublicDeliveryMethod;
  allowedAddresses: readonly string[];
  maxResponseBytes: number;
}

export interface PublicDeliveryExchange {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
  connectedAddress: string;
  elapsedMs: number;
  tls: PublicDeliveryTlsEvidence;
}

export interface PublicDeliveryProbePorts {
  resolve(hostname: string): Promise<PublicDeliveryDnsResult>;
  exchange(
    request: PublicDeliveryExchangeRequest,
  ): Promise<PublicDeliveryExchange>;
}

export interface PublicDeliverySelection {
  siteId: string;
  environment: Environment;
  checkId: string;
}

export interface PublicDeliveryEvidence {
  schema: "public-delivery-evidence-v1";
  evidenceId: string;
  siteId: string;
  environment: Environment;
  checkId: string;
  observedAt: string;
  target: {
    origin: string;
    path: string;
  };
  dns: {
    answerCount: number;
    minimumTtlSeconds: number | null;
    allGlobal: boolean;
    connectionAttested: boolean;
  };
  tls: {
    authorized: boolean;
    protocol: string | null;
    daysRemaining: number | null;
    sniMatched: boolean;
  };
  http: {
    status: number | null;
    redirectCount: number;
    elapsedMs: number | null;
  };
  assertions: {
    status: boolean | null;
    contentType: boolean | null;
    bodyMarker: boolean | null;
    canonical: boolean | null;
    requiredHeaders: boolean | null;
  };
  bodySha256: string | null;
  result: ObservationStatus;
  reasonCode: string;
}

export interface RunPublicDeliveryCheckInput {
  manifest: PublicDeliveryManifest;
  selection: PublicDeliverySelection;
  ports: PublicDeliveryProbePorts;
  now: number;
  correlationId: string;
}

export interface PublicDeliveryProbeResult {
  observation: Observation;
  evidence: PublicDeliveryEvidence;
}

interface EvidenceState {
  answerCount: number;
  minimumTtlSeconds: number | null;
  allGlobal: boolean;
  connectionAttested: boolean;
  tlsAuthorized: boolean;
  tlsProtocol: string | null;
  tlsDaysRemaining: number | null;
  tlsSniMatched: boolean;
  httpStatus: number | null;
  redirectCount: number;
  elapsedMs: number | null;
  assertionStatus: boolean | null;
  assertionContentType: boolean | null;
  assertionBodyMarker: boolean | null;
  assertionCanonical: boolean | null;
  assertionRequiredHeaders: boolean | null;
  bodySha256: string | null;
}

const manifestKeys = [
  "schema",
  "siteId",
  "environment",
  "allowedOrigins",
  "checks",
] as const;
const checkKeys = [
  "checkId",
  "kind",
  "url",
  "method",
  "validForSeconds",
  "maxRedirects",
  "maxResponseBytes",
  "maxElapsedMs",
  "tlsMinDaysRemaining",
  "expect",
] as const;
const expectKeys = [
  "status",
  "contentTypePrefix",
  "bodyMarker",
  "canonical",
  "requiredHeaders",
] as const;
const redirectStatuses = new Set([301, 302, 303, 307, 308]);

function invalid(code: string): never {
  throw new ContractError(code);
}

function record(value: unknown, code: string): Record<string, unknown> {
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

function identifier(value: unknown, code: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    !/^[A-Za-z0-9_.:-]+$/u.test(value)
  ) {
    invalid(code);
  }
  return value;
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

function shortString(
  value: unknown,
  minimum: number,
  maximum: number,
  code: string,
): string {
  if (
    typeof value !== "string" ||
    value.length < minimum ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    invalid(code);
  }
  return value;
}

function environment(value: unknown): Environment {
  if (value !== "staging" && value !== "production") {
    invalid("public_delivery_manifest_environment_invalid");
  }
  return value;
}

function ipv4Number(value: string): number | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^(?:0|[1-9][0-9]{0,2})$/u.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    result = result * 256 + octet;
  }
  return result >>> 0;
}

function ipv6Parts(value: string): readonly number[] | null {
  if (value.includes(".")) return null;
  const pieces = value.toLowerCase().split("::");
  if (pieces.length > 2) return null;
  const left = pieces[0] === "" ? [] : pieces[0]?.split(":") ?? [];
  const right =
    pieces.length === 1 || pieces[1] === ""
      ? []
      : pieces[1]?.split(":") ?? [];
  const valid = [...left, ...right].every((part) => /^[a-f0-9]{1,4}$/u.test(part));
  if (!valid) return null;
  const missing = 8 - left.length - right.length;
  if (
    (pieces.length === 1 && missing !== 0) ||
    (pieces.length === 2 && missing < 1)
  ) {
    return null;
  }
  return [
    ...left.map((part) => Number.parseInt(part, 16)),
    ...Array.from({ length: missing }, () => 0),
    ...right.map((part) => Number.parseInt(part, 16)),
  ];
}

function subnet(value: number, base: number, prefix: number): boolean {
  if (prefix === 0) return true;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) >>> 0 === (base & mask) >>> 0;
}

function isGlobalIpv4(value: number): boolean {
  const blocked: readonly [number, number][] = [
    [0x00000000, 8],
    [0x0a000000, 8],
    [0x64400000, 10],
    [0x7f000000, 8],
    [0xa9fe0000, 16],
    [0xac100000, 12],
    [0xc0000000, 24],
    [0xc0000200, 24],
    [0xc0a80000, 16],
    [0xc6120000, 15],
    [0xc6336400, 24],
    [0xcb007100, 24],
    [0xe0000000, 4],
    [0xf0000000, 4],
  ];
  return !blocked.some(([base, prefix]) => subnet(value, base, prefix));
}

function ipKey(value: string): string | null {
  const ipv4 = ipv4Number(value);
  if (ipv4 !== null) return `v4:${ipv4}`;
  const ipv6 = ipv6Parts(value);
  return ipv6 ? `v6:${ipv6.map((part) => part.toString(16)).join(":")}` : null;
}

function isGlobalAddress(value: string): boolean {
  const ipv4 = ipv4Number(value);
  if (ipv4 !== null) return isGlobalIpv4(ipv4);
  const ipv6 = ipv6Parts(value);
  if (!ipv6) return false;
  const globalUnicast = (ipv6[0]! & 0xe000) === 0x2000;
  const documentation = ipv6[0] === 0x2001 && ipv6[1] === 0x0db8;
  return globalUnicast && !documentation;
}

function validHostname(hostname: string): boolean {
  return (
    hostname === hostname.toLowerCase() &&
    hostname.length <= 253 &&
    hostname.includes(".") &&
    /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(hostname) &&
    ipKey(hostname) === null
  );
}

function reviewedUrl(
  value: unknown,
  allowedOrigins: readonly string[],
  code = "public_delivery_manifest_target_forbidden",
): URL {
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
    url.search !== "" ||
    url.hash !== "" ||
    !validHostname(url.hostname) ||
    !allowedOrigins.includes(url.origin)
  ) {
    invalid(code);
  }
  return url;
}

function compileOrigin(value: unknown): string {
  if (typeof value !== "string") {
    invalid("public_delivery_manifest_origin_invalid");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid("public_delivery_manifest_origin_invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    !validHostname(url.hostname)
  ) {
    invalid("public_delivery_manifest_origin_invalid");
  }
  return url.origin;
}

function compileExpect(
  input: unknown,
  kind: PublicDeliveryCheckKind,
  allowedOrigins: readonly string[],
): PublicDeliveryExpect {
  const value = record(input, "public_delivery_manifest_expect_invalid");
  strict(value, expectKeys, "public_delivery_manifest_expect_unknown_field");
  const status =
    value.status === undefined
      ? undefined
      : integer(
          value.status,
          100,
          599,
          "public_delivery_manifest_status_invalid",
        );
  const contentTypePrefix =
    value.contentTypePrefix === undefined
      ? undefined
      : shortString(
          value.contentTypePrefix,
          1,
          128,
          "public_delivery_manifest_content_type_invalid",
        ).toLowerCase();
  const bodyMarker =
    value.bodyMarker === undefined
      ? undefined
      : shortString(
          value.bodyMarker,
          1,
          160,
          "public_delivery_manifest_marker_invalid",
        );
  const canonical =
    value.canonical === undefined
      ? undefined
      : reviewedUrl(
          value.canonical,
          allowedOrigins,
          "public_delivery_manifest_canonical_invalid",
        ).href;
  const requiredHeaders =
    value.requiredHeaders === undefined
      ? []
      : Array.isArray(value.requiredHeaders)
        ? value.requiredHeaders.map((header) => {
            if (
              typeof header !== "string" ||
              !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(header)
            ) {
              invalid("public_delivery_manifest_header_invalid");
            }
            return header;
          })
        : invalid("public_delivery_manifest_headers_invalid");
  if (new Set(requiredHeaders).size !== requiredHeaders.length) {
    invalid("public_delivery_manifest_header_duplicate");
  }
  if (
    kind === "http" &&
    (status === undefined || contentTypePrefix === undefined)
  ) {
    invalid("public_delivery_manifest_http_expectation_missing");
  }
  if (
    kind !== "http" &&
    (status !== undefined ||
      contentTypePrefix !== undefined ||
      bodyMarker !== undefined ||
      canonical !== undefined ||
      requiredHeaders.length > 0)
  ) {
    invalid("public_delivery_manifest_non_http_expectation");
  }
  return {
    status,
    contentTypePrefix,
    bodyMarker,
    canonical,
    requiredHeaders,
  };
}

export function compilePublicDeliveryManifest(
  input: unknown,
): PublicDeliveryManifest {
  const value = record(input, "public_delivery_manifest_invalid");
  strict(value, manifestKeys, "public_delivery_manifest_unknown_field");
  if (value.schema !== "public-delivery-manifest-v1") {
    invalid("public_delivery_manifest_schema_invalid");
  }
  const siteId = identifier(
    value.siteId,
    "public_delivery_manifest_site_invalid",
  );
  if (
    !Array.isArray(value.allowedOrigins) ||
    value.allowedOrigins.length < 1 ||
    value.allowedOrigins.length > 8
  ) {
    invalid("public_delivery_manifest_origins_invalid");
  }
  const allowedOrigins = value.allowedOrigins.map(compileOrigin);
  if (new Set(allowedOrigins).size !== allowedOrigins.length) {
    invalid("public_delivery_manifest_origin_duplicate");
  }
  if (
    !Array.isArray(value.checks) ||
    value.checks.length < 1 ||
    value.checks.length > 64
  ) {
    invalid("public_delivery_manifest_checks_invalid");
  }
  const checks = value.checks.map((candidate) => {
    const check = record(
      candidate,
      "public_delivery_manifest_check_invalid",
    );
    strict(check, checkKeys, "public_delivery_manifest_check_unknown_field");
    const kind =
      check.kind === "dns" ||
      check.kind === "tls" ||
      check.kind === "http"
        ? check.kind
        : invalid("public_delivery_manifest_kind_invalid");
    const method =
      check.method === "GET" || check.method === "HEAD"
        ? check.method
        : invalid("public_delivery_manifest_method_invalid");
    const url = reviewedUrl(check.url, allowedOrigins).href;
    const maxResponseBytes = integer(
      check.maxResponseBytes,
      0,
      1_048_576,
      "public_delivery_manifest_body_limit_invalid",
    );
    if (kind === "http" && maxResponseBytes < 1) {
      invalid("public_delivery_manifest_body_limit_invalid");
    }
    if (kind !== "http" && maxResponseBytes !== 0) {
      invalid("public_delivery_manifest_non_http_body_limit");
    }
    return {
      checkId: identifier(
        check.checkId,
        "public_delivery_manifest_check_id_invalid",
      ),
      kind,
      url,
      method,
      validForSeconds: integer(
        check.validForSeconds,
        30,
        900,
        "public_delivery_manifest_freshness_invalid",
      ),
      maxRedirects: integer(
        check.maxRedirects,
        0,
        5,
        "public_delivery_manifest_redirect_limit_invalid",
      ),
      maxResponseBytes,
      maxElapsedMs: integer(
        check.maxElapsedMs,
        100,
        30_000,
        "public_delivery_manifest_latency_invalid",
      ),
      tlsMinDaysRemaining: integer(
        check.tlsMinDaysRemaining,
        1,
        90,
        "public_delivery_manifest_tls_window_invalid",
      ),
      expect: compileExpect(check.expect, kind, allowedOrigins),
    } satisfies PublicDeliveryCheck;
  });
  if (new Set(checks.map((check) => check.checkId)).size !== checks.length) {
    invalid("public_delivery_manifest_check_duplicate");
  }
  return {
    schema: "public-delivery-manifest-v1",
    siteId,
    environment: environment(value.environment),
    allowedOrigins,
    checks,
  };
}

function initialEvidence(): EvidenceState {
  return {
    answerCount: 0,
    minimumTtlSeconds: null,
    allGlobal: false,
    connectionAttested: false,
    tlsAuthorized: false,
    tlsProtocol: null,
    tlsDaysRemaining: null,
    tlsSniMatched: false,
    httpStatus: null,
    redirectCount: 0,
    elapsedMs: null,
    assertionStatus: null,
    assertionContentType: null,
    assertionBodyMarker: null,
    assertionCanonical: null,
    assertionRequiredHeaders: null,
    bodySha256: null,
  };
}

function lowerHeaders(
  headers: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    result[name.toLowerCase()] = value;
  }
  return result;
}

function protocolSafe(protocol: string): boolean {
  return protocol === "TLSv1.2" || protocol === "TLSv1.3";
}

function canonicalFromHtml(html: string): string | null {
  const tags = html.match(/<link\b[^>]*>/giu) ?? [];
  for (const tag of tags) {
    const rel = /\brel\s*=\s*["']([^"']+)["']/iu.exec(tag)?.[1];
    if (!rel?.split(/\s+/u).some((value) => value.toLowerCase() === "canonical")) {
      continue;
    }
    return /\bhref\s*=\s*["']([^"']+)["']/iu.exec(tag)?.[1] ?? null;
  }
  return null;
}

async function sha256(value: Uint8Array | string): Promise<string> {
  const bytes: Uint8Array<ArrayBuffer> =
    typeof value === "string"
      ? new TextEncoder().encode(value)
      : Uint8Array.from(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function safeCorrelationId(value: string): string {
  return identifier(value, "public_delivery_correlation_id_invalid");
}

async function finish(
  input: RunPublicDeliveryCheckInput,
  check: PublicDeliveryCheck,
  target: URL,
  evidenceState: EvidenceState,
  status: ObservationStatus,
  reasonCode: string,
): Promise<PublicDeliveryProbeResult> {
  const observedAt = new Date(input.now).toISOString();
  const identity = stableJson({
    schema: "public-delivery-result-identity-v1",
    siteId: input.selection.siteId,
    environment: input.selection.environment,
    checkId: check.checkId,
    observedAt,
    status,
    reasonCode,
  });
  const identityDigest = await sha256(identity);
  const evidenceId = `ev_${(await sha256(`evidence:${identity}`)).slice(0, 32)}`;
  const evidence: PublicDeliveryEvidence = {
    schema: "public-delivery-evidence-v1",
    evidenceId,
    siteId: input.selection.siteId,
    environment: input.selection.environment,
    checkId: check.checkId,
    observedAt,
    target: {
      origin: target.origin,
      path: target.pathname,
    },
    dns: {
      answerCount: evidenceState.answerCount,
      minimumTtlSeconds: evidenceState.minimumTtlSeconds,
      allGlobal: evidenceState.allGlobal,
      connectionAttested: evidenceState.connectionAttested,
    },
    tls: {
      authorized: evidenceState.tlsAuthorized,
      protocol: evidenceState.tlsProtocol,
      daysRemaining: evidenceState.tlsDaysRemaining,
      sniMatched: evidenceState.tlsSniMatched,
    },
    http: {
      status: evidenceState.httpStatus,
      redirectCount: evidenceState.redirectCount,
      elapsedMs: evidenceState.elapsedMs,
    },
    assertions: {
      status: evidenceState.assertionStatus,
      contentType: evidenceState.assertionContentType,
      bodyMarker: evidenceState.assertionBodyMarker,
      canonical: evidenceState.assertionCanonical,
      requiredHeaders: evidenceState.assertionRequiredHeaders,
    },
    bodySha256: evidenceState.bodySha256,
    result: status,
    reasonCode,
  };
  return {
    observation: {
      schemaVersion: 1,
      observationId: `obs_${identityDigest.slice(0, 32)}`,
      siteId: input.selection.siteId,
      environment: input.selection.environment,
      component: "public_delivery",
      checkId: check.checkId,
      status,
      reasonCode,
      observedAt,
      validUntil: new Date(
        input.now + check.validForSeconds * 1_000,
      ).toISOString(),
      source: "public_probe",
      scope: `${target.origin}${target.pathname}`,
      evidenceId,
      correlationId: safeCorrelationId(input.correlationId),
      idempotencyKey:
        `probe:${input.selection.siteId}:${input.selection.environment}:` +
        `${check.checkId}:${identityDigest}`,
    },
    evidence,
  };
}

function selectionCheck(
  manifest: PublicDeliveryManifest,
  selection: PublicDeliverySelection,
): PublicDeliveryCheck {
  if (
    selection.siteId !== manifest.siteId ||
    selection.environment !== manifest.environment
  ) {
    invalid("public_delivery_selection_scope_invalid");
  }
  const checkId = identifier(
    selection.checkId,
    "public_delivery_selection_check_invalid",
  );
  const check = manifest.checks.find((candidate) => candidate.checkId === checkId);
  return check ?? invalid("public_delivery_selection_check_unknown");
}

function indeterminateHttpStatus(status: number): boolean {
  return status === 403 || status === 429 || status >= 500;
}

export async function runPublicDeliveryCheck(
  input: RunPublicDeliveryCheckInput,
): Promise<PublicDeliveryProbeResult> {
  if (!Number.isFinite(input.now)) {
    invalid("public_delivery_observed_at_invalid");
  }
  safeCorrelationId(input.correlationId);
  const check = selectionCheck(input.manifest, input.selection);
  const target = reviewedUrl(check.url, input.manifest.allowedOrigins);
  const state = initialEvidence();
  let current = target;

  for (let hop = 0; hop <= check.maxRedirects + 1; hop += 1) {
    let dns: PublicDeliveryDnsResult;
    try {
      dns = await input.ports.resolve(current.hostname);
    } catch {
      return finish(
        input,
        check,
        target,
        state,
        "unknown",
        "dns_resolution_failed",
      );
    }
    if (
      dns.addresses.length < 1 ||
      dns.addresses.length > 32 ||
      !Number.isInteger(dns.ttlSeconds) ||
      dns.ttlSeconds < 1
    ) {
      return finish(
        input,
        check,
        target,
        state,
        "unknown",
        "dns_response_invalid",
      );
    }
    state.answerCount += dns.addresses.length;
    state.minimumTtlSeconds =
      state.minimumTtlSeconds === null
        ? dns.ttlSeconds
        : Math.min(state.minimumTtlSeconds, dns.ttlSeconds);
    if (dns.addresses.some((address) => !isGlobalAddress(address))) {
      return finish(
        input,
        check,
        target,
        state,
        "fail",
        "dns_non_global_address",
      );
    }
    state.allGlobal = true;
    if (check.kind === "dns") {
      return finish(
        input,
        check,
        target,
        state,
        "pass",
        "dns_resolution_healthy",
      );
    }

    let exchange: PublicDeliveryExchange;
    try {
      exchange = await input.ports.exchange({
        url: current.href,
        method: check.method,
        allowedAddresses: dns.addresses,
        maxResponseBytes: check.maxResponseBytes,
      });
    } catch {
      return finish(
        input,
        check,
        target,
        state,
        "unknown",
        "probe_transport_error",
      );
    }
    const allowedAddressKeys = new Set(dns.addresses.map(ipKey));
    if (
      !isGlobalAddress(exchange.connectedAddress) ||
      !allowedAddressKeys.has(ipKey(exchange.connectedAddress))
    ) {
      return finish(
        input,
        check,
        target,
        state,
        "fail",
        "http_connection_ip_mismatch",
      );
    }
    state.connectionAttested = true;
    state.httpStatus = exchange.status;
    state.elapsedMs =
      state.elapsedMs === null
        ? exchange.elapsedMs
        : state.elapsedMs + exchange.elapsedMs;
    state.tlsAuthorized = exchange.tls.authorized;
    state.tlsProtocol = exchange.tls.protocol;
    state.tlsDaysRemaining = exchange.tls.daysRemaining;
    state.tlsSniMatched =
      exchange.tls.sniHostname.toLowerCase() === current.hostname;
    if (
      !exchange.tls.authorized ||
      !protocolSafe(exchange.tls.protocol) ||
      !state.tlsSniMatched
    ) {
      return finish(input, check, target, state, "fail", "tls_invalid");
    }
    if (
      !Number.isFinite(exchange.tls.daysRemaining) ||
      exchange.tls.daysRemaining < 0
    ) {
      return finish(
        input,
        check,
        target,
        state,
        "unknown",
        "tls_evidence_invalid",
      );
    }
    if (exchange.tls.daysRemaining < check.tlsMinDaysRemaining) {
      return finish(input, check, target, state, "degraded", "tls_expiring");
    }
    if (check.kind === "tls") {
      return finish(input, check, target, state, "pass", "tls_healthy");
    }
    if (
      !Number.isInteger(exchange.status) ||
      exchange.status < 100 ||
      exchange.status > 599 ||
      !Number.isFinite(exchange.elapsedMs) ||
      exchange.elapsedMs < 0
    ) {
      return finish(
        input,
        check,
        target,
        state,
        "unknown",
        "http_response_invalid",
      );
    }

    const headers = lowerHeaders(exchange.headers);
    if (redirectStatuses.has(exchange.status)) {
      const location = headers.location;
      if (!location) {
        return finish(
          input,
          check,
          target,
          state,
          "fail",
          "http_redirect_location_missing",
        );
      }
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        return finish(
          input,
          check,
          target,
          state,
          "fail",
          "http_redirect_location_invalid",
        );
      }
      try {
        reviewedUrl(
          next.href,
          input.manifest.allowedOrigins,
          "http_off_origin_redirect",
        );
      } catch (error) {
        if (
          error instanceof ContractError &&
          error.code === "http_off_origin_redirect"
        ) {
          return finish(
            input,
            check,
            target,
            state,
            "fail",
            "http_off_origin_redirect",
          );
        }
        throw error;
      }
      if (state.redirectCount >= check.maxRedirects) {
        return finish(
          input,
          check,
          target,
          state,
          "fail",
          "http_redirect_limit",
        );
      }
      state.redirectCount += 1;
      current = next;
      continue;
    }

    const expectedStatus = check.expect.status!;
    state.assertionStatus = exchange.status === expectedStatus;
    if (!state.assertionStatus) {
      return finish(
        input,
        check,
        target,
        state,
        indeterminateHttpStatus(exchange.status) ? "unknown" : "fail",
        indeterminateHttpStatus(exchange.status)
          ? "http_response_indeterminate"
          : "http_status_unexpected",
      );
    }
    const contentType = headers["content-type"]?.toLowerCase() ?? "";
    state.assertionContentType = contentType.startsWith(
      check.expect.contentTypePrefix!,
    );
    if (!state.assertionContentType) {
      return finish(
        input,
        check,
        target,
        state,
        "fail",
        "http_content_type_unexpected",
      );
    }
    state.assertionRequiredHeaders = check.expect.requiredHeaders.every(
      (header) => headers[header] !== undefined,
    );
    if (!state.assertionRequiredHeaders) {
      return finish(
        input,
        check,
        target,
        state,
        "fail",
        "http_required_header_missing",
      );
    }
    if (exchange.body.byteLength > check.maxResponseBytes) {
      return finish(
        input,
        check,
        target,
        state,
        "unknown",
        "http_body_too_large",
      );
    }
    state.bodySha256 = await sha256(exchange.body);
    let body = "";
    if (check.expect.bodyMarker !== undefined || check.expect.canonical !== undefined) {
      try {
        body = new TextDecoder("utf-8", { fatal: true }).decode(exchange.body);
      } catch {
        return finish(
          input,
          check,
          target,
          state,
          "unknown",
          "http_body_decode_invalid",
        );
      }
    }
    state.assertionBodyMarker =
      check.expect.bodyMarker === undefined
        ? null
        : body.includes(check.expect.bodyMarker);
    if (state.assertionBodyMarker === false) {
      return finish(
        input,
        check,
        target,
        state,
        "fail",
        "http_marker_missing",
      );
    }
    state.assertionCanonical =
      check.expect.canonical === undefined
        ? null
        : canonicalFromHtml(body) === check.expect.canonical;
    if (state.assertionCanonical === false) {
      return finish(
        input,
        check,
        target,
        state,
        "fail",
        "http_canonical_mismatch",
      );
    }
    if ((state.elapsedMs ?? 0) > check.maxElapsedMs) {
      return finish(
        input,
        check,
        target,
        state,
        "degraded",
        "http_latency_high",
      );
    }
    return finish(
      input,
      check,
      target,
      state,
      "pass",
      "public_delivery_healthy",
    );
  }
  return finish(
    input,
    check,
    target,
    state,
    "fail",
    "http_redirect_limit",
  );
}
