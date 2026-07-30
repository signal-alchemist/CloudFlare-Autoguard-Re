import {
  ContractError,
  stableJson,
  type Component,
  type Environment,
  type Observation,
  type ObservationSource,
  type ObservationStatus,
} from "../contracts/ops-signal.ts";
import {
  evaluateComponentVerdict,
  type ComponentPolicyV1,
  type ComponentState,
  type ComponentVerdict,
} from "../domain/component-verdict.ts";
import type { OperationalStateRepository } from "../services/gate-projection.ts";
import type { D1RunResult } from "./observations.ts";

export interface D1AllResult<T> {
  success: boolean;
  results: T[];
}

export interface D1OperationalStatementPort {
  bind(...values: unknown[]): D1OperationalStatementPort;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<D1AllResult<T>>;
  run(): Promise<D1RunResult>;
}

export interface D1OperationalDatabasePort {
  prepare(sql: string): D1OperationalStatementPort;
  batch(
    statements: readonly D1OperationalStatementPort[],
  ): Promise<D1RunResult[]>;
}

export interface OperationalPolicySetV1 {
  schemaVersion: 1;
  policySetVersion: string;
  siteId: string;
  environment: Environment;
  components: readonly ComponentPolicyV1[];
}

interface ObservationRow {
  observation_id: unknown;
  schema_version: unknown;
  site_id: unknown;
  environment: unknown;
  component: unknown;
  check_id: unknown;
  status: unknown;
  reason_code: unknown;
  observed_at: unknown;
  valid_until: unknown;
  source: unknown;
  scope: unknown;
  evidence_id: unknown;
  correlation_id: unknown;
  idempotency_key: unknown;
}

interface VerdictRow {
  site_id: unknown;
  environment: unknown;
  component: unknown;
  schema_version: unknown;
  policy_version: unknown;
  state: unknown;
  reason_codes_json: unknown;
  observation_ids_json: unknown;
  evaluated_at: unknown;
  fresh_until: unknown;
}

interface FreezeRow {
  freeze_id: unknown;
  site_id: unknown;
  environment: unknown;
  reason_code: unknown;
  correlation_id: unknown;
  activated_at: unknown;
  expires_at: unknown;
  released_at: unknown;
}

interface AllowedTuple {
  component: Component;
  checkId: string;
  source: ObservationSource;
}

const componentValues = new Set<Component>([
  "public_delivery",
  "editorial",
  "contact_intake",
  "media_delivery",
  "notification_delivery",
  "deployment_integrity",
  "recovery_readiness",
  "autoguard_control_plane",
]);
const sourceValues = new Set<ObservationSource>([
  "cms_ops_signal",
  "public_probe",
  "external_probe",
  "provider_api",
  "autoguard_self",
  "post_deploy",
]);
const statusValues = new Set<ObservationStatus>([
  "pass",
  "fail",
  "degraded",
  "unknown",
  "unsupported",
]);
const stateValues = new Set<ComponentState>([
  "healthy",
  "degraded",
  "unhealthy",
  "unknown",
  "maintenance",
]);
const safeIdentifier = /^[A-Za-z0-9_.:-]+$/u;
const observationId = /^obs_[a-f0-9]{32}$/u;
const evidenceId = /^ev_[a-f0-9]{32}$/u;
const maximumLatestObservationRows = 4_096;
const maximumUnreleasedFreezeRows = 1_024;

function invalid(code: string): never {
  throw new ContractError(code);
}

function identifier(
  value: unknown,
  code: string,
  maximum = 128,
): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    !safeIdentifier.test(value)
  ) {
    invalid(code);
  }
  return value;
}

function boundedText(
  value: unknown,
  code: string,
  maximum: number,
): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    invalid(code);
  }
  return value;
}

function canonicalIso(value: unknown, code: string): string {
  if (typeof value !== "string") invalid(code);
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  ) {
    invalid(code);
  }
  return value;
}

function component(value: unknown, code: string): Component {
  return typeof value === "string" &&
    componentValues.has(value as Component)
    ? value as Component
    : invalid(code);
}

function source(value: unknown, code: string): ObservationSource {
  return typeof value === "string" &&
    sourceValues.has(value as ObservationSource)
    ? value as ObservationSource
    : invalid(code);
}

function status(value: unknown, code: string): ObservationStatus {
  return typeof value === "string" &&
    statusValues.has(value as ObservationStatus)
    ? value as ObservationStatus
    : invalid(code);
}

function state(value: unknown, code: string): ComponentState {
  return typeof value === "string" &&
    stateValues.has(value as ComponentState)
    ? value as ComponentState
    : invalid(code);
}

function validScope(
  siteId: string,
  environmentValue: Environment,
): boolean {
  return (
    typeof siteId === "string" &&
    /^[a-z][a-z0-9-]{2,63}$/u.test(siteId) &&
    (environmentValue === "staging" ||
      environmentValue === "production")
  );
}

function validatePolicySet(
  policySet: OperationalPolicySetV1,
): readonly ComponentPolicyV1[] {
  if (
    policySet.schemaVersion !== 1 ||
    !validScope(policySet.siteId, policySet.environment) ||
    typeof policySet.policySetVersion !== "string" ||
    policySet.policySetVersion.length < 1 ||
    !safeIdentifier.test(policySet.policySetVersion) ||
    policySet.policySetVersion.length > 128 ||
    !Array.isArray(policySet.components) ||
    policySet.components.length < 1 ||
    policySet.components.length > componentValues.size
  ) {
    invalid("operational_policy_invalid");
  }
  const components = new Set<Component>();
  const sorted = [...policySet.components].sort((left, right) =>
    left.component.localeCompare(right.component),
  );
  for (const policy of sorted) {
    if (
      policy.siteId !== policySet.siteId ||
      policy.environment !== policySet.environment ||
      components.has(policy.component)
    ) {
      invalid("operational_policy_scope_invalid");
    }
    // The pure evaluator owns detailed check/quorum validation.
    evaluateComponentVerdict(policy, [], 0);
    components.add(policy.component);
  }
  return sorted;
}

function allowedTuples(
  policies: readonly ComponentPolicyV1[],
): readonly AllowedTuple[] {
  const tuples = policies.flatMap((policy) =>
    policy.checks.flatMap((check) =>
      check.requiredSources.map((requiredSource) => ({
        component: policy.component,
        checkId: check.checkId,
        source: requiredSource,
      })),
    ),
  );
  const identities = tuples.map(
    (tuple) =>
      `${tuple.component}\u0000${tuple.checkId}\u0000${tuple.source}`,
  );
  if (new Set(identities).size !== identities.length) {
    invalid("operational_policy_tuple_conflict");
  }
  return tuples;
}

function latestObservationSql(tupleCount: number): string {
  if (!Number.isSafeInteger(tupleCount) || tupleCount < 1) {
    invalid("operational_policy_invalid");
  }
  const values = Array.from(
    { length: tupleCount },
    () => "(?, ?, ?)",
  ).join(", ");
  return `
    WITH allowlist(component, check_id, source) AS (
      VALUES ${values}
    ),
    latest AS (
      SELECT
        o.site_id,
        o.environment,
        o.component,
        o.check_id,
        o.source,
        MAX(o.observed_at) AS observed_at
      FROM observations o
      INNER JOIN allowlist a
        ON a.component = o.component
       AND a.check_id = o.check_id
       AND a.source = o.source
      WHERE o.site_id = ?
        AND o.environment = ?
      GROUP BY
        o.site_id, o.environment, o.component, o.check_id, o.source
    )
    SELECT
      o.observation_id, o.schema_version, o.site_id, o.environment,
      o.component, o.check_id, o.status, o.reason_code, o.observed_at,
      o.valid_until, o.source, o.scope, o.evidence_id, o.correlation_id,
      o.idempotency_key
    FROM observations o
    INNER JOIN latest l
      ON l.site_id = o.site_id
     AND l.environment = o.environment
     AND l.component = o.component
     AND l.check_id = o.check_id
     AND l.source = o.source
     AND l.observed_at = o.observed_at
    ORDER BY
      o.component, o.check_id, o.source, o.observation_id
    LIMIT ${maximumLatestObservationRows + 1}
  `;
}

function decodeObservation(
  row: ObservationRow,
  policySet: OperationalPolicySetV1,
  allowlist: ReadonlySet<string>,
): Observation {
  if (
    row.schema_version !== 1 ||
    row.site_id !== policySet.siteId ||
    row.environment !== policySet.environment
  ) {
    invalid("operational_observation_invalid");
  }
  const decodedComponent = component(
    row.component,
    "operational_observation_invalid",
  );
  const checkId = identifier(
    row.check_id,
    "operational_observation_invalid",
  );
  const decodedSource = source(
    row.source,
    "operational_observation_invalid",
  );
  if (
    !allowlist.has(
      `${decodedComponent}\u0000${checkId}\u0000${decodedSource}`,
    )
  ) {
    invalid("operational_observation_scope_invalid");
  }
  if (
    typeof row.observation_id !== "string" ||
    !observationId.test(row.observation_id) ||
    typeof row.evidence_id !== "string" ||
    !evidenceId.test(row.evidence_id)
  ) {
    invalid("operational_observation_invalid");
  }
  const idempotencyKey = boundedText(
    row.idempotency_key,
    "operational_observation_invalid",
    512,
  );
  if (idempotencyKey.length < 16) {
    invalid("operational_observation_invalid");
  }
  return {
    schemaVersion: 1,
    observationId: row.observation_id,
    siteId: policySet.siteId,
    environment: policySet.environment,
    component: decodedComponent,
    checkId,
    status: status(row.status, "operational_observation_invalid"),
    reasonCode: identifier(
      row.reason_code,
      "operational_observation_invalid",
    ),
    observedAt: canonicalIso(
      row.observed_at,
      "operational_observation_invalid",
    ),
    validUntil: canonicalIso(
      row.valid_until,
      "operational_observation_invalid",
    ),
    source: decodedSource,
    scope: boundedText(
      row.scope,
      "operational_observation_invalid",
      512,
    ),
    evidenceId: row.evidence_id,
    correlationId: identifier(
      row.correlation_id,
      "operational_observation_invalid",
    ),
    idempotencyKey,
  };
}

function stringArray(
  value: unknown,
  code: string,
  validate: (item: string) => boolean,
): readonly string[] {
  if (typeof value !== "string" || value.length > 64 * 1_024) {
    invalid(code);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    invalid(code);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length > 4_096 ||
    parsed.some(
      (item) => typeof item !== "string" || !validate(item),
    )
  ) {
    invalid(code);
  }
  const sorted = [...parsed].sort((left, right) =>
    left.localeCompare(right),
  );
  if (
    new Set(sorted).size !== sorted.length ||
    stableJson(sorted) !== value
  ) {
    invalid(code);
  }
  return sorted;
}

function decodeVerdict(
  row: VerdictRow,
  policy: ComponentPolicyV1,
): ComponentVerdict {
  if (
    row.schema_version !== 1 ||
    row.site_id !== policy.siteId ||
    row.environment !== policy.environment ||
    row.component !== policy.component ||
    row.policy_version !== policy.policyVersion
  ) {
    invalid("operational_verdict_invalid");
  }
  const decodedState = state(row.state, "operational_verdict_invalid");
  const freshUntil =
    row.fresh_until === null
      ? null
      : canonicalIso(row.fresh_until, "operational_verdict_invalid");
  if (decodedState === "healthy" && freshUntil === null) {
    invalid("operational_verdict_invalid");
  }
  return {
    schemaVersion: 1,
    policyVersion: policy.policyVersion,
    siteId: policy.siteId,
    environment: policy.environment,
    component: policy.component,
    state: decodedState,
    reasonCodes: stringArray(
      row.reason_codes_json,
      "operational_verdict_invalid",
      (item) =>
        item.length <= 128 &&
        safeIdentifier.test(item),
    ),
    observationIds: stringArray(
      row.observation_ids_json,
      "operational_verdict_invalid",
      (item) => observationId.test(item),
    ),
    evaluatedAt: canonicalIso(
      row.evaluated_at,
      "operational_verdict_invalid",
    ),
    freshUntil,
  };
}

const upsertVerdict = `
  INSERT INTO component_verdicts (
    site_id, environment, component, schema_version, policy_version, state,
    reason_codes_json, observation_ids_json, evaluated_at, fresh_until
  ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
  ON CONFLICT(site_id, environment, component) DO UPDATE SET
    schema_version = excluded.schema_version,
    policy_version = excluded.policy_version,
    state = excluded.state,
    reason_codes_json = excluded.reason_codes_json,
    observation_ids_json = excluded.observation_ids_json,
    evaluated_at = excluded.evaluated_at,
    fresh_until = excluded.fresh_until
  WHERE component_verdicts.evaluated_at <= excluded.evaluated_at
`;

const selectVerdicts = `
  SELECT
    site_id, environment, component, schema_version, policy_version, state,
    reason_codes_json, observation_ids_json, evaluated_at, fresh_until
  FROM component_verdicts
  WHERE site_id = ?1 AND environment = ?2
  ORDER BY component
`;

const selectUnreleasedFreezes = `
  SELECT
    freeze_id, site_id, environment, reason_code, correlation_id,
    activated_at, expires_at, released_at
  FROM freezes
  WHERE site_id = ?1
    AND environment = ?2
    AND released_at IS NULL
  ORDER BY activated_at, freeze_id
  LIMIT ${maximumUnreleasedFreezeRows + 1}
`;

export class D1OperationalStateRepository
implements OperationalStateRepository {
  readonly database: D1OperationalDatabasePort;
  readonly policySet: OperationalPolicySetV1;
  readonly policies: readonly ComponentPolicyV1[];
  readonly tuples: readonly AllowedTuple[];

  constructor(
    database: D1OperationalDatabasePort,
    policySet: OperationalPolicySetV1,
  ) {
    this.database = database;
    this.policySet = policySet;
    this.policies = validatePolicySet(policySet);
    this.tuples = allowedTuples(this.policies);
  }

  private assertScope(
    input: {
      siteId: string;
      environment: Environment;
      nowMs: number;
    },
  ): void {
    if (
      input.siteId !== this.policySet.siteId ||
      input.environment !== this.policySet.environment ||
      !Number.isFinite(input.nowMs)
    ) {
      invalid("operational_state_scope_invalid");
    }
  }

  async readVerdicts(input: {
    siteId: string;
    environment: Environment;
    nowMs: number;
  }): Promise<readonly ComponentVerdict[]> {
    this.assertScope(input);
    const bindings = this.tuples.flatMap((tuple) => [
      tuple.component,
      tuple.checkId,
      tuple.source,
    ]);
    const latest = await this.database
      .prepare(latestObservationSql(this.tuples.length))
      .bind(...bindings, input.siteId, input.environment)
      .all<ObservationRow>();
    if (
      !latest.success ||
      !Array.isArray(latest.results) ||
      latest.results.length > maximumLatestObservationRows
    ) {
      throw new Error("operational_observation_read_failed");
    }
    const allowlist = new Set(
      this.tuples.map(
        (tuple) =>
          `${tuple.component}\u0000${tuple.checkId}\u0000${tuple.source}`,
      ),
    );
    const observations = latest.results.map((row) =>
      decodeObservation(row, this.policySet, allowlist),
    );
    const verdicts = this.policies.map((policy) =>
      evaluateComponentVerdict(policy, observations, input.nowMs),
    );
    const writes = verdicts.map((verdict) =>
      this.database.prepare(upsertVerdict).bind(
        verdict.siteId,
        verdict.environment,
        verdict.component,
        verdict.schemaVersion,
        verdict.policyVersion,
        verdict.state,
        stableJson(verdict.reasonCodes),
        stableJson(verdict.observationIds),
        verdict.evaluatedAt,
        verdict.freshUntil,
      ),
    );
    const written = await this.database.batch(writes);
    if (
      written.length !== writes.length ||
      written.some((result) => !result.success)
    ) {
      throw new Error("operational_verdict_write_failed");
    }

    const persisted = await this.database
      .prepare(selectVerdicts)
      .bind(input.siteId, input.environment)
      .all<VerdictRow>();
    if (
      !persisted.success ||
      !Array.isArray(persisted.results) ||
      persisted.results.length !== this.policies.length
    ) {
      throw new Error("operational_verdict_read_failed");
    }
    const policies = new Map(
      this.policies.map((policy) => [policy.component, policy]),
    );
    const decoded = persisted.results.map((row) => {
      const decodedComponent = component(
        row.component,
        "operational_verdict_invalid",
      );
      const policy = policies.get(decodedComponent);
      return policy
        ? decodeVerdict(row, policy)
        : invalid("operational_verdict_scope_invalid");
    });
    if (
      new Set(decoded.map((verdict) => verdict.component)).size !==
      this.policies.length
    ) {
      invalid("operational_verdict_conflict");
    }
    return decoded;
  }

  async hasActiveFreeze(input: {
    siteId: string;
    environment: Environment;
    nowMs: number;
  }): Promise<boolean> {
    this.assertScope(input);
    const result = await this.database
      .prepare(selectUnreleasedFreezes)
      .bind(input.siteId, input.environment)
      .all<FreezeRow>();
    if (
      !result.success ||
      !Array.isArray(result.results) ||
      result.results.length > maximumUnreleasedFreezeRows
    ) {
      throw new Error("operational_freeze_read_failed");
    }
    const identities = new Set<string>();
    let active = false;
    for (const row of result.results) {
      const freezeId = identifier(
        row.freeze_id,
        "operational_freeze_invalid",
      );
      if (
        identities.has(freezeId) ||
        row.site_id !== input.siteId ||
        row.environment !== input.environment ||
        row.released_at !== null
      ) {
        invalid("operational_freeze_invalid");
      }
      identities.add(freezeId);
      identifier(row.reason_code, "operational_freeze_invalid");
      identifier(row.correlation_id, "operational_freeze_invalid");
      const activatedAt = canonicalIso(
        row.activated_at,
        "operational_freeze_invalid",
      );
      const expiresAt = canonicalIso(
        row.expires_at,
        "operational_freeze_invalid",
      );
      const activatedMs = Date.parse(activatedAt);
      const expiresMs = Date.parse(expiresAt);
      if (expiresMs <= activatedMs) {
        invalid("operational_freeze_invalid");
      }
      if (activatedMs <= input.nowMs && expiresMs > input.nowMs) {
        active = true;
      }
    }
    return active;
  }
}
