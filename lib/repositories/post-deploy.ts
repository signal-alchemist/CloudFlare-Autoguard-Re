import {
  ContractError,
  stableJson,
} from "../contracts/ops-signal.ts";
import {
  parsePostDeployVerdict,
  type PostDeployRequest,
  type SignedPostDeployVerdict,
  type VerifiedPostDeployRequest,
} from "../contracts/post-deploy.ts";
import { sha256Hex } from "../security/safe-output.ts";
import type {
  D1DatabasePort,
  D1RunResult,
} from "./observations.ts";

export type PostDeployOutcome = "pass" | "fail" | "unknown";
export type PostDeployRequestState = "claimed" | PostDeployOutcome;

export interface PostDeployClaim {
  status: "created" | "existing";
  state: PostDeployRequestState;
  reasonCode: string | null;
  receipt: SignedPostDeployVerdict | null;
}

export interface CompletePostDeployInput {
  requestId: string;
  outcome: PostDeployOutcome;
  reasonCode: string;
  checkedAt: number;
  receipt: SignedPostDeployVerdict | null;
}

interface PostDeployRequestRow {
  request_id: string;
  request_digest: string;
  site_id: string;
  environment: PostDeployRequest["environment"];
  commit_sha: string;
  worker_version_id: string;
  evidence_digest: string;
  requested_at: number;
  status: PostDeployRequestState;
  reason_code: unknown;
}

interface PostDeployReceiptRow {
  response_json: string;
}

function invalid(code: string): never {
  throw new ContractError(code);
}

function changes(result: D1RunResult | undefined): number {
  if (!result?.success) throw new Error("d1_write_failed");
  return Number(result.meta.changes ?? 0);
}

function requestMaterial(row: PostDeployRequestRow): string {
  return stableJson({
    schema: "site-deploy-post-deploy-v1",
    event: "site_deploy.post_deploy_requested",
    requestId: row.request_id,
    siteId: row.site_id,
    environment: row.environment,
    commitSha: row.commit_sha,
    workerVersionId: row.worker_version_id,
    evidenceDigest: row.evidence_digest,
    requestedAt: row.requested_at,
  });
}

export class D1PostDeployRepository {
  readonly database: D1DatabasePort;

  constructor(database: D1DatabasePort) {
    this.database = database;
  }

  private async receipt(
    requestId: string,
  ): Promise<SignedPostDeployVerdict | null> {
    const row = await this.database
      .prepare(
        `
          SELECT response_json
          FROM post_deploy_receipts
          WHERE request_id = ?1
          LIMIT 1
        `,
      )
      .bind(requestId)
      .first<PostDeployReceiptRow>();
    if (!row) return null;
    try {
      return parsePostDeployVerdict(JSON.parse(row.response_json));
    } catch {
      throw new Error("post_deploy_receipt_corrupt");
    }
  }

  async claim(
    verified: VerifiedPostDeployRequest,
  ): Promise<PostDeployClaim> {
    const request = verified.request;
    const result = await this.database
      .prepare(
        `
          INSERT OR IGNORE INTO post_deploy_requests (
            request_id, request_digest, site_id, environment, commit_sha,
            worker_version_id, evidence_digest, requested_at, status,
            reason_code, checked_at, created_at, updated_at
          ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'claimed',
            NULL, NULL, ?9, ?9
          )
        `,
      )
      .bind(
        request.requestId,
        verified.requestDigest,
        request.siteId,
        request.environment,
        request.commitSha,
        request.workerVersionId,
        request.evidenceDigest,
        request.requestedAt,
        verified.verifiedAtSeconds,
      )
      .run();
    const row = await this.database
      .prepare(
        `
          SELECT request_id, request_digest, site_id, environment, commit_sha,
            worker_version_id, evidence_digest, requested_at, status,
            reason_code
          FROM post_deploy_requests
          WHERE request_id = ?1
          LIMIT 1
        `,
      )
      .bind(request.requestId)
      .first<PostDeployRequestRow>();
    if (!row) throw new Error("post_deploy_claim_incomplete");
    if (
      row.request_digest !== verified.requestDigest ||
      requestMaterial(row) !== stableJson(request)
    ) {
      invalid("post_deploy_idempotency_conflict");
    }
    const reasonCode = row.reason_code;
    if (
      (row.status === "claimed" && reasonCode !== null) ||
      (row.status !== "claimed" &&
        (typeof reasonCode !== "string" ||
          !/^[A-Za-z0-9_.:-]{1,128}$/u.test(reasonCode)))
    ) {
      throw new Error("post_deploy_claim_corrupt");
    }
    return {
      status: changes(result) === 1 ? "created" : "existing",
      state: row.status,
      reasonCode: reasonCode as string | null,
      receipt: await this.receipt(request.requestId),
    };
  }

  async complete(input: CompletePostDeployInput): Promise<void> {
    if (
      !/^site-deploy-[0-9]{1,32}-[0-9]{1,8}$/u.test(input.requestId) ||
      !/^[A-Za-z0-9_.:-]{1,128}$/u.test(input.reasonCode) ||
      !Number.isSafeInteger(input.checkedAt)
    ) {
      invalid("post_deploy_completion_invalid");
    }
    if (
      (input.outcome === "pass") !== (input.receipt !== null)
    ) {
      invalid("post_deploy_receipt_outcome_mismatch");
    }
    const statements = [
      this.database
        .prepare(
          `
            UPDATE post_deploy_requests
            SET status = ?1, reason_code = ?2, checked_at = ?3,
              updated_at = ?3
            WHERE request_id = ?4 AND status = 'claimed'
          `,
        )
        .bind(
          input.outcome,
          input.reasonCode,
          input.checkedAt,
          input.requestId,
        ),
    ];
    if (input.receipt) {
      const responseJson = stableJson(input.receipt);
      const responseDigest = await sha256Hex(
        new TextEncoder().encode(responseJson),
      );
      statements.push(
        this.database
          .prepare(
            `
              INSERT OR IGNORE INTO post_deploy_receipts (
                request_id, response_json, response_digest, recorded_at
              )
              SELECT ?1, ?2, ?3, ?4
              FROM post_deploy_requests
              WHERE request_id = ?1 AND status = 'pass'
            `,
          )
          .bind(
            input.requestId,
            responseJson,
            responseDigest,
            input.checkedAt,
          ),
      );
    }
    const results = await this.database.batch(statements);
    if (changes(results[0]) !== 1) {
      invalid("post_deploy_completion_conflict");
    }
    if (input.receipt && changes(results[1]) !== 1) {
      throw new Error("post_deploy_receipt_write_incomplete");
    }
  }
}
