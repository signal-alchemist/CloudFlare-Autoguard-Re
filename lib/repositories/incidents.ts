import {
  ContractError,
  stableJson,
  type Environment,
  type Observation,
  type ObservationSource,
} from "../contracts/ops-signal.ts";
import { compileNotificationDelivery } from "../contracts/notifications.ts";
import {
  incidentSeverityForFailure,
} from "../domain/incident-severity-policy.ts";
import {
  assertIncidentTransition,
  incidentFingerprint,
  validateIncidentIdentity,
  validateIncidentSeverity,
  type Incident,
  type IncidentIdentity,
  type IncidentResolutionEvidence,
  type IncidentResolutionPolicy,
  type IncidentSeverity,
  type IncidentState,
} from "../domain/incidents.ts";
import { toSafeNotification } from "../security/safe-output.ts";
import type {
  D1DatabasePort,
  D1RunResult,
} from "./observations.ts";

export interface RecordIncidentFailureInput {
  identity: IncidentIdentity;
  severity: IncidentSeverity;
  observationId: string;
  observationIdempotencyKey: string;
  correlationId: string;
  occurredAt: string;
}

export interface RecordIncidentFailureResult {
  status: "created" | "existing" | "duplicate";
  incident: Incident;
}

export interface RecordFailureAndPendingNotificationResult {
  status: "ignored" | "created" | "existing" | "duplicate";
  incident: Incident | null;
}

export const FAILURE_NOTIFICATION_REPAIR_LIMIT = 32;
export const INCIDENT_OPENED_NOTIFICATION_KIND = "incident_opened";

export interface FailureNotificationRepairScope {
  siteId: string;
  environment: Environment;
}

export interface IncidentTransitionCommand {
  incidentId: string;
  toState: IncidentState;
  idempotencyKey: string;
  correlationId: string;
  occurredAt: string;
  resolutionEvidence?: IncidentResolutionEvidence;
}

interface IncidentRow {
  incident_id: string;
  fingerprint: string;
  site_id: string;
  environment: Incident["environment"];
  component: Incident["component"];
  reason_code: string;
  scope: string;
  severity: IncidentSeverity;
  state: IncidentState;
  opened_at: string;
  updated_at: string;
}

interface TimelineRow {
  observation_id: string | null;
  from_state: IncidentState | null;
  to_state: IncidentState | null;
}

interface ObservationTimelineRow extends TimelineRow {
  event_id: string;
  event_type: string;
  correlation_id: string;
  occurred_at: string;
  idempotency_key: string;
}

interface PersistedObservationRow {
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
  created_at: string;
}

interface PersistedObservation {
  observation: Observation;
  createdAt: string;
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

const insertIncident = `
  INSERT OR IGNORE INTO incidents (
    incident_id, fingerprint, site_id, environment, component, reason_code,
    scope, severity, state, opened_at, updated_at
  ) VALUES (
    ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'open', ?9, ?9
  )
`;
const insertObservationEvent = `
  INSERT OR IGNORE INTO incident_timeline (
    event_id, incident_id, event_type, observation_id, from_state, to_state,
    correlation_id, occurred_at, idempotency_key
  )
  SELECT ?1, incident_id, 'observation_recorded', ?3, NULL, NULL, ?4, ?5, ?6
  FROM incidents
  WHERE fingerprint = ?2
`;
const insertFailureIncident = `
  INSERT INTO incidents (
    incident_id, fingerprint, site_id, environment, component, reason_code,
    scope, severity, state, opened_at, updated_at
  ) VALUES (
    ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'open', ?9, ?9
  )
  ON CONFLICT(fingerprint) DO NOTHING
`;
const insertFailureObservationEvent = `
  INSERT INTO incident_timeline (
    event_id, incident_id, event_type, observation_id, from_state, to_state,
    correlation_id, occurred_at, idempotency_key
  )
  SELECT ?1, incident_id, 'observation_recorded', ?3, NULL, NULL, ?4, ?5, ?6
  FROM incidents
  WHERE fingerprint = ?2
    AND site_id = ?7
    AND environment = ?8
    AND component = ?9
    AND reason_code = ?10
    AND scope = ?11
    AND severity = ?12
  ON CONFLICT(incident_id, idempotency_key) DO NOTHING
`;
const insertPendingNotification = `
  INSERT INTO notification_outbox (
    outbox_id, incident_id, observation_id, notification_kind, status,
    payload_json, payload_digest, created_at, updated_at, enqueued_at,
    last_error_code
  )
  SELECT ?1, incidents.incident_id, observations.observation_id,
    'incident_opened', ?7, ?4, ?5, observations.created_at,
    observations.created_at, NULL, ?8
  FROM incidents
  INNER JOIN observations ON observations.observation_id = ?3
  WHERE incidents.fingerprint = ?2
    AND observations.idempotency_key = ?6
    AND incidents.site_id = observations.site_id
    AND incidents.environment = observations.environment
    AND incidents.component = observations.component
    AND incidents.reason_code = observations.reason_code
    AND incidents.scope = observations.scope
  ON CONFLICT(incident_id, notification_kind) DO NOTHING
`;
const selectIncident = `
  SELECT incident_id, fingerprint, site_id, environment, component,
    reason_code, scope, severity, state, opened_at, updated_at
  FROM incidents
`;

function invalid(code: string): never {
  throw new ContractError(code);
}

function iso(value: string, code: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) invalid(code);
  return new Date(milliseconds).toISOString();
}

function identifier(
  value: string,
  code: string,
  maximum = 180,
): string {
  if (
    value.length < 1 ||
    value.length > maximum ||
    !/^[A-Za-z0-9_.:-]+$/u.test(value)
  ) {
    invalid(code);
  }
  return value;
}

function fromRow(row: IncidentRow): Incident {
  return {
    incidentId: row.incident_id,
    fingerprint: row.fingerprint,
    siteId: row.site_id,
    environment: row.environment,
    component: row.component,
    reasonCode: row.reason_code,
    scope: row.scope,
    severity: row.severity,
    state: row.state,
    openedAt: row.opened_at,
    updatedAt: row.updated_at,
  };
}

function changes(result: D1RunResult | undefined): number {
  if (!result?.success) throw new Error("d1_write_failed");
  return Number(result.meta.changes ?? 0);
}

function identityMaterial(incident: Incident): string {
  return stableJson({
    siteId: incident.siteId,
    environment: incident.environment,
    component: incident.component,
    reasonCode: incident.reasonCode,
    scope: incident.scope,
  });
}

const observationSources = new Set<ObservationSource>([
  "cms_ops_signal",
  "public_probe",
  "external_probe",
  "provider_api",
  "autoguard_self",
  "post_deploy",
]);
const incidentStates = new Set<IncidentState>([
  "open",
  "acknowledged",
  "mitigating",
  "monitoring",
  "resolved",
  "manual_required",
]);
const outboxStatuses = new Set([
  "pending",
  "enqueued",
  "blocked",
]);

function canonicalIso(value: string, code: string): string {
  const normalized = iso(value, code);
  if (normalized !== value) invalid(code);
  return normalized;
}

function persistedObservationFromRow(
  row: PersistedObservationRow,
): PersistedObservation {
  const observation: Observation = {
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
  const identity: IncidentIdentity = {
    siteId: observation.siteId,
    environment: observation.environment,
    component: observation.component,
    reasonCode: observation.reasonCode,
    scope: observation.scope,
  };
  if (
    row.schema_version !== 1 ||
    !/^obs_[a-f0-9]{32}$/u.test(observation.observationId) ||
    !/^ev_[a-f0-9]{32}$/u.test(observation.evidenceId) ||
    !observationSources.has(observation.source) ||
    observation.status !== "fail" ||
    canonicalIso(
      observation.observedAt,
      "failure_observation_corrupt",
    ) !== observation.observedAt ||
    canonicalIso(
      observation.validUntil,
      "failure_observation_corrupt",
    ) !== observation.validUntil ||
    Date.parse(observation.validUntil) <=
      Date.parse(observation.observedAt)
  ) {
    invalid("failure_observation_corrupt");
  }
  validateIncidentIdentity(identity);
  identifier(
    observation.checkId,
    "failure_observation_corrupt",
    128,
  );
  identifier(
    observation.correlationId,
    "failure_observation_corrupt",
    180,
  );
  identifier(
    observation.idempotencyKey,
    "failure_observation_corrupt",
    512,
  );
  return {
    observation,
    createdAt: canonicalIso(
      row.created_at,
      "failure_observation_corrupt",
    ),
  };
}

function validateIncidentForFailure(
  incident: Incident,
  incidentId: string,
  fingerprint: string,
  identity: IncidentIdentity,
  severity: IncidentSeverity,
): void {
  if (
    incident.incidentId !== incidentId ||
    incident.fingerprint !== fingerprint ||
    identityMaterial(incident) !== stableJson(identity) ||
    incident.severity !== severity ||
    !incidentStates.has(incident.state) ||
    canonicalIso(
      incident.openedAt,
      "incident_record_corrupt",
    ) !== incident.openedAt ||
    canonicalIso(
      incident.updatedAt,
      "incident_record_corrupt",
    ) !== incident.updatedAt
  ) {
    invalid("incident_record_corrupt");
  }
}

function validateFailureTimeline(
  row: ObservationTimelineRow | null,
  incidentId: string,
  observation: Observation,
): void {
  if (
    row === null ||
    row.event_id !== `event:${observation.observationId}` ||
    row.event_type !== "observation_recorded" ||
    row.observation_id !== observation.observationId ||
    row.from_state !== null ||
    row.to_state !== null ||
    row.correlation_id !== observation.correlationId ||
    row.occurred_at !== observation.observedAt ||
    row.idempotency_key !== observation.idempotencyKey ||
    incidentId.length < 1
  ) {
    invalid("incident_timeline_corrupt");
  }
}

export class D1IncidentRepository {
  readonly database: D1DatabasePort;

  constructor(database: D1DatabasePort) {
    this.database = database;
  }

  private async persistedFailureByObservationId(
    observationId: string,
  ): Promise<PersistedObservation | null> {
    const row = await this.database
      .prepare(
        `
          SELECT observation_id, schema_version, site_id, environment,
            component, check_id, status, reason_code, observed_at,
            valid_until, source, scope, evidence_id, correlation_id,
            idempotency_key, created_at
          FROM observations
          WHERE observation_id = ?1
          LIMIT 1
        `,
      )
      .bind(observationId)
      .first<PersistedObservationRow>();
    return row ? persistedObservationFromRow(row) : null;
  }

  private async failureTimeline(
    incidentId: string,
    idempotencyKey: string,
  ): Promise<ObservationTimelineRow | null> {
    return this.database
      .prepare(
        `
          SELECT event_id, event_type, observation_id, from_state, to_state,
            correlation_id, occurred_at, idempotency_key
          FROM incident_timeline
          WHERE incident_id = ?1 AND idempotency_key = ?2
          LIMIT 1
        `,
      )
      .bind(incidentId, idempotencyKey)
      .first<ObservationTimelineRow>();
  }

  private async incidentOpenedOutbox(
    incidentId: string,
  ): Promise<NotificationOutboxRow | null> {
    return this.database
      .prepare(
        `
          SELECT outbox_id, incident_id, observation_id, notification_kind,
            status, payload_json, payload_digest, created_at, updated_at,
            enqueued_at, last_error_code
          FROM notification_outbox
          WHERE incident_id = ?1
            AND notification_kind = 'incident_opened'
          LIMIT 1
        `,
      )
      .bind(incidentId)
      .first<NotificationOutboxRow>();
  }

  private async validateIncidentOpenedOutbox(
    incident: Incident,
    row: NotificationOutboxRow,
  ): Promise<void> {
    try {
      const source = await this.persistedFailureByObservationId(
        row.observation_id,
      );
      if (!source) invalid("notification_outbox_corrupt");
      const expected = await compileNotificationDelivery(
        toSafeNotification({
          incidentId: incident.incidentId,
          siteId: incident.siteId,
          environment: incident.environment,
          component: incident.component,
          severity: incident.severity,
          state: "open",
          reasonCode: incident.reasonCode,
          scope: incident.scope,
          evidenceId: source.observation.evidenceId,
          observedAt: source.observation.observedAt,
          correlationId: source.observation.correlationId,
        }),
      );
      const createdAt = canonicalIso(
        row.created_at,
        "notification_outbox_corrupt",
      );
      const updatedAt = canonicalIso(
        row.updated_at,
        "notification_outbox_corrupt",
      );
      const enqueuedAt =
        row.enqueued_at === null
          ? null
          : canonicalIso(
              row.enqueued_at,
              "notification_outbox_corrupt",
            );
      if (
        row.outbox_id !==
          `outbox:${incident.incidentId}:incident_opened` ||
        row.incident_id !== incident.incidentId ||
        row.notification_kind !==
          INCIDENT_OPENED_NOTIFICATION_KIND ||
        row.status.length < 1 ||
        !outboxStatuses.has(row.status) ||
        row.payload_json !== expected.body ||
        row.payload_digest !== expected.payloadDigest ||
        createdAt !== source.createdAt ||
        Date.parse(updatedAt) < Date.parse(createdAt) ||
        (row.status === "pending" &&
          (updatedAt !== createdAt ||
            enqueuedAt !== null ||
            row.last_error_code !== null)) ||
        (row.status === "enqueued" &&
          (enqueuedAt === null ||
            Date.parse(enqueuedAt) < Date.parse(createdAt) ||
            row.last_error_code !== null)) ||
        (row.status === "blocked" &&
          (row.last_error_code === null ||
            !/^[A-Za-z0-9_.:-]{1,128}$/u.test(
              row.last_error_code,
            )))
      ) {
        invalid("notification_outbox_corrupt");
      }
    } catch {
      invalid("notification_outbox_corrupt");
    }
  }

  async recordFailureAndPendingNotification(
    candidate: Observation,
  ): Promise<RecordFailureAndPendingNotificationResult> {
    if (candidate.status !== "fail") {
      return { status: "ignored", incident: null };
    }
    const persisted = await this.persistedFailureByObservationId(
      candidate.observationId,
    );
    if (!persisted) invalid("failure_observation_unconfirmed");
    if (
      stableJson(persisted.observation) !== stableJson(candidate)
    ) {
      invalid("failure_observation_conflict");
    }
    const observation = persisted.observation;
    const identity: IncidentIdentity = {
      siteId: observation.siteId,
      environment: observation.environment,
      component: observation.component,
      reasonCode: observation.reasonCode,
      scope: observation.scope,
    };
    validateIncidentIdentity(identity);
    const severity = incidentSeverityForFailure(observation);
    const fingerprint = await incidentFingerprint(identity);
    const incidentId = `inc_${fingerprint.slice(0, 32)}`;
    const eventId = `event:${observation.observationId}`;
    const outboxId =
      `outbox:${incidentId}:${INCIDENT_OPENED_NOTIFICATION_KIND}`;
    const compiled = await compileNotificationDelivery(
      toSafeNotification({
        incidentId,
        ...identity,
        severity,
        state: "open",
        evidenceId: observation.evidenceId,
        observedAt: observation.observedAt,
        correlationId: observation.correlationId,
      }),
    );

    const existingIncident = await this.findByFingerprint(fingerprint);
    let existingTimeline: ObservationTimelineRow | null = null;
    let existingOutbox: NotificationOutboxRow | null = null;
    if (existingIncident) {
      validateIncidentForFailure(
        existingIncident,
        incidentId,
        fingerprint,
        identity,
        severity,
      );
      existingTimeline = await this.failureTimeline(
        incidentId,
        observation.idempotencyKey,
      );
      if (existingTimeline) {
        validateFailureTimeline(
          existingTimeline,
          incidentId,
          observation,
        );
      }
      existingOutbox =
        await this.incidentOpenedOutbox(incidentId);
      if (existingOutbox) {
        await this.validateIncidentOpenedOutbox(
          existingIncident,
          existingOutbox,
        );
      }
      if (
        existingIncident.state === "resolved" &&
        !existingTimeline
      ) {
        invalid("incident_reopen_required");
      }
      if (existingTimeline && existingOutbox) {
        return {
          status: "duplicate",
          incident: existingIncident,
        };
      }
    }

    const results = await this.database.batch([
      this.database.prepare(insertFailureIncident).bind(
        incidentId,
        fingerprint,
        identity.siteId,
        identity.environment,
        identity.component,
        identity.reasonCode,
        identity.scope,
        severity,
        observation.observedAt,
      ),
      this.database.prepare(insertFailureObservationEvent).bind(
        eventId,
        fingerprint,
        observation.observationId,
        observation.correlationId,
        observation.observedAt,
        observation.idempotencyKey,
        identity.siteId,
        identity.environment,
        identity.component,
        identity.reasonCode,
        identity.scope,
        severity,
      ),
      this.database.prepare(insertPendingNotification).bind(
        outboxId,
        fingerprint,
        observation.observationId,
        compiled.body,
        compiled.payloadDigest,
        observation.idempotencyKey,
        existingIncident?.state === "resolved"
          ? "blocked"
          : "pending",
        existingIncident?.state === "resolved"
          ? "incident_resolved_before_outbox"
          : null,
      ),
    ]);
    const incident = await this.findByFingerprint(fingerprint);
    if (!incident) throw new Error("incident_write_incomplete");
    validateIncidentForFailure(
      incident,
      incidentId,
      fingerprint,
      identity,
      severity,
    );
    const timeline = await this.failureTimeline(
      incidentId,
      observation.idempotencyKey,
    );
    validateFailureTimeline(timeline, incidentId, observation);
    const outbox = await this.incidentOpenedOutbox(incidentId);
    if (!outbox) throw new Error("notification_outbox_write_incomplete");
    await this.validateIncidentOpenedOutbox(incident, outbox);

    const incidentChanges = changes(results[0]);
    const timelineChanges = changes(results[1]);
    const outboxChanges = changes(results[2]);
    return {
      status:
        incidentChanges === 1
          ? "created"
          : timelineChanges === 0 && outboxChanges === 0
            ? "duplicate"
            : "existing",
      incident,
    };
  }

  private async firstUnreconciledFailure(
    scope: FailureNotificationRepairScope,
  ):
  Promise<PersistedObservation | null> {
    const row = await this.database
      .prepare(
        `
          SELECT o.observation_id, o.schema_version, o.site_id,
            o.environment, o.component, o.check_id, o.status,
            o.reason_code, o.observed_at, o.valid_until, o.source,
            o.scope, o.evidence_id, o.correlation_id, o.idempotency_key,
            o.created_at
          FROM observations o
          WHERE o.site_id = ?1
            AND o.environment = ?2
            AND o.status = 'fail'
            AND (
              NOT EXISTS (
                SELECT 1
                FROM incidents i
                INNER JOIN incident_timeline t
                  ON t.incident_id = i.incident_id
                WHERE i.site_id = o.site_id
                  AND i.environment = o.environment
                  AND i.component = o.component
                  AND i.reason_code = o.reason_code
                  AND i.scope = o.scope
                  AND t.event_type = 'observation_recorded'
                  AND t.observation_id = o.observation_id
                  AND t.idempotency_key = o.idempotency_key
              )
              OR NOT EXISTS (
                SELECT 1
                FROM incidents i
                INNER JOIN notification_outbox n
                  ON n.incident_id = i.incident_id
                  AND n.notification_kind = 'incident_opened'
                WHERE i.site_id = o.site_id
                  AND i.environment = o.environment
                  AND i.component = o.component
                  AND i.reason_code = o.reason_code
                  AND i.scope = o.scope
              )
            )
          ORDER BY o.created_at, o.observation_id
          LIMIT 1
        `,
      )
      .bind(scope.siteId, scope.environment)
      .first<PersistedObservationRow>();
    return row ? persistedObservationFromRow(row) : null;
  }

  async repairMissingFailureNotifications(
    scope: FailureNotificationRepairScope,
    limit = FAILURE_NOTIFICATION_REPAIR_LIMIT,
  ): Promise<number> {
    if (
      !/^[a-z][a-z0-9-]{2,63}$/u.test(scope.siteId) ||
      (scope.environment !== "staging" &&
        scope.environment !== "production")
    ) {
      invalid("failure_notification_repair_scope_invalid");
    }
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > FAILURE_NOTIFICATION_REPAIR_LIMIT
    ) {
      invalid("failure_notification_repair_limit_invalid");
    }
    let repaired = 0;
    while (repaired < limit) {
      const missing = await this.firstUnreconciledFailure(scope);
      if (!missing) break;
      const result =
        await this.recordFailureAndPendingNotification(
          missing.observation,
        );
      if (result.status === "ignored") {
        throw new Error("failure_notification_repair_incomplete");
      }
      repaired += 1;
    }
    return repaired;
  }

  async recordFailure(
    input: RecordIncidentFailureInput,
  ): Promise<RecordIncidentFailureResult> {
    validateIncidentIdentity(input.identity);
    validateIncidentSeverity(input.severity);
    const observationId = identifier(
      input.observationId,
      "incident_observation_id_invalid",
    );
    const idempotencyKey = identifier(
      input.observationIdempotencyKey,
      "incident_idempotency_key_invalid",
    );
    const correlationId = identifier(
      input.correlationId,
      "incident_correlation_id_invalid",
    );
    const occurredAt = iso(
      input.occurredAt,
      "incident_occurred_at_invalid",
    );
    const fingerprint = await incidentFingerprint(input.identity);
    const incidentId = `inc_${fingerprint.slice(0, 32)}`;
    const eventId = `event:${observationId}`;
    const results = await this.database.batch([
      this.database.prepare(insertIncident).bind(
        incidentId,
        fingerprint,
        input.identity.siteId,
        input.identity.environment,
        input.identity.component,
        input.identity.reasonCode,
        input.identity.scope,
        input.severity,
        occurredAt,
      ),
      this.database.prepare(insertObservationEvent).bind(
        eventId,
        fingerprint,
        observationId,
        correlationId,
        occurredAt,
        idempotencyKey,
      ),
    ]);
    const incident = await this.findByFingerprint(fingerprint);
    if (!incident) throw new Error("incident_write_incomplete");
    if (
      identityMaterial(incident) !== stableJson(input.identity)
    ) {
      invalid("incident_idempotency_conflict");
    }
    if (changes(results[1]) === 0) {
      const existing = await this.database
        .prepare(
          `
            SELECT observation_id, from_state, to_state
            FROM incident_timeline
            WHERE incident_id = ?1 AND idempotency_key = ?2
            LIMIT 1
          `,
        )
        .bind(incident.incidentId, idempotencyKey)
        .first<TimelineRow>();
      if (existing?.observation_id !== observationId) {
        invalid("incident_idempotency_conflict");
      }
      return { status: "duplicate", incident };
    }
    return {
      status: changes(results[0]) === 1 ? "created" : "existing",
      incident,
    };
  }

  async findByFingerprint(
    fingerprint: string,
  ): Promise<Incident | null> {
    if (!/^[a-f0-9]{64}$/u.test(fingerprint)) {
      invalid("incident_fingerprint_invalid");
    }
    const row = await this.database
      .prepare(`${selectIncident} WHERE fingerprint = ?1 LIMIT 1`)
      .bind(fingerprint)
      .first<IncidentRow>();
    return row ? fromRow(row) : null;
  }

  async findById(incidentId: string): Promise<Incident | null> {
    identifier(incidentId, "incident_id_invalid");
    const row = await this.database
      .prepare(`${selectIncident} WHERE incident_id = ?1 LIMIT 1`)
      .bind(incidentId)
      .first<IncidentRow>();
    return row ? fromRow(row) : null;
  }

  async transition(
    command: IncidentTransitionCommand,
    policy: IncidentResolutionPolicy,
  ): Promise<Incident> {
    const incidentId = identifier(
      command.incidentId,
      "incident_id_invalid",
    );
    const idempotencyKey = identifier(
      command.idempotencyKey,
      "incident_idempotency_key_invalid",
    );
    const correlationId = identifier(
      command.correlationId,
      "incident_correlation_id_invalid",
    );
    const occurredAt = iso(
      command.occurredAt,
      "incident_occurred_at_invalid",
    );
    const incident = await this.findById(incidentId);
    if (!incident) invalid("incident_not_found");
    const existing = await this.database
      .prepare(
        `
          SELECT observation_id, from_state, to_state
          FROM incident_timeline
          WHERE incident_id = ?1 AND idempotency_key = ?2
          LIMIT 1
        `,
      )
      .bind(incidentId, idempotencyKey)
      .first<TimelineRow>();
    if (existing) {
      if (
        existing.observation_id !== null ||
        existing.to_state !== command.toState
      ) {
        invalid("incident_idempotency_conflict");
      }
      return incident;
    }
    assertIncidentTransition(
      incident,
      command.toState,
      policy,
      command.resolutionEvidence,
    );
    const eventId = `event:${incidentId}:${idempotencyKey}`;
    const results = await this.database.batch([
      this.database
        .prepare(
          `
            INSERT OR IGNORE INTO incident_timeline (
              event_id, incident_id, event_type, observation_id, from_state,
              to_state, correlation_id, occurred_at, idempotency_key
            )
            SELECT ?1, incident_id, 'state_transition', NULL, ?3, ?4, ?5, ?6, ?7
            FROM incidents
            WHERE incident_id = ?2 AND state = ?3
          `,
        )
        .bind(
          eventId,
          incidentId,
          incident.state,
          command.toState,
          correlationId,
          occurredAt,
          idempotencyKey,
        ),
      this.database
        .prepare(
          `
            UPDATE incidents
            SET state = ?1, updated_at = ?2
            WHERE incident_id = ?3 AND state = ?4
              AND EXISTS (
                SELECT 1 FROM incident_timeline
                WHERE incident_id = ?3 AND idempotency_key = ?5
                  AND to_state = ?1
              )
          `,
        )
        .bind(
          command.toState,
          occurredAt,
          incidentId,
          incident.state,
          idempotencyKey,
        ),
    ]);
    if (changes(results[0]) !== 1 || changes(results[1]) !== 1) {
      invalid("incident_transition_conflict");
    }
    const updated = await this.findById(incidentId);
    if (!updated) throw new Error("incident_transition_incomplete");
    return updated;
  }
}
