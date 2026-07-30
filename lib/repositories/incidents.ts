import {
  ContractError,
  stableJson,
} from "../contracts/ops-signal.ts";
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

function identifier(value: string, code: string): string {
  if (
    value.length < 1 ||
    value.length > 180 ||
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

export class D1IncidentRepository {
  readonly database: D1DatabasePort;

  constructor(database: D1DatabasePort) {
    this.database = database;
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
