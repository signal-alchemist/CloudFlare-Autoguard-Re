import {
  buildSignedMaintenanceReceipt,
  parseMaintenanceRequest,
  parseMaintenanceReceipt,
  stableJson,
  verifyMaintenanceReceipt,
  type MaintenanceRequest,
  type SignedMaintenanceReceipt,
  type VerifiedMaintenanceRequest,
} from "../contracts/maintenance-request.ts";
import { ContractError } from "../contracts/ops-signal.ts";
import { sha256Hex } from "../security/safe-output.ts";
import type {
  D1DatabasePort,
  D1RunResult,
} from "./observations.ts";

export interface RecordMaintenanceRequestResult {
  status: "accepted" | "duplicate";
  receipt: SignedMaintenanceReceipt;
}

interface PersistedMaintenanceRow {
  request_id: unknown;
  request_digest: unknown;
  site_id: unknown;
  environment: unknown;
  requested_by: unknown;
  reason_code: unknown;
  requested_at: unknown;
  expires_at: unknown;
  credential_id: unknown;
  status: unknown;
  recorded_at: unknown;
  freeze_id: unknown;
  freeze_site_id: unknown;
  freeze_environment: unknown;
  freeze_reason_code: unknown;
  correlation_id: unknown;
  activated_at: unknown;
  freeze_expires_at: unknown;
  released_at: unknown;
  response_json: unknown;
  response_digest: unknown;
  receipt_recorded_at: unknown;
  audit_id: unknown;
  audit_actor_type: unknown;
  audit_actor_id: unknown;
  audit_action: unknown;
  audit_target_type: unknown;
  audit_target_id: unknown;
  audit_decision: unknown;
  audit_policy_version: unknown;
  audit_correlation_id: unknown;
  audit_occurred_at: unknown;
  audit_result: unknown;
}

const safeIdentifier = /^[A-Za-z0-9_.:-]{1,128}$/u;
const digestPattern = /^[a-f0-9]{64}$/u;
const freezePattern = /^freeze_[a-f0-9]{32}$/u;

function invalid(code: string): never {
  throw new ContractError(code);
}

function changes(result: D1RunResult | undefined): number {
  if (!result?.success) throw new Error("maintenance_d1_write_failed");
  return Number(result.meta.changes ?? 0);
}

function canonicalIso(seconds: number): string {
  const value = new Date(seconds * 1_000);
  if (!Number.isFinite(value.getTime())) {
    invalid("maintenance_timestamp_invalid");
  }
  return value.toISOString();
}

function persistedRequest(row: PersistedMaintenanceRow): MaintenanceRequest {
  try {
    return parseMaintenanceRequest({
      schema: "maintenance-request-v1",
      event: "maintenance.requested",
      requestId: row.request_id,
      siteId: row.site_id,
      environment: row.environment,
      requestedBy: row.requested_by,
      reasonCode: row.reason_code,
      requestedAt: row.requested_at,
      expiresAt: row.expires_at,
    });
  } catch {
    throw new Error("maintenance_persisted_state_corrupt");
  }
}

const selectPersisted = `
  SELECT
    request.request_id,
    request.request_digest,
    request.site_id,
    request.environment,
    request.requested_by,
    request.reason_code,
    request.requested_at,
    request.expires_at,
    request.credential_id,
    request.status,
    request.recorded_at,
    link.freeze_id,
    freeze.site_id AS freeze_site_id,
    freeze.environment AS freeze_environment,
    freeze.reason_code AS freeze_reason_code,
    freeze.correlation_id,
    freeze.activated_at,
    freeze.expires_at AS freeze_expires_at,
    freeze.released_at,
    receipt.response_json,
    receipt.response_digest,
    receipt.recorded_at AS receipt_recorded_at,
    audit.audit_id,
    audit.actor_type AS audit_actor_type,
    audit.actor_id AS audit_actor_id,
    audit.action AS audit_action,
    audit.target_type AS audit_target_type,
    audit.target_id AS audit_target_id,
    audit.decision AS audit_decision,
    audit.policy_version AS audit_policy_version,
    audit.correlation_id AS audit_correlation_id,
    audit.occurred_at AS audit_occurred_at,
    audit.result AS audit_result
  FROM maintenance_requests request
  LEFT JOIN maintenance_request_freezes link
    ON link.request_id = request.request_id
  LEFT JOIN freezes freeze
    ON freeze.freeze_id = link.freeze_id
  LEFT JOIN maintenance_receipts receipt
    ON receipt.request_id = request.request_id
  LEFT JOIN audit_events audit
    ON audit.audit_id = ?2
  WHERE request.request_id = ?1
  LIMIT 1
`;

export class D1MaintenanceRequestRepository {
  readonly database: D1DatabasePort;

  constructor(database: D1DatabasePort) {
    this.database = database;
  }

  async record(
    verified: VerifiedMaintenanceRequest,
    signingSecret: string,
  ): Promise<RecordMaintenanceRequestResult> {
    const request = verified.request;
    if (
      !digestPattern.test(verified.requestDigest) ||
      !safeIdentifier.test(verified.credentialId)
    ) {
      invalid("maintenance_claim_invalid");
    }
    const recordedAt = verified.verifiedAtSeconds;
    const activatedAt = canonicalIso(recordedAt);
    const expiresAt = canonicalIso(request.expiresAt);
    const freezeId = `freeze_${verified.requestDigest.slice(0, 32)}`;
    const auditId = `audit:maintenance:${verified.requestDigest.slice(0, 32)}`;
    const candidateReceipt = await buildSignedMaintenanceReceipt(
      { requestId: request.requestId, recordedAt },
      signingSecret,
    );
    const responseJson = stableJson(candidateReceipt);
    const responseDigest = await sha256Hex(
      new TextEncoder().encode(responseJson),
    );

    let created = false;
    let writeFailure: unknown;
    try {
      const results = await this.database.batch([
        this.database
          .prepare(`
            INSERT INTO maintenance_requests (
              request_id, request_digest, site_id, environment, requested_by,
              reason_code, requested_at, expires_at, credential_id, status,
              recorded_at
            ) VALUES (
              ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'accepted', ?10
            )
          `)
          .bind(
            request.requestId,
            verified.requestDigest,
            request.siteId,
            request.environment,
            request.requestedBy,
            request.reasonCode,
            request.requestedAt,
            request.expiresAt,
            verified.credentialId,
            recordedAt,
          ),
        this.database
          .prepare(`
            INSERT INTO freezes (
              freeze_id, site_id, environment, reason_code, correlation_id,
              activated_at, expires_at, released_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL)
          `)
          .bind(
            freezeId,
            request.siteId,
            request.environment,
            request.reasonCode,
            request.requestId,
            activatedAt,
            expiresAt,
          ),
        this.database
          .prepare(`
            INSERT INTO maintenance_request_freezes (
              request_id, freeze_id
            ) VALUES (?1, ?2)
          `)
          .bind(request.requestId, freezeId),
        this.database
          .prepare(`
            INSERT INTO maintenance_receipts (
              request_id, response_json, response_digest, recorded_at
            ) VALUES (?1, ?2, ?3, ?4)
          `)
          .bind(
            request.requestId,
            responseJson,
            responseDigest,
            recordedAt,
          ),
        this.database
          .prepare(`
            INSERT INTO audit_events (
              audit_id, actor_type, actor_id, action, target_type, target_id,
              decision, policy_version, correlation_id, occurred_at, result
            ) VALUES (
              ?1, 'service', ?2, 'freeze.activated', 'freeze', ?3, 'allow',
              'maintenance-request-v1', ?4, ?5, 'accepted'
            )
          `)
          .bind(
            auditId,
            verified.credentialId,
            freezeId,
            request.requestId,
            activatedAt,
          ),
      ]);
      if (
        results.length !== 5 ||
        results.some((result) => changes(result) !== 1)
      ) {
        throw new Error("maintenance_d1_write_incomplete");
      }
      created = true;
    } catch (error) {
      writeFailure = error;
    }

    const row = await this.database
      .prepare(selectPersisted)
      .bind(request.requestId, auditId)
      .first<PersistedMaintenanceRow>();
    if (!row) {
      throw writeFailure instanceof Error
        ? writeFailure
        : new Error("maintenance_write_incomplete");
    }
    if (
      typeof row.request_digest !== "string" ||
      !digestPattern.test(row.request_digest)
    ) {
      throw new Error("maintenance_persisted_state_corrupt");
    }
    if (row.request_digest !== verified.requestDigest) {
      invalid("maintenance_idempotency_conflict");
    }
    if (stableJson(persistedRequest(row)) !== stableJson(request)) {
      throw new Error("maintenance_persisted_state_corrupt");
    }
    if (
      typeof row.credential_id !== "string" ||
      !safeIdentifier.test(row.credential_id) ||
      row.credential_id !== verified.credentialId ||
      row.status !== "accepted" ||
      !Number.isSafeInteger(row.recorded_at) ||
      !freezePattern.test(String(row.freeze_id)) ||
      row.freeze_id !== freezeId ||
      row.freeze_site_id !== request.siteId ||
      row.freeze_environment !== request.environment ||
      row.freeze_reason_code !== request.reasonCode ||
      row.correlation_id !== request.requestId ||
      row.activated_at !== canonicalIso(row.recorded_at as number) ||
      row.freeze_expires_at !== expiresAt ||
      row.released_at !== null ||
      typeof row.response_json !== "string" ||
      typeof row.response_digest !== "string" ||
      !digestPattern.test(row.response_digest) ||
      row.receipt_recorded_at !== row.recorded_at ||
      row.audit_id !== auditId ||
      row.audit_actor_type !== "service" ||
      row.audit_actor_id !== verified.credentialId ||
      row.audit_action !== "freeze.activated" ||
      row.audit_target_type !== "freeze" ||
      row.audit_target_id !== freezeId ||
      row.audit_decision !== "allow" ||
      row.audit_policy_version !== "maintenance-request-v1" ||
      row.audit_correlation_id !== request.requestId ||
      row.audit_occurred_at !== activatedAt ||
      row.audit_result !== "accepted"
    ) {
      throw new Error("maintenance_persisted_state_corrupt");
    }
    const actualDigest = await sha256Hex(
      new TextEncoder().encode(row.response_json),
    );
    if (actualDigest !== row.response_digest) {
      throw new Error("maintenance_receipt_corrupt");
    }
    let receipt: SignedMaintenanceReceipt;
    try {
      receipt = parseMaintenanceReceipt(JSON.parse(row.response_json));
    } catch {
      throw new Error("maintenance_receipt_corrupt");
    }
    if (
      receipt.requestId !== request.requestId ||
      receipt.recordedAt !== row.recorded_at ||
      !(await verifyMaintenanceReceipt(receipt, signingSecret))
    ) {
      throw new Error("maintenance_receipt_corrupt");
    }
    return {
      status: created ? "accepted" : "duplicate",
      receipt,
    };
  }
}
