import {
  bearerTokenMatches,
  ContractError,
  signHmacSha256,
  stableJson,
  verifyHmacSha256,
  type Environment,
} from "./ops-signal.ts";
import { sha256Hex } from "../security/safe-output.ts";

export interface PostDeployRequest {
  schema: "site-deploy-post-deploy-v1";
  event: "site_deploy.post_deploy_requested";
  requestId: string;
  siteId: string;
  environment: Environment;
  commitSha: string;
  workerVersionId: string;
  evidenceDigest: string;
  requestedAt: number;
}

export interface UnsignedPostDeployVerdict {
  schema: "site-deploy-post-deploy-verdict-v1";
  event: "site_deploy.post_deploy_verdict";
  requestId: string;
  siteId: string;
  environment: Environment;
  commitSha: string;
  decision: "allow";
  checkedAt: number;
  freshUntil: number;
}

export interface SignedPostDeployVerdict
  extends UnsignedPostDeployVerdict {
  signature: string;
}

export interface PostDeployCredential {
  siteId: string;
  environment: Environment;
  serviceToken: string;
  signingSecret: string;
  maxAgeSeconds: number;
  maxFutureSkewSeconds: number;
}

export interface VerifyPostDeployRequestInput {
  rawBody: Uint8Array<ArrayBuffer>;
  authorization: string | null | undefined;
  signature: string | null | undefined;
  nowSeconds: number;
  credential: PostDeployCredential;
}

export interface VerifiedPostDeployRequest {
  request: PostDeployRequest;
  requestDigest: string;
  verifiedAtSeconds: number;
}

const requestKeys = [
  "schema",
  "event",
  "requestId",
  "siteId",
  "environment",
  "commitSha",
  "workerVersionId",
  "evidenceDigest",
  "requestedAt",
] as const;
const verdictKeys = [
  "schema",
  "event",
  "requestId",
  "siteId",
  "environment",
  "commitSha",
  "decision",
  "checkedAt",
  "freshUntil",
] as const;
const signedVerdictKeys = [...verdictKeys, "signature"] as const;

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

function environment(value: unknown): Environment {
  return value === "staging" || value === "production"
    ? value
    : invalid("post_deploy_environment_invalid");
}

export function parsePostDeployRequest(
  input: unknown,
): PostDeployRequest {
  const value = record(input, "post_deploy_request_invalid");
  strict(value, requestKeys, "post_deploy_request_unknown_field");
  if (
    value.schema !== "site-deploy-post-deploy-v1" ||
    value.event !== "site_deploy.post_deploy_requested"
  ) {
    invalid("post_deploy_schema_invalid");
  }
  if (
    typeof value.requestId !== "string" ||
    !/^site-deploy-[0-9]{1,32}-[0-9]{1,8}$/u.test(value.requestId)
  ) {
    invalid("post_deploy_request_id_invalid");
  }
  if (
    typeof value.siteId !== "string" ||
    !/^[a-z][a-z0-9-]{2,63}$/u.test(value.siteId)
  ) {
    invalid("post_deploy_site_id_invalid");
  }
  if (
    typeof value.commitSha !== "string" ||
    !/^[a-f0-9]{40}$/u.test(value.commitSha)
  ) {
    invalid("post_deploy_commit_sha_invalid");
  }
  if (
    typeof value.workerVersionId !== "string" ||
    !/^[a-z0-9][a-z0-9.:-]{2,127}$/u.test(value.workerVersionId)
  ) {
    invalid("post_deploy_worker_version_invalid");
  }
  if (
    typeof value.evidenceDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(value.evidenceDigest)
  ) {
    invalid("post_deploy_evidence_digest_invalid");
  }
  if (
    typeof value.requestedAt !== "number" ||
    !Number.isSafeInteger(value.requestedAt) ||
    value.requestedAt < 1
  ) {
    invalid("post_deploy_timestamp_invalid");
  }
  return {
    schema: "site-deploy-post-deploy-v1",
    event: "site_deploy.post_deploy_requested",
    requestId: value.requestId,
    siteId: value.siteId,
    environment: environment(value.environment),
    commitSha: value.commitSha,
    workerVersionId: value.workerVersionId,
    evidenceDigest: value.evidenceDigest,
    requestedAt: value.requestedAt,
  };
}

function parseUnsignedVerdict(
  input: unknown,
): UnsignedPostDeployVerdict {
  const value = record(input, "post_deploy_verdict_invalid");
  strict(value, verdictKeys, "post_deploy_verdict_unknown_field");
  if (
    value.schema !== "site-deploy-post-deploy-verdict-v1" ||
    value.event !== "site_deploy.post_deploy_verdict" ||
    value.decision !== "allow"
  ) {
    invalid("post_deploy_verdict_schema_invalid");
  }
  if (
    typeof value.requestId !== "string" ||
    !/^site-deploy-[0-9]{1,32}-[0-9]{1,8}$/u.test(value.requestId) ||
    typeof value.siteId !== "string" ||
    !/^[a-z][a-z0-9-]{2,63}$/u.test(value.siteId) ||
    typeof value.commitSha !== "string" ||
    !/^[a-f0-9]{40}$/u.test(value.commitSha) ||
    typeof value.checkedAt !== "number" ||
    !Number.isSafeInteger(value.checkedAt) ||
    value.checkedAt < 1 ||
    typeof value.freshUntil !== "number" ||
    !Number.isSafeInteger(value.freshUntil) ||
    value.freshUntil <= value.checkedAt ||
    value.freshUntil > value.checkedAt + 3_600
  ) {
    invalid("post_deploy_verdict_invalid");
  }
  return {
    schema: "site-deploy-post-deploy-verdict-v1",
    event: "site_deploy.post_deploy_verdict",
    requestId: value.requestId,
    siteId: value.siteId,
    environment: environment(value.environment),
    commitSha: value.commitSha,
    decision: "allow",
    checkedAt: value.checkedAt,
    freshUntil: value.freshUntil,
  };
}

export function parsePostDeployVerdict(
  input: unknown,
): SignedPostDeployVerdict {
  const value = record(input, "post_deploy_verdict_invalid");
  strict(value, signedVerdictKeys, "post_deploy_verdict_unknown_field");
  const unsignedInput: Record<string, unknown> = {};
  for (const key of verdictKeys) unsignedInput[key] = value[key];
  const parsed = parseUnsignedVerdict(unsignedInput);
  if (
    typeof value.signature !== "string" ||
    !/^hmac-sha256:[a-f0-9]{64}$/u.test(value.signature)
  ) {
    invalid("post_deploy_verdict_signature_invalid");
  }
  return { ...parsed, signature: value.signature };
}

export function canonicalPostDeployRequest(input: unknown): string {
  return stableJson(parsePostDeployRequest(input));
}

function validCredential(credential: PostDeployCredential): boolean {
  return (
    /^[a-z][a-z0-9-]{2,63}$/u.test(credential.siteId) &&
    (credential.environment === "staging" ||
      credential.environment === "production") &&
    credential.serviceToken.length >= 16 &&
    credential.serviceToken.length <= 4_096 &&
    !/[\r\n]/u.test(credential.serviceToken) &&
    new TextEncoder().encode(credential.signingSecret).byteLength >= 32 &&
    Number.isInteger(credential.maxAgeSeconds) &&
    credential.maxAgeSeconds >= 1 &&
    credential.maxAgeSeconds <= 900 &&
    Number.isInteger(credential.maxFutureSkewSeconds) &&
    credential.maxFutureSkewSeconds >= 0 &&
    credential.maxFutureSkewSeconds <= 300
  );
}

export async function verifyPostDeployRequest(
  input: VerifyPostDeployRequestInput,
): Promise<VerifiedPostDeployRequest> {
  if (
    !(input.rawBody instanceof Uint8Array) ||
    input.rawBody.byteLength < 2 ||
    input.rawBody.byteLength > 64 * 1_024 ||
    !Number.isSafeInteger(input.nowSeconds) ||
    !validCredential(input.credential)
  ) {
    invalid("post_deploy_request_invalid");
  }
  const authorization = input.authorization;
  if (
    typeof authorization !== "string" ||
    !authorization.startsWith("Bearer ") ||
    /[\r\n,]/u.test(authorization)
  ) {
    invalid("post_deploy_auth_invalid");
  }
  const candidate = authorization.slice("Bearer ".length);
  if (
    candidate.length < 16 ||
    candidate.length > 4_096 ||
    !(await bearerTokenMatches(candidate, input.credential.serviceToken))
  ) {
    invalid("post_deploy_auth_invalid");
  }
  let signatureValid = false;
  try {
    signatureValid = await verifyHmacSha256(
      input.rawBody,
      input.signature,
      input.credential.signingSecret,
    );
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) invalid("post_deploy_signature_invalid");
  let rawText: string;
  try {
    rawText = new TextDecoder("utf-8", { fatal: true }).decode(
      input.rawBody,
    );
  } catch {
    return invalid("post_deploy_body_invalid");
  }
  let parsedInput: unknown;
  try {
    parsedInput = JSON.parse(rawText);
  } catch {
    return invalid("post_deploy_body_invalid");
  }
  const request = parsePostDeployRequest(parsedInput);
  if (stableJson(request) !== rawText) {
    invalid("post_deploy_body_noncanonical");
  }
  if (
    request.siteId !== input.credential.siteId ||
    request.environment !== input.credential.environment
  ) {
    invalid("post_deploy_scope_invalid");
  }
  const age = input.nowSeconds - request.requestedAt;
  if (age > input.credential.maxAgeSeconds) {
    invalid("post_deploy_request_stale");
  }
  if (age < -input.credential.maxFutureSkewSeconds) {
    invalid("post_deploy_request_from_future");
  }
  return {
    request,
    requestDigest: await sha256Hex(input.rawBody),
    verifiedAtSeconds: input.nowSeconds,
  };
}

export async function buildSignedPostDeployVerdict(
  input: Omit<
    UnsignedPostDeployVerdict,
    "schema" | "event"
  >,
  secret: string,
): Promise<SignedPostDeployVerdict> {
  const parsed = parseUnsignedVerdict({
    schema: "site-deploy-post-deploy-verdict-v1",
    event: "site_deploy.post_deploy_verdict",
    ...input,
  });
  return {
    ...parsed,
    signature: await signHmacSha256(stableJson(parsed), secret),
  };
}

export async function verifyPostDeployVerdict(
  input: unknown,
  secret: string,
): Promise<boolean> {
  try {
    const parsed = parsePostDeployVerdict(input);
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
