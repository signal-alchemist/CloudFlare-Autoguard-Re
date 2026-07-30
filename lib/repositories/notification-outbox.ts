import {
  ContractError,
  type Environment,
} from "../contracts/ops-signal.ts";
import type { SafeNotificationEnvelope } from "../security/safe-output.ts";
import type {
  D1DatabasePort,
  D1RunResult,
} from "./observations.ts";

export const NOTIFICATION_DISPATCH_LIMIT = 10;
export const NOTIFICATION_OUTBOX_PAYLOAD_INVALID =
  "notification_outbox_payload_invalid";

export interface NotificationOutboxScope {
  siteId: string;
  environment: Environment;
}

export interface PendingNotificationOutboxEntry {
  outboxId: string;
  incidentId: string;
  observationId: string;
  notificationKind: "incident_opened";
  status: "pending";
  payloadJson: string;
  payloadDigest: string;
  createdAt: string;
  updatedAt: string;
  enqueuedAt: string | null;
  lastErrorCode: string | null;
  integrity: "valid" | "corrupt";
}

export interface NotificationOutboxAuthorization {
  envelope: SafeNotificationEnvelope;
  payloadJson: string;
  payloadDigest: string;
}

export interface NotificationOutboxRepository {
  readonly scope: NotificationOutboxScope;
  listPending(
    limit: number,
  ): Promise<readonly PendingNotificationOutboxEntry[]>;
  markEnqueued(
    entry: PendingNotificationOutboxEntry,
    enqueuedAt: string,
  ): Promise<void>;
  markBlocked(
    entry: PendingNotificationOutboxEntry,
    errorCode: typeof NOTIFICATION_OUTBOX_PAYLOAD_INVALID,
    updatedAt: string,
  ): Promise<void>;
  markCorruptBlocked(
    entry: PendingNotificationOutboxEntry,
    errorCode: typeof NOTIFICATION_OUTBOX_PAYLOAD_INVALID,
    updatedAt: string,
  ): Promise<void>;
  authorizeDelivery(
    input: NotificationOutboxAuthorization,
  ): Promise<boolean>;
}

interface NotificationOutboxRow {
  outbox_id: string;
  incident_id: string;
  observation_id: string;
  notification_kind: string;
  status: string;
  payload_json: string;
  payload_digest: string;
  created_at: string;
  updated_at: string;
  enqueued_at: string | null;
  last_error_code: string | null;
}

function invalid(code: string): never {
  throw new ContractError(code);
}

function validateScope(
  scope: NotificationOutboxScope,
): NotificationOutboxScope {
  if (
    !/^[a-z][a-z0-9-]{2,63}$/u.test(scope.siteId) ||
    (scope.environment !== "staging" &&
      scope.environment !== "production")
  ) {
    invalid("notification_outbox_scope_invalid");
  }
  return { ...scope };
}

function canonicalIso(value: string, code: string): string {
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  ) {
    invalid(code);
  }
  return value;
}

function fromRow(
  row: NotificationOutboxRow,
): PendingNotificationOutboxEntry {
  let timestampsCanonical = true;
  try {
    canonicalIso(row.created_at, "notification_outbox_row_invalid");
    canonicalIso(row.updated_at, "notification_outbox_row_invalid");
  } catch {
    timestampsCanonical = false;
  }
  const rowValid =
    timestampsCanonical &&
    /^inc_[a-f0-9]{32}$/u.test(row.incident_id) &&
    /^obs_[a-f0-9]{32}$/u.test(row.observation_id) &&
    row.outbox_id ===
      `outbox:${row.incident_id}:incident_opened` &&
    row.notification_kind === "incident_opened" &&
    row.status === "pending" &&
    typeof row.payload_json === "string" &&
    row.payload_json.length >= 2 &&
    row.payload_json.length <= 64 * 1_024 &&
    /^[a-f0-9]{64}$/u.test(row.payload_digest) &&
    row.created_at === row.updated_at &&
    row.enqueued_at === null &&
    row.last_error_code === null;
  return {
    outboxId: row.outbox_id,
    incidentId: row.incident_id,
    observationId: row.observation_id,
    notificationKind: "incident_opened",
    status: "pending",
    payloadJson: row.payload_json,
    payloadDigest: row.payload_digest,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    enqueuedAt: row.enqueued_at,
    lastErrorCode: row.last_error_code,
    integrity: rowValid ? "valid" : "corrupt",
  };
}

function changes(result: D1RunResult): number {
  if (!result.success) throw new Error("d1_write_failed");
  return Number(result.meta.changes ?? 0);
}

export class D1NotificationOutboxRepository
  implements NotificationOutboxRepository
{
  readonly database: D1DatabasePort;
  readonly scope: NotificationOutboxScope;

  constructor(
    database: D1DatabasePort,
    scope: NotificationOutboxScope,
  ) {
    this.database = database;
    this.scope = validateScope(scope);
  }

  async listPending(
    limit: number,
  ): Promise<readonly PendingNotificationOutboxEntry[]> {
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > NOTIFICATION_DISPATCH_LIMIT
    ) {
      invalid("notification_outbox_limit_invalid");
    }
    const entries: PendingNotificationOutboxEntry[] = [];
    for (let offset = 0; offset < limit; offset += 1) {
      const row = await this.database
        .prepare(
          `
            SELECT n.outbox_id, n.incident_id, n.observation_id,
              n.notification_kind, n.status, n.payload_json,
              n.payload_digest, n.created_at, n.updated_at,
              n.enqueued_at, n.last_error_code
            FROM notification_outbox n
            INNER JOIN incidents i ON i.incident_id = n.incident_id
            WHERE n.status = 'pending'
              AND i.site_id = ?1
              AND i.environment = ?2
            ORDER BY n.created_at, n.outbox_id
            LIMIT 1 OFFSET ?3
          `,
        )
        .bind(this.scope.siteId, this.scope.environment, offset)
        .first<NotificationOutboxRow>();
      if (!row) break;
      entries.push(fromRow(row));
    }
    return entries;
  }

  async markEnqueued(
    entry: PendingNotificationOutboxEntry,
    enqueuedAt: string,
  ): Promise<void> {
    if (entry.integrity !== "valid") {
      invalid("notification_outbox_enqueue_transition_invalid");
    }
    const timestamp = canonicalIso(
      enqueuedAt,
      "notification_outbox_enqueued_at_invalid",
    );
    if (
      entry.updatedAt !== entry.createdAt ||
      Date.parse(timestamp) < Date.parse(entry.createdAt)
    ) {
      invalid("notification_outbox_enqueue_transition_invalid");
    }
    const result = await this.database
      .prepare(
        `
          UPDATE notification_outbox
          SET status = 'enqueued', updated_at = ?1, enqueued_at = ?1,
            last_error_code = NULL
          WHERE outbox_id = ?2
            AND incident_id = ?3
            AND observation_id = ?4
            AND notification_kind = 'incident_opened'
            AND status = 'pending'
            AND payload_json = ?5
            AND payload_digest = ?6
            AND created_at = ?7
            AND updated_at = ?8
            AND enqueued_at IS NULL
            AND last_error_code IS NULL
            AND EXISTS (
              SELECT 1
              FROM incidents i
              WHERE i.incident_id = notification_outbox.incident_id
                AND i.site_id = ?9
                AND i.environment = ?10
            )
        `,
      )
      .bind(
        timestamp,
        entry.outboxId,
        entry.incidentId,
        entry.observationId,
        entry.payloadJson,
        entry.payloadDigest,
        entry.createdAt,
        entry.updatedAt,
        this.scope.siteId,
        this.scope.environment,
      )
      .run();
    if (changes(result) !== 1) {
      const existing = await this.database
        .prepare(
          `
            SELECT n.enqueued_at, n.updated_at
            FROM notification_outbox n
            INNER JOIN incidents i ON i.incident_id = n.incident_id
            WHERE n.outbox_id = ?1
              AND n.incident_id = ?2
              AND n.observation_id = ?3
              AND n.notification_kind = 'incident_opened'
              AND n.status = 'enqueued'
              AND n.payload_json = ?4
              AND n.payload_digest = ?5
              AND n.created_at = ?6
              AND n.last_error_code IS NULL
              AND n.enqueued_at IS NOT NULL
              AND n.updated_at = n.enqueued_at
              AND i.site_id = ?7
              AND i.environment = ?8
            LIMIT 1
          `,
        )
        .bind(
          entry.outboxId,
          entry.incidentId,
          entry.observationId,
          entry.payloadJson,
          entry.payloadDigest,
          entry.createdAt,
          this.scope.siteId,
          this.scope.environment,
        )
        .first<{ enqueued_at: string; updated_at: string }>();
      if (
        !existing ||
        canonicalIso(
          existing.enqueued_at,
          "notification_outbox_enqueue_conflict",
        ) !== existing.updated_at ||
        Date.parse(existing.enqueued_at) < Date.parse(entry.createdAt)
      ) {
        throw new Error("notification_outbox_enqueue_conflict");
      }
    }
  }

  async markBlocked(
    entry: PendingNotificationOutboxEntry,
    errorCode: typeof NOTIFICATION_OUTBOX_PAYLOAD_INVALID,
    updatedAt: string,
  ): Promise<void> {
    if (entry.integrity !== "valid") {
      invalid("notification_outbox_block_transition_invalid");
    }
    if (errorCode !== NOTIFICATION_OUTBOX_PAYLOAD_INVALID) {
      invalid("notification_outbox_error_code_invalid");
    }
    const timestamp = canonicalIso(
      updatedAt,
      "notification_outbox_blocked_at_invalid",
    );
    if (
      entry.updatedAt !== entry.createdAt ||
      Date.parse(timestamp) < Date.parse(entry.createdAt)
    ) {
      invalid("notification_outbox_block_transition_invalid");
    }
    const result = await this.database
      .prepare(
        `
          UPDATE notification_outbox
          SET status = 'blocked', updated_at = ?1, enqueued_at = NULL,
            last_error_code = ?2
          WHERE outbox_id = ?3
            AND incident_id = ?4
            AND observation_id = ?5
            AND notification_kind = 'incident_opened'
            AND status = 'pending'
            AND payload_json = ?6
            AND payload_digest = ?7
            AND created_at = ?8
            AND updated_at = ?9
            AND enqueued_at IS NULL
            AND last_error_code IS NULL
            AND EXISTS (
              SELECT 1
              FROM incidents i
              WHERE i.incident_id = notification_outbox.incident_id
                AND i.site_id = ?10
                AND i.environment = ?11
            )
        `,
      )
      .bind(
        timestamp,
        errorCode,
        entry.outboxId,
        entry.incidentId,
        entry.observationId,
        entry.payloadJson,
        entry.payloadDigest,
        entry.createdAt,
        entry.updatedAt,
        this.scope.siteId,
        this.scope.environment,
      )
      .run();
    if (changes(result) !== 1) {
      const existing = await this.database
        .prepare(
          `
            SELECT n.updated_at
            FROM notification_outbox n
            INNER JOIN incidents i ON i.incident_id = n.incident_id
            WHERE n.outbox_id = ?1
              AND n.incident_id = ?2
              AND n.observation_id = ?3
              AND n.notification_kind = 'incident_opened'
              AND n.status = 'blocked'
              AND n.payload_json = ?4
              AND n.payload_digest = ?5
              AND n.created_at = ?6
              AND n.enqueued_at IS NULL
              AND n.last_error_code = ?7
              AND i.site_id = ?8
              AND i.environment = ?9
            LIMIT 1
          `,
        )
        .bind(
          entry.outboxId,
          entry.incidentId,
          entry.observationId,
          entry.payloadJson,
          entry.payloadDigest,
          entry.createdAt,
          errorCode,
          this.scope.siteId,
          this.scope.environment,
        )
        .first<{ updated_at: string }>();
      if (
        !existing ||
        Date.parse(
          canonicalIso(
            existing.updated_at,
            "notification_outbox_block_conflict",
          ),
        ) < Date.parse(entry.createdAt)
      ) {
        throw new Error("notification_outbox_block_conflict");
      }
    }
  }

  async markCorruptBlocked(
    entry: PendingNotificationOutboxEntry,
    errorCode: typeof NOTIFICATION_OUTBOX_PAYLOAD_INVALID,
    updatedAt: string,
  ): Promise<void> {
    if (
      entry.integrity !== "corrupt" ||
      errorCode !== NOTIFICATION_OUTBOX_PAYLOAD_INVALID
    ) {
      invalid("notification_outbox_corrupt_transition_invalid");
    }
    const timestamp = canonicalIso(
      updatedAt,
      "notification_outbox_blocked_at_invalid",
    );
    const result = await this.database
      .prepare(
        `
          UPDATE notification_outbox
          SET status = 'blocked', updated_at = ?1, enqueued_at = NULL,
            last_error_code = ?2
          WHERE outbox_id = ?3
            AND incident_id = ?4
            AND observation_id = ?5
            AND notification_kind = 'incident_opened'
            AND status = 'pending'
            AND payload_json = ?6
            AND payload_digest = ?7
            AND created_at = ?8
            AND updated_at = ?9
            AND enqueued_at IS ?10
            AND last_error_code IS ?11
            AND EXISTS (
              SELECT 1
              FROM incidents i
              WHERE i.incident_id = notification_outbox.incident_id
                AND i.site_id = ?12
                AND i.environment = ?13
            )
        `,
      )
      .bind(
        timestamp,
        errorCode,
        entry.outboxId,
        entry.incidentId,
        entry.observationId,
        entry.payloadJson,
        entry.payloadDigest,
        entry.createdAt,
        entry.updatedAt,
        entry.enqueuedAt,
        entry.lastErrorCode,
        this.scope.siteId,
        this.scope.environment,
      )
      .run();
    if (changes(result) !== 1) {
      const existing = await this.database
        .prepare(
          `
            SELECT n.updated_at
            FROM notification_outbox n
            INNER JOIN incidents i ON i.incident_id = n.incident_id
            WHERE n.outbox_id = ?1
              AND n.incident_id = ?2
              AND n.observation_id = ?3
              AND n.notification_kind = 'incident_opened'
              AND n.status = 'blocked'
              AND n.payload_json = ?4
              AND n.payload_digest = ?5
              AND n.created_at = ?6
              AND n.enqueued_at IS NULL
              AND n.last_error_code = ?7
              AND i.site_id = ?8
              AND i.environment = ?9
            LIMIT 1
          `,
        )
        .bind(
          entry.outboxId,
          entry.incidentId,
          entry.observationId,
          entry.payloadJson,
          entry.payloadDigest,
          entry.createdAt,
          errorCode,
          this.scope.siteId,
          this.scope.environment,
        )
        .first<{ updated_at: string }>();
      if (!existing) {
        throw new Error("notification_outbox_corrupt_block_conflict");
      }
      canonicalIso(
        existing.updated_at,
        "notification_outbox_corrupt_block_conflict",
      );
    }
  }

  async authorizeDelivery(
    input: NotificationOutboxAuthorization,
  ): Promise<boolean> {
    const { envelope } = input;
    if (
      envelope.siteId !== this.scope.siteId ||
      envelope.environment !== this.scope.environment ||
      envelope.state !== "open" ||
      !/^inc_[a-f0-9]{32}$/u.test(envelope.incidentId) ||
      !/^[a-f0-9]{64}$/u.test(input.payloadDigest) ||
      typeof input.payloadJson !== "string" ||
      input.payloadJson.length < 2 ||
      input.payloadJson.length > 64 * 1_024
    ) {
      return false;
    }
    const row = await this.database
      .prepare(
        `
          SELECT n.outbox_id
          FROM notification_outbox n
          INNER JOIN incidents i ON i.incident_id = n.incident_id
          INNER JOIN observations o
            ON o.observation_id = n.observation_id
          WHERE n.outbox_id = ?1
            AND n.incident_id = ?2
            AND n.notification_kind = 'incident_opened'
            AND n.payload_json = ?3
            AND n.payload_digest = ?4
            AND n.created_at = o.created_at
            AND (
              (
                n.status = 'pending'
                AND n.updated_at = n.created_at
                AND n.enqueued_at IS NULL
                AND n.last_error_code IS NULL
              )
              OR (
                n.status = 'enqueued'
                AND n.updated_at = n.enqueued_at
                AND n.enqueued_at IS NOT NULL
                AND n.last_error_code IS NULL
              )
            )
            AND i.site_id = ?5
            AND i.environment = ?6
            AND i.component = ?7
            AND i.reason_code = ?8
            AND i.scope = ?9
            AND i.severity = ?10
            AND i.opened_at = ?11
            AND o.site_id = i.site_id
            AND o.environment = i.environment
            AND o.component = i.component
            AND o.reason_code = i.reason_code
            AND o.scope = i.scope
            AND o.status = 'fail'
            AND o.evidence_id = ?12
            AND o.observed_at = ?11
            AND o.correlation_id = ?13
          LIMIT 1
        `,
      )
      .bind(
        `outbox:${envelope.incidentId}:incident_opened`,
        envelope.incidentId,
        input.payloadJson,
        input.payloadDigest,
        this.scope.siteId,
        this.scope.environment,
        envelope.component,
        envelope.reasonCode,
        envelope.scope,
        envelope.severity,
        envelope.observedAt,
        envelope.evidenceId,
        envelope.correlationId,
      )
      .first<{ outbox_id: string }>();
    return row !== null;
  }
}
