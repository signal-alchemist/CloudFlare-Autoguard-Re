import {
  ContractError,
  stableJson,
  type Observation,
} from "../contracts/ops-signal.ts";

export interface D1RunResult {
  success: boolean;
  meta: {
    changes?: number;
  };
}

export interface D1PreparedStatementPort {
  bind(...values: unknown[]): D1PreparedStatementPort;
  first<T>(): Promise<T | null>;
  run(): Promise<D1RunResult>;
}

export interface D1DatabasePort {
  prepare(sql: string): D1PreparedStatementPort;
  batch(
    statements: readonly D1PreparedStatementPort[],
  ): Promise<D1RunResult[]>;
}

export type RecordObservationStatus = "accepted" | "duplicate";

export interface RecordObservationReceipt {
  status: RecordObservationStatus;
  observation: Observation;
}

interface ObservationRow {
  observation_id: string;
  schema_version: number;
  site_id: string;
  environment: Observation["environment"];
  component: Observation["component"];
  check_id: string;
  status: Observation["status"];
  reason_code: string;
  observed_at: string;
  valid_until: string;
  source: Observation["source"];
  scope: string;
  evidence_id: string;
  correlation_id: string;
  idempotency_key: string;
}

const insertObservation = `
  INSERT OR IGNORE INTO observations (
    observation_id, schema_version, site_id, environment, component, check_id,
    status, reason_code, observed_at, valid_until, source, scope, evidence_id,
    correlation_id, idempotency_key, created_at
  ) VALUES (
    ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16
  )
`;

const insertReceipt = `
  INSERT OR IGNORE INTO signal_receipts (
    receipt_id, idempotency_key, observation_id, first_received_at
  )
  SELECT ?1, ?2, ?3, ?4
  WHERE EXISTS (
    SELECT 1 FROM observations
    WHERE idempotency_key = ?2 AND observation_id = ?3
  )
`;

const insertAudit = `
  INSERT OR IGNORE INTO audit_events (
    audit_id, actor_type, actor_id, action, target_type, target_id, decision,
    policy_version, correlation_id, occurred_at, result
  )
  SELECT ?1, 'service', 'cms-signal-ingest', 'observation.accepted',
    'observation', ?2, 'allow', 'ops-signal-v1', ?3, ?4, 'accepted'
  WHERE EXISTS (
    SELECT 1 FROM signal_receipts
    WHERE observation_id = ?2
  )
`;

const selectObservation = `
  SELECT
    observation_id, schema_version, site_id, environment, component, check_id,
    status, reason_code, observed_at, valid_until, source, scope, evidence_id,
    correlation_id, idempotency_key
  FROM observations
  WHERE idempotency_key = ?1
  LIMIT 1
`;

function iso(value: string, code: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new ContractError(code);
  return new Date(milliseconds).toISOString();
}

function fromRow(row: ObservationRow): Observation {
  return {
    schemaVersion: 1,
    observationId: row.observation_id,
    siteId: row.site_id,
    environment: row.environment,
    component: row.component,
    checkId: row.check_id,
    status: row.status,
    reasonCode: row.reason_code,
    observedAt: row.observed_at,
    validUntil: row.valid_until,
    source: row.source,
    scope: row.scope,
    evidenceId: row.evidence_id,
    correlationId: row.correlation_id,
    idempotencyKey: row.idempotency_key,
  };
}

function changes(result: D1RunResult | undefined): number {
  if (!result?.success) throw new Error("d1_write_failed");
  return Number(result.meta.changes ?? 0);
}

export class D1ObservationRepository {
  readonly database: D1DatabasePort;

  constructor(database: D1DatabasePort) {
    this.database = database;
  }

  async record(
    observation: Observation,
    receivedAt: string,
  ): Promise<RecordObservationReceipt> {
    const normalizedReceivedAt = iso(
      receivedAt,
      "observation_received_at_invalid",
    );
    const receiptId = `receipt:${observation.observationId}`;
    const auditId = `audit:${observation.observationId}`;
    const results = await this.database.batch([
      this.database.prepare(insertObservation).bind(
        observation.observationId,
        observation.schemaVersion,
        observation.siteId,
        observation.environment,
        observation.component,
        observation.checkId,
        observation.status,
        observation.reasonCode,
        observation.observedAt,
        observation.validUntil,
        observation.source,
        observation.scope,
        observation.evidenceId,
        observation.correlationId,
        observation.idempotencyKey,
        normalizedReceivedAt,
      ),
      this.database
        .prepare(insertReceipt)
        .bind(
          receiptId,
          observation.idempotencyKey,
          observation.observationId,
          normalizedReceivedAt,
        ),
      this.database
        .prepare(insertAudit)
        .bind(
          auditId,
          observation.observationId,
          observation.correlationId,
          normalizedReceivedAt,
        ),
    ]);
    const existing = await this.findByIdempotencyKey(
      observation.idempotencyKey,
    );
    if (!existing) throw new Error("observation_write_incomplete");
    if (stableJson(existing) !== stableJson(observation)) {
      throw new ContractError("observation_idempotency_conflict");
    }
    return {
      status: changes(results[0]) === 1 ? "accepted" : "duplicate",
      observation: existing,
    };
  }

  async findByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<Observation | null> {
    if (idempotencyKey.length < 16 || idempotencyKey.length > 512) {
      throw new ContractError("observation_idempotency_key_invalid");
    }
    const row = await this.database
      .prepare(selectObservation)
      .bind(idempotencyKey)
      .first<ObservationRow>();
    return row ? fromRow(row) : null;
  }
}

export class D1ReplayStore {
  readonly database: D1DatabasePort;

  constructor(database: D1DatabasePort) {
    this.database = database;
  }

  async claim(key: string, expiresAt: number): Promise<boolean> {
    if (
      key.length < 16 ||
      key.length > 512 ||
      !Number.isInteger(expiresAt) ||
      expiresAt < 1
    ) {
      throw new ContractError("replay_claim_invalid");
    }
    const result = await this.database
      .prepare(
        `
          INSERT OR IGNORE INTO replay_claims (
            replay_key, expires_at, claimed_at
          ) VALUES (?1, ?2, ?3)
        `,
      )
      .bind(key, expiresAt, Math.floor(Date.now() / 1_000))
      .run();
    return changes(result) === 1;
  }
}
