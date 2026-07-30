import {
  index,
  integer,
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
  ],
);

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
