import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const observations = sqliteTable(
  "observations",
  {
    observationId: text("observation_id").primaryKey(),
    schemaVersion: integer("schema_version").notNull(),
    siteId: text("site_id").notNull(),
    environment: text("environment", {
      enum: ["staging", "production"],
    }).notNull(),
    component: text("component").notNull(),
    checkId: text("check_id").notNull(),
    status: text("status").notNull(),
    reasonCode: text("reason_code").notNull(),
    observedAt: text("observed_at").notNull(),
    validUntil: text("valid_until").notNull(),
    source: text("source").notNull(),
    scope: text("scope").notNull(),
    evidenceId: text("evidence_id").notNull(),
    correlationId: text("correlation_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("observations_idempotency_key_unique").on(
      table.idempotencyKey,
    ),
    index("observations_scope_time_idx").on(
      table.siteId,
      table.environment,
      table.component,
      table.observedAt,
    ),
    index("observations_verdict_lookup_idx").on(
      table.siteId,
      table.environment,
      table.component,
      table.checkId,
      table.source,
      table.observedAt,
      table.observationId,
    ),
    index("observations_failure_repair_idx").on(
      table.siteId,
      table.environment,
      table.status,
      table.createdAt,
      table.observationId,
    ),
  ],
);

export const componentVerdicts = sqliteTable(
  "component_verdicts",
  {
    siteId: text("site_id").notNull(),
    environment: text("environment", {
      enum: ["staging", "production"],
    }).notNull(),
    component: text("component").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    policyVersion: text("policy_version").notNull(),
    state: text("state", {
      enum: [
        "healthy",
        "degraded",
        "unhealthy",
        "unknown",
        "maintenance",
      ],
    }).notNull(),
    reasonCodesJson: text("reason_codes_json").notNull(),
    observationIdsJson: text("observation_ids_json").notNull(),
    evaluatedAt: text("evaluated_at").notNull(),
    freshUntil: text("fresh_until"),
  },
  (table) => [
    primaryKey({
      columns: [table.siteId, table.environment, table.component],
      name: "component_verdicts_scope_component_pk",
    }),
    index("component_verdicts_scope_idx").on(
      table.siteId,
      table.environment,
    ),
  ],
);

export const freezes = sqliteTable(
  "freezes",
  {
    freezeId: text("freeze_id").primaryKey(),
    siteId: text("site_id").notNull(),
    environment: text("environment", {
      enum: ["staging", "production"],
    }).notNull(),
    reasonCode: text("reason_code").notNull(),
    correlationId: text("correlation_id").notNull(),
    activatedAt: text("activated_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    releasedAt: text("released_at"),
  },
  (table) => [
    index("freezes_scope_active_idx").on(
      table.siteId,
      table.environment,
      table.releasedAt,
      table.expiresAt,
    ),
  ],
);

export const maintenanceRequests = sqliteTable(
  "maintenance_requests",
  {
    requestId: text("request_id").primaryKey(),
    requestDigest: text("request_digest").notNull(),
    siteId: text("site_id").notNull(),
    environment: text("environment", {
      enum: ["staging", "production"],
    }).notNull(),
    requestedBy: text("requested_by").notNull(),
    reasonCode: text("reason_code").notNull(),
    requestedAt: integer("requested_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    credentialId: text("credential_id").notNull(),
    status: text("status", { enum: ["accepted"] }).notNull(),
    recordedAt: integer("recorded_at").notNull(),
  },
  (table) => [
    index("maintenance_requests_scope_time_idx").on(
      table.siteId,
      table.environment,
      table.requestedAt,
    ),
  ],
);

export const maintenanceRequestFreezes = sqliteTable(
  "maintenance_request_freezes",
  {
    requestId: text("request_id")
      .primaryKey()
      .references(() => maintenanceRequests.requestId, {
        onDelete: "restrict",
        onUpdate: "restrict",
      }),
    freezeId: text("freeze_id")
      .notNull()
      .unique()
      .references(() => freezes.freezeId, {
        onDelete: "restrict",
        onUpdate: "restrict",
      }),
  },
);

export const maintenanceReceipts = sqliteTable("maintenance_receipts", {
  requestId: text("request_id")
    .primaryKey()
    .references(() => maintenanceRequests.requestId, {
      onDelete: "restrict",
      onUpdate: "restrict",
    }),
  responseJson: text("response_json").notNull(),
  responseDigest: text("response_digest").notNull(),
  recordedAt: integer("recorded_at").notNull(),
});

export const signalReceipts = sqliteTable("signal_receipts", {
  receiptId: text("receipt_id").primaryKey(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  observationId: text("observation_id")
    .notNull()
    .references(() => observations.observationId, {
      onDelete: "restrict",
      onUpdate: "restrict",
    }),
  firstReceivedAt: text("first_received_at").notNull(),
});

export const auditEvents = sqliteTable(
  "audit_events",
  {
    auditId: text("audit_id").primaryKey(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    decision: text("decision").notNull(),
    policyVersion: text("policy_version").notNull(),
    correlationId: text("correlation_id").notNull(),
    occurredAt: text("occurred_at").notNull(),
    result: text("result").notNull(),
  },
  (table) => [
    index("audit_events_target_time_idx").on(
      table.targetType,
      table.targetId,
      table.occurredAt,
    ),
  ],
);

export const replayClaims = sqliteTable("replay_claims", {
  replayKey: text("replay_key").primaryKey(),
  expiresAt: integer("expires_at").notNull(),
  claimedAt: integer("claimed_at")
    .notNull()
    .$defaultFn(() => Math.floor(Date.now() / 1_000)),
});

export const incidents = sqliteTable(
  "incidents",
  {
    incidentId: text("incident_id").primaryKey(),
    fingerprint: text("fingerprint").notNull(),
    siteId: text("site_id").notNull(),
    environment: text("environment", {
      enum: ["staging", "production"],
    }).notNull(),
    component: text("component").notNull(),
    reasonCode: text("reason_code").notNull(),
    scope: text("scope").notNull(),
    severity: text("severity", {
      enum: ["sev1", "sev2", "sev3", "sev4"],
    }).notNull(),
    state: text("state", {
      enum: [
        "open",
        "acknowledged",
        "mitigating",
        "monitoring",
        "resolved",
        "manual_required",
      ],
    }).notNull(),
    openedAt: text("opened_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("incidents_fingerprint_unique").on(table.fingerprint),
    index("incidents_scope_state_idx").on(
      table.siteId,
      table.environment,
      table.state,
    ),
  ],
);

export const incidentTimeline = sqliteTable(
  "incident_timeline",
  {
    eventId: text("event_id").primaryKey(),
    incidentId: text("incident_id")
      .notNull()
      .references(() => incidents.incidentId, {
        onDelete: "restrict",
        onUpdate: "restrict",
      }),
    eventType: text("event_type", {
      enum: ["observation_recorded", "state_transition"],
    }).notNull(),
    observationId: text("observation_id"),
    fromState: text("from_state"),
    toState: text("to_state"),
    correlationId: text("correlation_id").notNull(),
    occurredAt: text("occurred_at").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
  },
  (table) => [
    uniqueIndex("incident_timeline_idempotency_unique").on(
      table.incidentId,
      table.idempotencyKey,
    ),
    index("incident_timeline_incident_time_idx").on(
      table.incidentId,
      table.occurredAt,
    ),
  ],
);

export const notificationOutbox = sqliteTable(
  "notification_outbox",
  {
    outboxId: text("outbox_id").primaryKey(),
    incidentId: text("incident_id")
      .notNull()
      .references(() => incidents.incidentId, {
        onDelete: "restrict",
        onUpdate: "restrict",
      }),
    observationId: text("observation_id")
      .notNull()
      .references(() => observations.observationId, {
        onDelete: "restrict",
        onUpdate: "restrict",
      }),
    notificationKind: text("notification_kind", {
      enum: ["incident_opened"],
    }).notNull(),
    status: text("status", {
      enum: ["pending", "enqueued", "blocked"],
    }).notNull(),
    payloadJson: text("payload_json").notNull(),
    payloadDigest: text("payload_digest").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    enqueuedAt: text("enqueued_at"),
    lastErrorCode: text("last_error_code"),
  },
  (table) => [
    uniqueIndex("notification_outbox_incident_kind_unique").on(
      table.incidentId,
      table.notificationKind,
    ),
    index("notification_outbox_pending_scan_idx").on(
      table.status,
      table.createdAt,
      table.outboxId,
    ),
    check(
      "notification_outbox_kind_check",
      sql`${table.notificationKind} IN ('incident_opened')`,
    ),
    check(
      "notification_outbox_status_check",
      sql`${table.status} IN ('pending', 'enqueued', 'blocked')`,
    ),
  ],
);

export const notificationDeliveries = sqliteTable(
  "notification_deliveries",
  {
    deliveryKey: text("delivery_key").primaryKey(),
    incidentId: text("incident_id")
      .notNull()
      .references(() => incidents.incidentId, {
        onDelete: "restrict",
        onUpdate: "restrict",
      }),
    payloadDigest: text("payload_digest").notNull(),
    providerCode: text("provider_code").notNull(),
    deliveredAt: text("delivered_at").notNull(),
    correlationId: text("correlation_id").notNull(),
  },
  (table) => [
    index("notification_deliveries_incident_time_idx").on(
      table.incidentId,
      table.deliveredAt,
    ),
  ],
);

export const deploymentRuntimeIdentities = sqliteTable(
  "deployment_runtime_identities",
  {
    identityId: text("identity_id").primaryKey(),
    schemaVersion: integer("schema_version").notNull(),
    siteId: text("site_id").notNull(),
    environment: text("environment", {
      enum: ["staging", "production"],
    }).notNull(),
    commitSha: text("commit_sha").notNull(),
    workerVersionId: text("worker_version_id").notNull(),
    evidenceDigest: text("evidence_digest").notNull(),
    sourceObservationId: text("source_observation_id")
      .notNull()
      .references(() => observations.observationId, {
        onDelete: "restrict",
        onUpdate: "restrict",
      }),
    policyVersion: text("policy_version").notNull(),
    observedAt: text("observed_at").notNull(),
    validUntil: text("valid_until").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("deployment_runtime_identity_scope_time_unique").on(
      table.siteId,
      table.environment,
      table.observedAt,
    ),
    index("deployment_runtime_identity_scope_latest_idx").on(
      table.siteId,
      table.environment,
      table.observedAt,
      table.identityId,
    ),
  ],
);

export const postDeployRequests = sqliteTable(
  "post_deploy_requests",
  {
    requestId: text("request_id").primaryKey(),
    requestDigest: text("request_digest").notNull(),
    siteId: text("site_id").notNull(),
    environment: text("environment", {
      enum: ["staging", "production"],
    }).notNull(),
    commitSha: text("commit_sha").notNull(),
    workerVersionId: text("worker_version_id").notNull(),
    evidenceDigest: text("evidence_digest").notNull(),
    requestedAt: integer("requested_at").notNull(),
    status: text("status", {
      enum: ["claimed", "pass", "fail", "unknown"],
    }).notNull(),
    reasonCode: text("reason_code"),
    checkedAt: integer("checked_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("post_deploy_requests_digest_unique").on(
      table.requestDigest,
    ),
    index("post_deploy_requests_scope_time_idx").on(
      table.siteId,
      table.environment,
      table.requestedAt,
    ),
  ],
);

export const postDeployReceipts = sqliteTable("post_deploy_receipts", {
  requestId: text("request_id")
    .primaryKey()
    .references(() => postDeployRequests.requestId, {
      onDelete: "restrict",
      onUpdate: "restrict",
    }),
  responseJson: text("response_json").notNull(),
  responseDigest: text("response_digest").notNull(),
  recordedAt: integer("recorded_at").notNull(),
});
