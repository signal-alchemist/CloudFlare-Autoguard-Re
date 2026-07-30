import {
  ContractError,
  stableJson,
  type Environment,
} from "../contracts/ops-signal.ts";
import {
  validateDeploymentRuntimeIdentity,
  type DeploymentRuntimeIdentity,
} from "../domain/deployment-runtime-identity.ts";
import type {
  D1DatabasePort,
  D1RunResult,
} from "./observations.ts";

export interface DeploymentRuntimeIdentityReader {
  readLatest(input: {
    siteId: string;
    environment: Environment;
  }): Promise<DeploymentRuntimeIdentity | null>;
}

export interface AppendDeploymentRuntimeIdentityReceipt {
  status: "accepted" | "duplicate";
  identity: DeploymentRuntimeIdentity;
}

interface DeploymentRuntimeIdentityRow {
  schema_version: unknown;
  identity_id: unknown;
  site_id: unknown;
  environment: unknown;
  commit_sha: unknown;
  worker_version_id: unknown;
  evidence_digest: unknown;
  source_observation_id: unknown;
  policy_version: unknown;
  observed_at: unknown;
  valid_until: unknown;
}

const selectedColumns = `
  schema_version, identity_id, site_id, environment, commit_sha,
  worker_version_id, evidence_digest, source_observation_id, policy_version,
  observed_at, valid_until
`;

function validScope(siteId: string, environment: Environment): boolean {
  return (
    /^[a-z][a-z0-9-]{2,63}$/u.test(siteId) &&
    (environment === "staging" || environment === "production")
  );
}

function canonicalIso(value: string): string {
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  ) {
    throw new ContractError(
      "deployment_runtime_identity_recorded_at_invalid",
    );
  }
  return value;
}

function changes(result: D1RunResult): number {
  if (!result.success) throw new Error("d1_write_failed");
  return Number(result.meta.changes ?? 0);
}

function fromRow(
  row: DeploymentRuntimeIdentityRow,
): DeploymentRuntimeIdentity {
  const identity = {
    schemaVersion: row.schema_version,
    identityId: row.identity_id,
    siteId: row.site_id,
    environment: row.environment,
    commitSha: row.commit_sha,
    workerVersionId: row.worker_version_id,
    evidenceDigest: row.evidence_digest,
    sourceObservationId: row.source_observation_id,
    policyVersion: row.policy_version,
    observedAt: row.observed_at,
    validUntil: row.valid_until,
  } as DeploymentRuntimeIdentity;
  validateDeploymentRuntimeIdentity(identity);
  return identity;
}

export class D1DeploymentRuntimeIdentityRepository
  implements DeploymentRuntimeIdentityReader
{
  readonly database: D1DatabasePort;

  constructor(database: D1DatabasePort) {
    this.database = database;
  }

  private async findById(
    identityId: string,
  ): Promise<DeploymentRuntimeIdentity | null> {
    const row = await this.database
      .prepare(
        `
          SELECT ${selectedColumns}
          FROM deployment_runtime_identities
          WHERE identity_id = ?1
          LIMIT 1
        `,
      )
      .bind(identityId)
      .first<DeploymentRuntimeIdentityRow>();
    return row ? fromRow(row) : null;
  }

  async append(
    identity: DeploymentRuntimeIdentity,
    recordedAt: string,
  ): Promise<AppendDeploymentRuntimeIdentityReceipt> {
    validateDeploymentRuntimeIdentity(identity);
    const result = await this.database
      .prepare(
        `
          INSERT OR IGNORE INTO deployment_runtime_identities (
            identity_id, schema_version, site_id, environment, commit_sha,
            worker_version_id, evidence_digest, source_observation_id,
            policy_version, observed_at, valid_until, created_at
          ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12
          )
        `,
      )
      .bind(
        identity.identityId,
        identity.schemaVersion,
        identity.siteId,
        identity.environment,
        identity.commitSha,
        identity.workerVersionId,
        identity.evidenceDigest,
        identity.sourceObservationId,
        identity.policyVersion,
        identity.observedAt,
        identity.validUntil,
        canonicalIso(recordedAt),
      )
      .run();
    const existing = await this.findById(identity.identityId);
    if (!existing) {
      throw new Error("deployment_runtime_identity_write_incomplete");
    }
    if (stableJson(existing) !== stableJson(identity)) {
      throw new ContractError(
        "deployment_runtime_identity_idempotency_conflict",
      );
    }
    return {
      status: changes(result) === 1 ? "accepted" : "duplicate",
      identity: existing,
    };
  }

  async readLatest(input: {
    siteId: string;
    environment: Environment;
  }): Promise<DeploymentRuntimeIdentity | null> {
    if (!validScope(input.siteId, input.environment)) {
      throw new ContractError(
        "deployment_runtime_identity_scope_invalid",
      );
    }
    const row = await this.database
      .prepare(
        `
          SELECT ${selectedColumns}
          FROM deployment_runtime_identities
          WHERE site_id = ?1 AND environment = ?2
          ORDER BY observed_at DESC, identity_id DESC
          LIMIT 1
        `,
      )
      .bind(input.siteId, input.environment)
      .first<DeploymentRuntimeIdentityRow>();
    return row ? fromRow(row) : null;
  }
}
