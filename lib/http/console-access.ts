export type ConsoleEnvironment = "staging" | "production";

export interface ConsoleAccessPolicy {
  siteId: string;
  environment: ConsoleEnvironment;
  accessAudience: string;
}

export interface ConsoleVerifiedIdentity {
  subject: string;
  audiences: readonly string[];
}

export interface ConsoleAccessInput {
  policy: ConsoleAccessPolicy;
  requestedScope: {
    siteId: string;
    environment: ConsoleEnvironment;
  };
}

export type ConsoleAccessDecision =
  | { allowed: true }
  | {
      allowed: false;
      status: 401 | 403 | 405 | 503;
      code: "unauthorized" | "forbidden" | "method_not_allowed" | "service_unavailable";
    };

export type ConsoleIdentityVerifier = (
  request: Request,
) => Promise<ConsoleVerifiedIdentity | null>;

export interface CloudflareAccessConfiguration {
  issuer: string;
  audience: string;
  nowSeconds?: () => number;
}

interface JwtHeader {
  alg?: unknown;
  kid?: unknown;
  typ?: unknown;
}

interface JwtClaims {
  aud?: unknown;
  exp?: unknown;
  iat?: unknown;
  iss?: unknown;
  nbf?: unknown;
  sub?: unknown;
}

interface JsonWebKeySet {
  keys?: unknown;
}

interface AccessJsonWebKey extends JsonWebKey {
  alg?: string;
  kid?: string;
  kty?: string;
  use?: string;
}

const MAX_ASSERTION_LENGTH = 16_384;
const MAX_JWKS_BYTES = 131_072;
const CLOCK_SKEW_SECONDS = 30;

export async function authorizeConsoleRequest(
  request: Request,
  input: ConsoleAccessInput,
  verifier: ConsoleIdentityVerifier,
): Promise<ConsoleAccessDecision> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return {
      allowed: false,
      status: 405,
      code: "method_not_allowed",
    };
  }

  if (!validPolicy(input.policy)) {
    return {
      allowed: false,
      status: 503,
      code: "service_unavailable",
    };
  }

  let identity: ConsoleVerifiedIdentity | null;
  try {
    identity = await verifier(request);
  } catch {
    identity = null;
  }
  if (identity === null) {
    return {
      allowed: false,
      status: 401,
      code: "unauthorized",
    };
  }

  if (
    input.requestedScope.siteId !== input.policy.siteId ||
    input.requestedScope.environment !== input.policy.environment ||
    !identity.audiences.includes(input.policy.accessAudience)
  ) {
    return {
      allowed: false,
      status: 403,
      code: "forbidden",
    };
  }

  return { allowed: true };
}

export async function verifyCloudflareAccessRequest(
  request: Request,
  configuration: CloudflareAccessConfiguration,
  fetcher: typeof fetch = fetch,
): Promise<ConsoleVerifiedIdentity | null> {
  try {
    const assertion = request.headers.get("cf-access-jwt-assertion");
    if (
      assertion === null ||
      assertion.length === 0 ||
      assertion.length > MAX_ASSERTION_LENGTH ||
      /[\s,]/u.test(assertion)
    ) {
      return null;
    }

    const issuer = accessIssuer(configuration.issuer);
    if (issuer === null || !validAudience(configuration.audience)) return null;

    const segments = assertion.split(".");
    if (segments.length !== 3) return null;
    const [encodedHeader, encodedClaims, encodedSignature] = segments;
    const header = decodeJson<JwtHeader>(encodedHeader);
    const claims = decodeJson<JwtClaims>(encodedClaims);
    const signature = decodeBase64Url(encodedSignature);
    if (
      header === null ||
      claims === null ||
      signature === null ||
      header.alg !== "RS256" ||
      typeof header.kid !== "string" ||
      !validOpaqueIdentifier(header.kid, 256)
    ) {
      return null;
    }

    const now = (configuration.nowSeconds ?? defaultNowSeconds)();
    const audiences = jwtAudiences(claims.aud);
    if (
      claims.iss !== issuer ||
      typeof claims.sub !== "string" ||
      !validOpaqueIdentifier(claims.sub, 512) ||
      !audiences.includes(configuration.audience) ||
      !validJwtTime(claims.exp) ||
      claims.exp <= now ||
      (claims.nbf !== undefined &&
        (!validJwtTime(claims.nbf) ||
          claims.nbf > now + CLOCK_SKEW_SECONDS)) ||
      (claims.iat !== undefined &&
        (!validJwtTime(claims.iat) ||
          claims.iat > now + CLOCK_SKEW_SECONDS))
    ) {
      return null;
    }

    const keys = await loadJsonWebKeys(
      `${issuer}/cdn-cgi/access/certs`,
      fetcher,
    );
    const candidate = keys.find(
      (key) =>
        key.kid === header.kid &&
        key.kty === "RSA" &&
        (key.alg === undefined || key.alg === "RS256") &&
        (key.use === undefined || key.use === "sig"),
    );
    if (candidate === undefined) return null;

    const key = await crypto.subtle.importKey(
      "jwk",
      candidate,
      {
        name: "RSASSA-PKCS1-v1_5",
        hash: "SHA-256",
      },
      false,
      ["verify"],
    );
    const signed = new TextEncoder().encode(
      `${encodedHeader}.${encodedClaims}`,
    );
    const signatureBytes = new Uint8Array(signature.byteLength);
    signatureBytes.set(signature);
    const verified = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      signatureBytes,
      signed,
    );
    if (!verified) return null;

    return {
      subject: claims.sub,
      audiences,
    };
  } catch {
    return null;
  }
}

export async function verifySitesPrivateRequest(
  request: Request,
  audience: string,
): Promise<ConsoleVerifiedIdentity | null> {
  const email = request.headers.get("oai-authenticated-user-email");
  if (
    email === null ||
    email.length < 3 ||
    email.length > 320 ||
    !email.includes("@") ||
    /[\s\r\n,]/u.test(email) ||
    !validAudience(audience)
  ) {
    return null;
  }
  return {
    subject: "sites-private-user",
    audiences: [audience],
  };
}

export async function verifyLocalConsoleRequest(
  request: Request,
  audience: string,
): Promise<ConsoleVerifiedIdentity | null> {
  const hostname = new URL(request.url).hostname;
  if (
    hostname !== "localhost" &&
    hostname !== "127.0.0.1" &&
    hostname !== "::1"
  ) {
    return null;
  }
  return {
    subject: "local-development",
    audiences: [audience],
  };
}

export function createConsoleCspNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export function prepareConsoleHtmlRequest(
  request: Request,
  nonce: string,
): Request {
  const headers = new Headers(request.headers);
  headers.set("content-security-policy", consoleContentSecurityPolicy(nonce));
  for (const sensitive of [
    "authorization",
    "cookie",
    "cf-access-jwt-assertion",
    "cf-access-authenticated-user-email",
    "oai-authenticated-user-email",
    "oai-authenticated-user-full-name",
    "oai-authenticated-user-full-name-encoding",
    "x-guard-site-id",
    "x-guard-environment",
  ]) {
    headers.delete(sensitive);
  }
  return new Request(request, { headers });
}

export function applyConsoleSecurityHeaders(
  response: Response,
  nonce?: string,
): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "private, no-store, max-age=0");
  headers.set(
    "content-security-policy",
    consoleContentSecurityPolicy(nonce),
  );
  headers.set("cross-origin-opener-policy", "same-origin");
  headers.set("cross-origin-resource-policy", "same-origin");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("x-robots-tag", "noindex, nofollow, noarchive");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function consoleAccessErrorResponse(
  decision: ConsoleAccessDecision,
): Response {
  const denied = decision.allowed
    ? {
        status: 503 as const,
        code: "service_unavailable" as const,
      }
    : decision;
  return applyConsoleSecurityHeaders(
    Response.json(
      { error: denied.code },
      {
        status: denied.status,
        headers: {
          "cache-control": "private, no-store, max-age=0",
        },
      },
    ),
  );
}

function consoleContentSecurityPolicy(nonce?: string): string {
  const nonceSource =
    nonce !== undefined && /^[A-Za-z0-9_-]{22}$/u.test(nonce)
      ? ` 'nonce-${nonce}' 'strict-dynamic'`
      : "";
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "connect-src 'self'",
    "font-src 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "manifest-src 'self'",
    "object-src 'none'",
    `script-src 'self'${nonceSource}`,
    `style-src 'self'${
      nonceSource === "" ? "" : ` 'nonce-${nonce}'`
    }`,
    "worker-src 'none'",
  ].join("; ");
}

function validPolicy(policy: ConsoleAccessPolicy): boolean {
  return (
    /^[a-z0-9][a-z0-9-]{1,62}$/u.test(policy.siteId) &&
    (policy.environment === "staging" ||
      policy.environment === "production") &&
    validAudience(policy.accessAudience)
  );
}

function validAudience(value: string): boolean {
  return validOpaqueIdentifier(value, 512);
}

function validOpaqueIdentifier(value: string, maxLength: number): boolean {
  return (
    value.length > 0 &&
    value.length <= maxLength &&
    !/[\s\r\n,]/u.test(value)
  );
}

function accessIssuer(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !url.hostname.endsWith(".cloudflareaccess.com")
  ) {
    return null;
  }
  const path = url.pathname.replace(/\/+$/u, "");
  if (path !== "") return null;
  return `https://${url.hostname}`;
}

function jwtAudiences(value: unknown): string[] {
  if (typeof value === "string" && validAudience(value)) return [value];
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 16 &&
    value.every(
      (item): item is string =>
        typeof item === "string" && validAudience(item),
    )
  ) {
    return [...new Set(value)];
  }
  return [];
}

function validJwtTime(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

function defaultNowSeconds(): number {
  return Math.floor(Date.now() / 1_000);
}

function decodeJson<T>(value: string): T | null {
  const bytes = decodeBase64Url(value);
  if (bytes === null || bytes.byteLength === 0 || bytes.byteLength > 16_384) {
    return null;
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as T;
  } catch {
    return null;
  }
}

function decodeBase64Url(value: string): Uint8Array | null {
  if (value.length === 0 || !/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  try {
    const decoded = atob(
      value.replaceAll("-", "+").replaceAll("_", "/") + padding,
    );
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function loadJsonWebKeys(
  url: string,
  fetcher: typeof fetch,
): Promise<AccessJsonWebKey[]> {
  const response = await fetcher(url, {
    headers: { accept: "application/json" },
    redirect: "error",
  });
  if (!response.ok) return [];
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null &&
    Number.parseInt(contentLength, 10) > MAX_JWKS_BYTES
  ) {
    return [];
  }
  const raw = await response.text();
  if (raw.length === 0 || raw.length > MAX_JWKS_BYTES) return [];
  let parsed: JsonWebKeySet;
  try {
    parsed = JSON.parse(raw) as JsonWebKeySet;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed.keys) || parsed.keys.length > 32) return [];
  return parsed.keys.filter(
    (value): value is AccessJsonWebKey =>
      value !== null && typeof value === "object" && !Array.isArray(value),
  );
}
