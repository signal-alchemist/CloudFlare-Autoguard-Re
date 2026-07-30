import { resolveOperationalPolicySet } from "../../config/sites/dfconnect.operational-policy.ts";
import { dfconnectProductionManifest } from "../../config/sites/dfconnect.production.ts";
import { createHttpNotificationProvider } from "../adapters/http-notification-provider.ts";
import {
  stableJson,
  type Component,
  type Environment,
} from "../contracts/ops-signal.ts";
import type {
  ComponentState,
  ComponentVerdict,
} from "../domain/component-verdict.ts";
import {
  evaluateOperationGate,
  type Operation,
} from "../domain/gate-policy.ts";
import {
  incidentFingerprint,
  validateIncidentIdentity,
  validateIncidentSeverity,
  type Incident,
  type IncidentSeverity,
  type IncidentState,
} from "../domain/incidents.ts";
import {
  validateDeploymentRuntimeIdentity,
  type DeploymentRuntimeIdentity,
} from "../domain/deployment-runtime-identity.ts";
import {
  readOperationalVerdicts,
  type D1OperationalReadDatabasePort,
} from "../repositories/operational-state.ts";
import {
  compilePublicDeliveryManifest,
} from "../probes/public-delivery.ts";
import { sha256Hex } from "../security/safe-output.ts";

export interface ReadOnlyD1AllResult<T> {
  success: boolean;
  results: T[];
}

export interface ReadOnlyD1StatementPort {
  bind(...values: unknown[]): ReadOnlyD1StatementPort;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<ReadOnlyD1AllResult<T>>;
}

export interface ReadOnlyD1DatabasePort {
  prepare(sql: string): ReadOnlyD1StatementPort;
}

export interface GuardReadBindings {
  DB?: ReadOnlyD1DatabasePort;
  EVIDENCE_BUCKET?: {
    head(key: string): Promise<unknown>;
  };
  GUARD_SITE_ID?: string;
  GUARD_ENVIRONMENT?: Environment;
  CONSOLE_AUTH_MODE?:
    | "cloudflare-access"
    | "sites-private"
    | "local-development";
  CONSOLE_ACCESS_AUDIENCE?: string;
  CONSOLE_ACCESS_ISSUER?: string;
  CMS_GATE_SERVICE_TOKEN?: string;
  CMS_GATE_SIGNING_SECRET?: string;
  CMS_SIGNAL_SERVICE_TOKEN?: string;
  CMS_SIGNAL_SIGNING_SECRET?: string;
  CMS_POST_DEPLOY_SERVICE_TOKEN?: string;
  CMS_POST_DEPLOY_SIGNING_SECRET?: string;
  CMS_MAINTENANCE_SERVICE_TOKEN?: string;
  CMS_MAINTENANCE_SIGNING_SECRET?: string;
  NOTIFICATION_QUEUE?: {
    send(message: unknown, options?: unknown): Promise<void>;
  };
  NOTIFICATION_QUEUE_NAME?: string;
  NOTIFICATION_PROVIDER_ENABLED?: string;
  NOTIFICATION_PROVIDER_ENDPOINT?: string;
  NOTIFICATION_PROVIDER_TOKEN?: string;
}

export const COMPONENT_CATALOG = [
  "public_delivery",
  "editorial",
  "contact_intake",
  "media_delivery",
  "notification_delivery",
  "deployment_integrity",
  "recovery_readiness",
  "autoguard_control_plane",
] as const satisfies readonly Component[];

export const OPERATION_CATALOG = [
  "contentPublish",
  "siteDeploy",
  "contactAccept",
  "destructiveRecovery",
] as const satisfies readonly Operation[];

export interface CanonicalComponentProjection {
  component: Component;
  configured: boolean;
  policyVersion: string | null;
  state: ComponentState;
  fresh: boolean;
  lastObservedAt: string | null;
  activeIncidentCount: number;
  reasonCodes: readonly string[];
  observationIds: readonly string[];
  evaluatedAt: string;
  freshUntil: string | null;
}

export interface CanonicalGateProjection {
  operation: Operation;
  decision: "allow" | "deny";
  reasonCodes: readonly string[];
  blockedComponents: readonly Component[];
  evaluatedAt: string;
  freshUntil: string | null;
  freeze: boolean;
}

export interface CanonicalOperabilitySnapshotV1 {
  schema: "guard-operability-v1";
  siteId: string;
  environment: Environment;
  generatedAt: string;
  overall: ComponentState;
  components: readonly CanonicalComponentProjection[];
  gates: readonly CanonicalGateProjection[];
  incidents: {
    active: number;
    truncated: boolean;
    items: readonly {
      incidentId: string;
      component: Component;
      severity: IncidentSeverity;
      state: Exclude<IncidentState, "resolved">;
      reasonCode: string;
      openedAt: string;
      updatedAt: string;
    }[];
  };
  notifications: {
    outbox: {
      pending: number;
      enqueued: number;
      blocked: number;
      oldestPendingAt?: string | null;
    };
    deliveries: {
      total: number;
      latestDeliveredAt: string | null;
    };
  };
  deployment: {
    identity:
    | {
      state: "missing";
    }
    | {
      state: "fresh" | "stale";
      identityId: string;
      commitSha: string;
      workerVersionId: string;
      policyVersion: string;
      observedAt: string;
      validUntil: string;
    };
    postDeploy: {
      status: "claimed" | "pass" | "fail" | "unknown";
      reasonCode: string | null;
      commitSha: string;
      workerVersionId: string;
      requestedAt: number;
      checkedAt: number | null;
    } | null;
  };
  freeze: {
    active: boolean;
    count: number;
    earliestExpiresAt: string | null;
    reasonCodes: readonly string[];
  };
  scheduler: {
    state: "fresh_pass" | "fresh_unknown" | "stale" | "missing";
    reasonCode: string;
    observedAt: string | null;
    validUntil: string | null;
  };
  readiness: {
    status: "ready" | "not_ready";
    checks: {
      runtimeScopePolicy: "ready" | "not_ready";
      consoleAuthentication: "ready" | "not_ready";
      databaseSchema: "ready" | "not_ready";
      evidenceStorage: "ready" | "not_ready";
      cmsCredentials: "ready" | "not_ready";
      notificationPath: "ready" | "not_ready";
      scheduledManifest: "ready" | "not_ready";
      schedulerHeartbeat: "ready" | "not_ready";
    };
  };
}

interface IncidentRow {
  incident_id: unknown;
  fingerprint: unknown;
  site_id: unknown;
  environment: unknown;
  component: unknown;
  reason_code: unknown;
  scope: unknown;
  severity: unknown;
  state: unknown;
  opened_at: unknown;
  updated_at: unknown;
}

interface FreezeRow {
  freeze_id: unknown;
  site_id: unknown;
  environment: unknown;
  reason_code: unknown;
  activated_at: unknown;
  expires_at: unknown;
  released_at: unknown;
}

interface OutboxRow {
  total_count: unknown;
  pending_count: unknown;
  enqueued_count: unknown;
  blocked_count: unknown;
  oldest_pending_at: unknown;
}

interface DeliveryRow {
  total_count: unknown;
  latest_delivered_at: unknown;
}

interface RuntimeIdentityRow {
  identity_id: unknown;
  schema_version: unknown;
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

interface PostDeployRow {
  request_id: unknown;
  request_digest: unknown;
  site_id: unknown;
  environment: unknown;
  commit_sha: unknown;
  worker_version_id: unknown;
  evidence_digest: unknown;
  requested_at: unknown;
  status: unknown;
  reason_code: unknown;
  checked_at: unknown;
  created_at: unknown;
  updated_at: unknown;
  receipt_count: unknown;
  receipt_recorded_at: unknown;
}

interface IncidentCountRow {
  active_count: unknown;
}

interface IncidentComponentCountRow {
  component: unknown;
  active_count: unknown;
}

interface ComponentObservedRow {
  component: unknown;
  last_observed_at: unknown;
}

interface SchedulerRow {
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

const componentSet = new Set<Component>(COMPONENT_CATALOG);
const incidentStateSet = new Set<IncidentState>([
  "open",
  "acknowledged",
  "mitigating",
  "monitoring",
  "resolved",
  "manual_required",
]);
const incidentSeveritySet = new Set<IncidentSeverity>([
  "sev1",
  "sev2",
  "sev3",
  "sev4",
]);
const maximumIncidentItems = 100;
const maximumFreezes = 1_024;
const heartbeatCheckId = "guard.scheduler.public_delivery";
const heartbeatScope = "scheduled:dfconnect:production:public-delivery";
const heartbeatMaximumValidityMs = 180_000;
const expectedQueueName = "cloudflare-guard-notifications";

function unavailable(code: string): never {
  throw new Error(code);
}

function identifier(value: unknown, code: string, maximum = 180): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    !/^[A-Za-z0-9_.:-]+$/u.test(value)
  ) {
    unavailable(code);
  }
  return value;
}

function canonicalIso(value: unknown, code: string): string {
  if (typeof value !== "string") unavailable(code);
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  ) {
    unavailable(code);
  }
  return value;
}

function nullableCanonicalIso(value: unknown, code: string): string | null {
  return value === null ? null : canonicalIso(value, code);
}

function finiteInteger(value: unknown, code: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    unavailable(code);
  }
  return value;
}

function component(value: unknown, code: string): Component {
  if (
    typeof value !== "string" ||
    !componentSet.has(value as Component)
  ) {
    unavailable(code);
  }
  return value as Component;
}

async function all<T>(
  database: ReadOnlyD1DatabasePort,
  sql: string,
  values: readonly unknown[],
  code: string,
): Promise<T[]> {
  const result = await database.prepare(sql).bind(...values).all<T>();
  if (!result.success || !Array.isArray(result.results)) unavailable(code);
  return result.results;
}

function runtimeScope(bindings: GuardReadBindings): {
  siteId: string;
  environment: Environment;
} {
  if (
    typeof bindings.GUARD_SITE_ID !== "string" ||
    !/^[a-z][a-z0-9-]{2,63}$/u.test(bindings.GUARD_SITE_ID) ||
    (bindings.GUARD_ENVIRONMENT !== "staging" &&
      bindings.GUARD_ENVIRONMENT !== "production")
  ) {
    unavailable("operability_scope_unavailable");
  }
  return {
    siteId: bindings.GUARD_SITE_ID,
    environment: bindings.GUARD_ENVIRONMENT,
  };
}

function missingComponentVerdict(
  scope: { siteId: string; environment: Environment },
  missingComponent: Component,
  nowMs: number,
): ComponentVerdict {
  return {
    schemaVersion: 1,
    policyVersion: "component-policy-missing-v1",
    siteId: scope.siteId,
    environment: scope.environment,
    component: missingComponent,
    state: "unknown",
    reasonCodes: ["component_policy_missing"],
    observationIds: [],
    evaluatedAt: new Date(nowMs).toISOString(),
    freshUntil: null,
  };
}

async function readLastObservedAtByComponent(
  database: ReadOnlyD1DatabasePort,
  scope: { siteId: string; environment: Environment },
): Promise<ReadonlyMap<Component, string>> {
  const rows = await all<ComponentObservedRow>(
    database,
    `
      SELECT component, MAX(observed_at) AS last_observed_at
      FROM observations
      WHERE site_id = ?1
        AND environment = ?2
        AND component IN (
          'public_delivery', 'editorial', 'contact_intake', 'media_delivery',
          'notification_delivery', 'deployment_integrity',
          'recovery_readiness', 'autoguard_control_plane'
        )
      GROUP BY component
      ORDER BY component
    `,
    [scope.siteId, scope.environment],
    "operability_component_observation_read_failed",
  );
  const result = new Map<Component, string>();
  for (const row of rows) {
    const itemComponent = component(
      row.component,
      "operability_component_observation_invalid",
    );
    if (result.has(itemComponent)) {
      unavailable("operability_component_observation_invalid");
    }
    result.set(
      itemComponent,
      canonicalIso(
        row.last_observed_at,
        "operability_component_observation_invalid",
      ),
    );
  }
  return result;
}

interface ActiveIncidentRead {
  projection: CanonicalOperabilitySnapshotV1["incidents"];
  countByComponent: ReadonlyMap<Component, number>;
}

async function readActiveIncidents(
  database: ReadOnlyD1DatabasePort,
  scope: { siteId: string; environment: Environment },
): Promise<ActiveIncidentRead> {
  const countRow = await database
    .prepare(
      `
        SELECT COUNT(*) AS active_count
        FROM incidents
        WHERE site_id = ?1
          AND environment = ?2
          AND state <> 'resolved'
      `,
    )
    .bind(scope.siteId, scope.environment)
    .first<IncidentCountRow>();
  if (countRow === null) unavailable("operability_incident_read_failed");
  const active = finiteInteger(
    countRow.active_count,
    "operability_incident_invalid",
  );
  const countRows = await all<IncidentComponentCountRow>(
    database,
    `
      SELECT component, COUNT(*) AS active_count
      FROM incidents
      WHERE site_id = ?1
        AND environment = ?2
        AND state <> 'resolved'
      GROUP BY component
      ORDER BY component
    `,
    [scope.siteId, scope.environment],
    "operability_incident_read_failed",
  );
  const countByComponent = new Map<Component, number>();
  let groupedTotal = 0;
  for (const row of countRows) {
    const itemComponent = component(
      row.component,
      "operability_incident_invalid",
    );
    const itemCount = finiteInteger(
      row.active_count,
      "operability_incident_invalid",
    );
    if (itemCount < 1 || countByComponent.has(itemComponent)) {
      unavailable("operability_incident_invalid");
    }
    countByComponent.set(itemComponent, itemCount);
    groupedTotal += itemCount;
  }
  if (groupedTotal !== active) unavailable("operability_incident_invalid");

  const rows = await all<IncidentRow>(
    database,
    `
      SELECT incident_id, fingerprint, site_id, environment, component,
        reason_code, scope, severity, state, opened_at, updated_at
      FROM incidents
      WHERE site_id = ?1
        AND environment = ?2
        AND state <> 'resolved'
      ORDER BY opened_at DESC, incident_id
      LIMIT ${maximumIncidentItems}
    `,
    [scope.siteId, scope.environment],
    "operability_incident_read_failed",
  );
  const identities = new Set<string>();
  const items: CanonicalOperabilitySnapshotV1["incidents"]["items"][number][] =
    [];
  for (const row of rows) {
    if (
      typeof row.incident_id !== "string" ||
      !/^inc_[a-f0-9]{32}$/u.test(row.incident_id) ||
      identities.has(row.incident_id) ||
      typeof row.fingerprint !== "string" ||
      !/^[a-f0-9]{64}$/u.test(row.fingerprint) ||
      row.site_id !== scope.siteId ||
      row.environment !== scope.environment ||
      typeof row.state !== "string" ||
      !incidentStateSet.has(row.state as IncidentState) ||
      row.state === "resolved" ||
      typeof row.severity !== "string" ||
      !incidentSeveritySet.has(row.severity as IncidentSeverity)
    ) {
      unavailable("operability_incident_invalid");
    }
    const openedAt = canonicalIso(
      row.opened_at,
      "operability_incident_invalid",
    );
    const updatedAt = canonicalIso(
      row.updated_at,
      "operability_incident_invalid",
    );
    if (Date.parse(updatedAt) < Date.parse(openedAt)) {
      unavailable("operability_incident_invalid");
    }
    const incident: Incident = {
      incidentId: row.incident_id,
      fingerprint: row.fingerprint,
      siteId: scope.siteId,
      environment: scope.environment,
      component: component(row.component, "operability_incident_invalid"),
      reasonCode: identifier(
        row.reason_code,
        "operability_incident_invalid",
      ),
      scope:
        typeof row.scope === "string"
          ? row.scope
          : unavailable("operability_incident_invalid"),
      severity: row.severity as IncidentSeverity,
      state: row.state as IncidentState,
      openedAt,
      updatedAt,
    };
    try {
      validateIncidentIdentity(incident);
      validateIncidentSeverity(incident.severity);
      if ((await incidentFingerprint(incident)) !== incident.fingerprint) {
        unavailable("operability_incident_invalid");
      }
    } catch {
      unavailable("operability_incident_invalid");
    }
    identities.add(incident.incidentId);
    items.push({
      incidentId: incident.incidentId,
      component: incident.component,
      severity: incident.severity,
      state: incident.state as Exclude<IncidentState, "resolved">,
      reasonCode: "incident_active",
      openedAt,
      updatedAt,
    });
  }
  return {
    projection: {
      active,
      truncated: active > items.length,
      items,
    },
    countByComponent,
  };
}

async function readFreezes(
  database: ReadOnlyD1DatabasePort,
  scope: { siteId: string; environment: Environment },
  nowMs: number,
): Promise<CanonicalOperabilitySnapshotV1["freeze"]> {
  const now = new Date(nowMs).toISOString();
  const rows = await all<FreezeRow>(
    database,
    `
      SELECT freeze_id, site_id, environment, reason_code, activated_at,
        expires_at, released_at
      FROM freezes
      WHERE site_id = ?1
        AND environment = ?2
        AND released_at IS NULL
        AND activated_at <= ?3
        AND expires_at > ?3
      ORDER BY activated_at, freeze_id
      LIMIT ${maximumFreezes + 1}
    `,
    [scope.siteId, scope.environment, now],
    "operability_freeze_read_failed",
  );
  if (rows.length > maximumFreezes) {
    unavailable("operability_freeze_read_failed");
  }
  const identities = new Set<string>();
  const active: Array<{ reasonCode: string; expiresAt: string }> = [];
  for (const row of rows) {
    const freezeId = identifier(row.freeze_id, "operability_freeze_invalid");
    const reasonCode = identifier(
      row.reason_code,
      "operability_freeze_invalid",
    );
    const activatedAt = canonicalIso(
      row.activated_at,
      "operability_freeze_invalid",
    );
    const expiresAt = canonicalIso(
      row.expires_at,
      "operability_freeze_invalid",
    );
    if (
      identities.has(freezeId) ||
      row.site_id !== scope.siteId ||
      row.environment !== scope.environment ||
      row.released_at !== null ||
      Date.parse(expiresAt) <= Date.parse(activatedAt)
    ) {
      unavailable("operability_freeze_invalid");
    }
    identities.add(freezeId);
    active.push({ reasonCode, expiresAt });
  }
  const expiry = active
    .map((item) => item.expiresAt)
    .sort((left, right) => left.localeCompare(right))[0] ?? null;
  return {
    active: active.length > 0,
    count: active.length,
    earliestExpiresAt: expiry,
    reasonCodes: active.length > 0 ? ["active_freeze"] : [],
  };
}

async function readNotifications(
  database: ReadOnlyD1DatabasePort,
  scope: { siteId: string; environment: Environment },
): Promise<CanonicalOperabilitySnapshotV1["notifications"]> {
  const outboxRow = await database
    .prepare(
      `
        SELECT COUNT(*) AS total_count,
          COALESCE(SUM(CASE WHEN n.status = 'pending' THEN 1 ELSE 0 END), 0)
            AS pending_count,
          COALESCE(SUM(CASE WHEN n.status = 'enqueued' THEN 1 ELSE 0 END), 0)
            AS enqueued_count,
          COALESCE(SUM(CASE WHEN n.status = 'blocked' THEN 1 ELSE 0 END), 0)
            AS blocked_count,
          MIN(CASE WHEN n.status = 'pending' THEN n.created_at END)
            AS oldest_pending_at
        FROM notification_outbox n
        INNER JOIN incidents i ON i.incident_id = n.incident_id
        WHERE i.site_id = ?1 AND i.environment = ?2
      `,
    )
    .bind(scope.siteId, scope.environment)
    .first<OutboxRow>();
  if (outboxRow === null) unavailable("operability_outbox_read_failed");
  const total = finiteInteger(
    outboxRow.total_count,
    "operability_outbox_invalid",
  );
  const pending = finiteInteger(
    outboxRow.pending_count,
    "operability_outbox_invalid",
  );
  const enqueued = finiteInteger(
    outboxRow.enqueued_count,
    "operability_outbox_invalid",
  );
  const blocked = finiteInteger(
    outboxRow.blocked_count,
    "operability_outbox_invalid",
  );
  if (pending + enqueued + blocked !== total) {
    unavailable("operability_outbox_invalid");
  }
  const oldestPendingAt = nullableCanonicalIso(
    outboxRow.oldest_pending_at,
    "operability_outbox_invalid",
  );
  if ((pending === 0) !== (oldestPendingAt === null)) {
    unavailable("operability_outbox_invalid");
  }

  const deliveryRow = await database
    .prepare(
      `
        SELECT COUNT(*) AS total_count,
          MAX(d.delivered_at) AS latest_delivered_at
        FROM notification_deliveries d
        INNER JOIN incidents i ON i.incident_id = d.incident_id
        WHERE i.site_id = ?1 AND i.environment = ?2
      `,
    )
    .bind(scope.siteId, scope.environment)
    .first<DeliveryRow>();
  if (deliveryRow === null) unavailable("operability_delivery_read_failed");
  const deliveries = finiteInteger(
    deliveryRow.total_count,
    "operability_delivery_invalid",
  );
  const latestDeliveredAt = nullableCanonicalIso(
    deliveryRow.latest_delivered_at,
    "operability_delivery_invalid",
  );
  if ((deliveries === 0) !== (latestDeliveredAt === null)) {
    unavailable("operability_delivery_invalid");
  }
  return {
    outbox: { pending, enqueued, blocked, oldestPendingAt },
    deliveries: {
      total: deliveries,
      latestDeliveredAt,
    },
  };
}

async function readDeployment(
  database: ReadOnlyD1DatabasePort,
  scope: { siteId: string; environment: Environment },
  nowMs: number,
): Promise<CanonicalOperabilitySnapshotV1["deployment"]> {
  const identityRow = await database
    .prepare(
      `
        SELECT identity_id, schema_version, site_id, environment, commit_sha,
          worker_version_id, evidence_digest, source_observation_id,
          policy_version, observed_at, valid_until
        FROM deployment_runtime_identities
        WHERE site_id = ?1 AND environment = ?2
        ORDER BY observed_at DESC, identity_id DESC
        LIMIT 1
      `,
    )
    .bind(scope.siteId, scope.environment)
    .first<RuntimeIdentityRow>();
  let identity: CanonicalOperabilitySnapshotV1["deployment"]["identity"] = {
    state: "missing",
  };
  if (identityRow !== null) {
    const candidate = {
      schemaVersion: identityRow.schema_version,
      identityId: identityRow.identity_id,
      siteId: identityRow.site_id,
      environment: identityRow.environment,
      commitSha: identityRow.commit_sha,
      workerVersionId: identityRow.worker_version_id,
      evidenceDigest: identityRow.evidence_digest,
      sourceObservationId: identityRow.source_observation_id,
      policyVersion: identityRow.policy_version,
      observedAt: identityRow.observed_at,
      validUntil: identityRow.valid_until,
    } as DeploymentRuntimeIdentity;
    try {
      validateDeploymentRuntimeIdentity(candidate);
    } catch {
      unavailable("operability_deployment_identity_invalid");
    }
    if (
      candidate.siteId !== scope.siteId ||
      candidate.environment !== scope.environment
    ) {
      unavailable("operability_deployment_identity_invalid");
    }
    identity = {
      state:
        Date.parse(candidate.observedAt) <= nowMs + 30_000 &&
        Date.parse(candidate.validUntil) > nowMs
          ? "fresh"
          : "stale",
      identityId: candidate.identityId,
      commitSha: candidate.commitSha,
      workerVersionId: candidate.workerVersionId,
      policyVersion: candidate.policyVersion,
      observedAt: candidate.observedAt,
      validUntil: candidate.validUntil,
    };
  }

  const postDeployRow = await database
    .prepare(
      `
        SELECT p.request_id, p.request_digest, p.site_id, p.environment,
          p.commit_sha, p.worker_version_id, p.evidence_digest,
          p.requested_at, p.status, p.reason_code, p.checked_at,
          p.created_at, p.updated_at,
          COUNT(r.request_id) AS receipt_count,
          MIN(r.recorded_at) AS receipt_recorded_at
        FROM post_deploy_requests p
        LEFT JOIN post_deploy_receipts r ON r.request_id = p.request_id
        WHERE p.site_id = ?1 AND p.environment = ?2
        GROUP BY p.request_id
        ORDER BY p.requested_at DESC, p.request_id DESC
        LIMIT 1
      `,
    )
    .bind(scope.siteId, scope.environment)
    .first<PostDeployRow>();
  let postDeploy: CanonicalOperabilitySnapshotV1["deployment"]["postDeploy"] =
    null;
  if (postDeployRow !== null) {
    const status =
      postDeployRow.status === "claimed" ||
      postDeployRow.status === "pass" ||
      postDeployRow.status === "fail" ||
      postDeployRow.status === "unknown"
        ? postDeployRow.status
        : unavailable("operability_post_deploy_invalid");
    const requestedAt = finiteInteger(
      postDeployRow.requested_at,
      "operability_post_deploy_invalid",
    );
    const checkedAt =
      postDeployRow.checked_at === null
        ? null
        : finiteInteger(
            postDeployRow.checked_at,
            "operability_post_deploy_invalid",
          );
    const reasonCode =
      postDeployRow.reason_code === null
        ? null
        : identifier(
            postDeployRow.reason_code,
            "operability_post_deploy_invalid",
          );
    const createdAt = finiteInteger(
      postDeployRow.created_at,
      "operability_post_deploy_invalid",
    );
    const updatedAt = finiteInteger(
      postDeployRow.updated_at,
      "operability_post_deploy_invalid",
    );
    const receiptCount = finiteInteger(
      postDeployRow.receipt_count,
      "operability_post_deploy_invalid",
    );
    const receiptRecordedAt =
      postDeployRow.receipt_recorded_at === null
        ? null
        : finiteInteger(
            postDeployRow.receipt_recorded_at,
            "operability_post_deploy_invalid",
          );
    if (
      typeof postDeployRow.request_id !== "string" ||
      !/^site-deploy-[0-9]{1,32}-[0-9]{1,8}$/u.test(
        postDeployRow.request_id,
      ) ||
      postDeployRow.site_id !== scope.siteId ||
      postDeployRow.environment !== scope.environment ||
      typeof postDeployRow.commit_sha !== "string" ||
      !/^[a-f0-9]{40}$/u.test(postDeployRow.commit_sha) ||
      typeof postDeployRow.request_digest !== "string" ||
      !/^[a-f0-9]{64}$/u.test(postDeployRow.request_digest) ||
      typeof postDeployRow.evidence_digest !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(postDeployRow.evidence_digest) ||
      typeof postDeployRow.worker_version_id !== "string" ||
      !/^[A-Za-z0-9_.:-]{1,128}$/u.test(
        postDeployRow.worker_version_id,
      ) ||
      (status === "claimed" &&
        (reasonCode !== null ||
          checkedAt !== null ||
          receiptCount !== 0 ||
          receiptRecordedAt !== null ||
          updatedAt !== createdAt)) ||
      (status !== "claimed" &&
        (reasonCode === null ||
          checkedAt === null ||
          checkedAt < requestedAt ||
          checkedAt !== updatedAt)) ||
      (status === "pass" &&
        (receiptCount !== 1 || receiptRecordedAt !== checkedAt)) ||
      (status !== "pass" &&
        (receiptCount !== 0 || receiptRecordedAt !== null))
    ) {
      unavailable("operability_post_deploy_invalid");
    }
    const canonicalRequest = stableJson({
      schema: "site-deploy-post-deploy-v1",
      event: "site_deploy.post_deploy_requested",
      requestId: postDeployRow.request_id,
      siteId: scope.siteId,
      environment: scope.environment,
      commitSha: postDeployRow.commit_sha,
      workerVersionId: postDeployRow.worker_version_id,
      evidenceDigest: postDeployRow.evidence_digest,
      requestedAt,
    });
    if (
      (await sha256Hex(new TextEncoder().encode(canonicalRequest))) !==
      postDeployRow.request_digest
    ) {
      unavailable("operability_post_deploy_invalid");
    }
    postDeploy = {
      status,
      reasonCode:
        status === "claimed"
          ? "post_deploy_check_pending"
          : status === "pass"
            ? "post_deploy_checks_passed"
            : status === "fail"
              ? "post_deploy_checks_failed"
              : "post_deploy_checks_unknown",
      commitSha: postDeployRow.commit_sha,
      workerVersionId: postDeployRow.worker_version_id,
      requestedAt,
      checkedAt,
    };
  }
  return { identity, postDeploy };
}

async function readScheduler(
  database: ReadOnlyD1DatabasePort,
  scope: { siteId: string; environment: Environment },
  nowMs: number,
): Promise<CanonicalOperabilitySnapshotV1["scheduler"]> {
  const rows = await all<SchedulerRow>(
    database,
    `
      WITH latest AS (
        SELECT MAX(observed_at) AS observed_at
        FROM observations
        WHERE site_id = ?1
          AND environment = ?2
          AND component = 'autoguard_control_plane'
          AND check_id = ?3
          AND source = 'autoguard_self'
          AND scope = ?4
      )
      SELECT observation_id, schema_version, site_id, environment, component,
        check_id, status, reason_code, observed_at, valid_until, source, scope,
        evidence_id, correlation_id, idempotency_key
      FROM observations
      WHERE site_id = ?1
        AND environment = ?2
        AND component = 'autoguard_control_plane'
        AND check_id = ?3
        AND source = 'autoguard_self'
        AND scope = ?4
        AND observed_at = (SELECT observed_at FROM latest)
      ORDER BY observation_id
      LIMIT 3
    `,
    [scope.siteId, scope.environment, heartbeatCheckId, heartbeatScope],
    "operability_scheduler_read_failed",
  );
  if (rows.length === 0) {
    return {
      state: "missing",
      reasonCode: "scheduler_heartbeat_missing",
      observedAt: null,
      validUntil: null,
    };
  }
  if (rows.length !== 1) unavailable("operability_scheduler_invalid");
  const row = rows[0]!;
  const observedAt = canonicalIso(
    row.observed_at,
    "operability_scheduler_invalid",
  );
  const validUntil = canonicalIso(
    row.valid_until,
    "operability_scheduler_invalid",
  );
  const status =
    row.status === "pass" || row.status === "unknown"
      ? row.status
      : unavailable("operability_scheduler_invalid");
  const reasonCode = identifier(
    row.reason_code,
    "operability_scheduler_invalid",
  );
  if (
    row.schema_version !== 1 ||
    typeof row.observation_id !== "string" ||
    !/^obs_[a-f0-9]{32}$/u.test(row.observation_id) ||
    row.site_id !== scope.siteId ||
    row.environment !== scope.environment ||
    row.component !== "autoguard_control_plane" ||
    row.check_id !== heartbeatCheckId ||
    row.source !== "autoguard_self" ||
    row.scope !== heartbeatScope ||
    typeof row.evidence_id !== "string" ||
    !/^ev_[a-f0-9]{32}$/u.test(row.evidence_id) ||
    typeof row.correlation_id !== "string" ||
    !/^scheduled-[0-9]{1,32}$/u.test(row.correlation_id) ||
    typeof row.idempotency_key !== "string" ||
    !row.idempotency_key.endsWith(`:${heartbeatCheckId}`) ||
    Date.parse(validUntil) <= Date.parse(observedAt) ||
    Date.parse(validUntil) - Date.parse(observedAt) >
      heartbeatMaximumValidityMs ||
    Date.parse(observedAt) > nowMs + 30_000
  ) {
    unavailable("operability_scheduler_invalid");
  }
  const fresh = Date.parse(validUntil) > nowMs;
  const freshPass =
    fresh &&
    status === "pass" &&
    reasonCode === "scheduled_cycle_persisted";
  return {
    state: !fresh
      ? "stale"
      : freshPass
        ? "fresh_pass"
        : "fresh_unknown",
    reasonCode: freshPass
      ? "scheduled_cycle_persisted"
      : fresh
        ? "scheduler_heartbeat_unknown"
        : "scheduler_heartbeat_stale",
    observedAt,
    validUntil,
  };
}

function validCredentialPair(
  token: string | undefined,
  secret: string | undefined,
): boolean {
  return (
    typeof token === "string" &&
    token.length >= 16 &&
    token.length <= 4_096 &&
    !/[\r\n]/u.test(token) &&
    typeof secret === "string" &&
    new TextEncoder().encode(secret).byteLength >= 32 &&
    new TextEncoder().encode(secret).byteLength <= 4_096
  );
}

function validConsoleAuthentication(bindings: GuardReadBindings): boolean {
  const audience = bindings.CONSOLE_ACCESS_AUDIENCE;
  if (
    typeof audience !== "string" ||
    audience.length < 1 ||
    audience.length > 512 ||
    /[\s\r\n,]/u.test(audience)
  ) {
    return false;
  }
  if (
    bindings.CONSOLE_AUTH_MODE === "sites-private" ||
    bindings.CONSOLE_AUTH_MODE === "local-development"
  ) {
    return true;
  }
  if (bindings.CONSOLE_AUTH_MODE !== "cloudflare-access") return false;
  try {
    const issuer = new URL(bindings.CONSOLE_ACCESS_ISSUER ?? "");
    return (
      issuer.protocol === "https:" &&
      issuer.username === "" &&
      issuer.password === "" &&
      issuer.port === "" &&
      issuer.search === "" &&
      issuer.hash === "" &&
      issuer.pathname.replace(/\/+$/u, "") === "" &&
      issuer.hostname.endsWith(".cloudflareaccess.com")
    );
  } catch {
    return false;
  }
}

async function validEvidenceStorage(
  bindings: GuardReadBindings,
): Promise<boolean> {
  if (
    typeof bindings.EVIDENCE_BUCKET !== "object" ||
    bindings.EVIDENCE_BUCKET === null ||
    typeof bindings.EVIDENCE_BUCKET.head !== "function"
  ) {
    return false;
  }
  try {
    await bindings.EVIDENCE_BUCKET.head(
      "__cloudflare_guard_readiness_probe__",
    );
    return true;
  } catch {
    return false;
  }
}

function validCmsCredentials(bindings: GuardReadBindings): boolean {
  const gate = validCredentialPair(
    bindings.CMS_GATE_SERVICE_TOKEN,
    bindings.CMS_GATE_SIGNING_SECRET,
  );
  const signalDedicated =
    bindings.CMS_SIGNAL_SERVICE_TOKEN !== undefined ||
    bindings.CMS_SIGNAL_SIGNING_SECRET !== undefined;
  const signal = signalDedicated
    ? validCredentialPair(
        bindings.CMS_SIGNAL_SERVICE_TOKEN,
        bindings.CMS_SIGNAL_SIGNING_SECRET,
      )
    : gate;
  const maintenanceDedicated =
    bindings.CMS_MAINTENANCE_SERVICE_TOKEN !== undefined ||
    bindings.CMS_MAINTENANCE_SIGNING_SECRET !== undefined;
  const maintenance = maintenanceDedicated
    ? validCredentialPair(
        bindings.CMS_MAINTENANCE_SERVICE_TOKEN,
        bindings.CMS_MAINTENANCE_SIGNING_SECRET,
      )
    : gate;
  return (
    gate &&
    signal &&
    maintenance &&
    validCredentialPair(
      bindings.CMS_POST_DEPLOY_SERVICE_TOKEN,
      bindings.CMS_POST_DEPLOY_SIGNING_SECRET,
    )
  );
}

function validNotificationPath(bindings: GuardReadBindings): boolean {
  if (
    bindings.NOTIFICATION_QUEUE_NAME !== expectedQueueName ||
    typeof bindings.NOTIFICATION_QUEUE !== "object" ||
    bindings.NOTIFICATION_QUEUE === null ||
    typeof bindings.NOTIFICATION_QUEUE.send !== "function"
  ) {
    return false;
  }
  try {
    return (
      createHttpNotificationProvider({
        enabled: bindings.NOTIFICATION_PROVIDER_ENABLED,
        endpoint: bindings.NOTIFICATION_PROVIDER_ENDPOINT,
        token: bindings.NOTIFICATION_PROVIDER_TOKEN,
      }) !== null
    );
  } catch {
    return false;
  }
}

function validScheduledManifest(
  scope: { siteId: string; environment: Environment },
): boolean {
  try {
    const manifest = compilePublicDeliveryManifest(
      dfconnectProductionManifest,
    );
    return (
      manifest.siteId === scope.siteId &&
      manifest.environment === scope.environment &&
      manifest.checks.length === 9
    );
  } catch {
    return false;
  }
}

function overallState(
  components: readonly CanonicalComponentProjection[],
  activeIncidents: number,
  activeFreeze: boolean,
): ComponentState {
  if (components.some((item) => item.state === "unhealthy")) {
    return "unhealthy";
  }
  if (activeIncidents > 0) return "unhealthy";
  if (activeFreeze) return "maintenance";
  if (components.some((item) => item.state === "unknown")) return "unknown";
  if (
    components.some(
      (item) =>
        item.state === "degraded" || item.state === "maintenance",
    )
  ) {
    return "degraded";
  }
  return components.length === COMPONENT_CATALOG.length
    ? "healthy"
    : "unknown";
}

export async function loadCanonicalOperabilityFromBindings(
  bindings: GuardReadBindings,
  clock: () => number = Date.now,
): Promise<CanonicalOperabilitySnapshotV1> {
  const nowMs = clock();
  if (!Number.isFinite(nowMs)) unavailable("operability_clock_invalid");
  const scope = runtimeScope(bindings);
  const policy = resolveOperationalPolicySet(
    scope.siteId,
    scope.environment,
  );
  if (!bindings.DB) unavailable("operability_binding_unavailable");
  const database = bindings.DB;
  const evidenceStorageReady = await validEvidenceStorage(bindings);

  let configuredVerdicts: readonly ComponentVerdict[];
  let lastObservedAtByComponent: ReadonlyMap<Component, string>;
  let incidentRead: ActiveIncidentRead;
  let freeze: CanonicalOperabilitySnapshotV1["freeze"];
  let notifications: CanonicalOperabilitySnapshotV1["notifications"];
  let deployment: CanonicalOperabilitySnapshotV1["deployment"];
  let scheduler: CanonicalOperabilitySnapshotV1["scheduler"];
  try {
    [
      configuredVerdicts,
      lastObservedAtByComponent,
      incidentRead,
      freeze,
      notifications,
      deployment,
      scheduler,
    ] = await Promise.all([
      policy === null
        ? Promise.resolve([] as readonly ComponentVerdict[])
        : readOperationalVerdicts(
            database as D1OperationalReadDatabasePort,
            policy,
            { ...scope, nowMs },
          ),
      readLastObservedAtByComponent(database, scope),
      readActiveIncidents(database, scope),
      readFreezes(database, scope, nowMs),
      readNotifications(database, scope),
      readDeployment(database, scope, nowMs),
      readScheduler(database, scope, nowMs),
    ]);
  } catch (error) {
    if (
      error instanceof Error &&
      /^operability_|^operational_/u.test(error.message)
    ) {
      throw error;
    }
    unavailable("operability_read_unavailable");
  }

  const configured = new Map(
    configuredVerdicts.map((verdict) => [verdict.component, verdict]),
  );
  const verdicts = COMPONENT_CATALOG.map(
    (catalogComponent) =>
      configured.get(catalogComponent) ??
      missingComponentVerdict(scope, catalogComponent, nowMs),
  );
  const components: CanonicalComponentProjection[] = verdicts.map(
    (verdict) => {
      const freshUntilMs =
        verdict.freshUntil === null
          ? Number.NaN
          : Date.parse(verdict.freshUntil);
      return {
        component: verdict.component,
        configured: configured.has(verdict.component),
        policyVersion: configured.has(verdict.component)
          ? verdict.policyVersion
          : null,
        state: verdict.state,
        fresh:
          verdict.state !== "unknown" &&
          Number.isFinite(freshUntilMs) &&
          freshUntilMs > nowMs,
        lastObservedAt:
          lastObservedAtByComponent.get(verdict.component) ?? null,
        activeIncidentCount:
          incidentRead.countByComponent.get(verdict.component) ?? 0,
        reasonCodes: [...verdict.reasonCodes],
        observationIds: [...verdict.observationIds],
        evaluatedAt: verdict.evaluatedAt,
        freshUntil: verdict.freshUntil,
      };
    },
  );
  const gates = OPERATION_CATALOG.map((operation) => {
    const gate = evaluateOperationGate({
      ...scope,
      operation,
      verdicts,
      nowMs,
      activeFreeze: freeze.active,
    });
    return {
      operation: gate.operation,
      decision: gate.decision,
      reasonCodes: [...gate.reasonCodes],
      blockedComponents: [...gate.blockedComponents],
      evaluatedAt: gate.evaluatedAt,
      freshUntil: gate.freshUntil,
      freeze: gate.freeze,
    };
  });

  const checks = {
    runtimeScopePolicy: policy === null ? "not_ready" : "ready",
    consoleAuthentication: validConsoleAuthentication(bindings)
      ? "ready"
      : "not_ready",
    databaseSchema: "ready",
    evidenceStorage:
      evidenceStorageReady ? "ready" : "not_ready",
    cmsCredentials: validCmsCredentials(bindings)
      ? "ready"
      : "not_ready",
    notificationPath: validNotificationPath(bindings)
      ? "ready"
      : "not_ready",
    scheduledManifest: validScheduledManifest(scope)
      ? "ready"
      : "not_ready",
    schedulerHeartbeat:
      scheduler.state === "fresh_pass" ? "ready" : "not_ready",
  } as const;
  const readinessStatus = Object.values(checks).every(
    (state) => state === "ready",
  )
    ? "ready"
    : "not_ready";

  return {
    schema: "guard-operability-v1",
    ...scope,
    generatedAt: new Date(nowMs).toISOString(),
    overall: overallState(
      components,
      incidentRead.projection.active,
      freeze.active,
    ),
    components,
    gates,
    incidents: incidentRead.projection,
    notifications,
    deployment,
    freeze,
    scheduler,
    readiness: {
      status: readinessStatus,
      checks,
    },
  };
}
