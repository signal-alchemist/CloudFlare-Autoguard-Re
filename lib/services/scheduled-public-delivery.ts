import { dfconnectProductionManifest } from "../../config/sites/dfconnect.production.ts";
import {
  compilePublicDeliveryManifest,
  runPublicDeliveryCheck,
  type CloudflareWorkerPublicDeliveryProbePorts,
  type PublicDeliveryCheck,
  type PublicDeliveryManifest,
} from "../probes/public-delivery.ts";
import {
  D1ObservationRepository,
  type D1DatabasePort,
} from "../repositories/observations.ts";
import { sha256Hex } from "../security/safe-output.ts";
import {
  stableJson,
  type Environment,
  type Observation,
  type ObservationStatus,
} from "../contracts/ops-signal.ts";

export const SCHEDULED_PUBLIC_DELIVERY_CRON = "* * * * *";
export const SCHEDULED_PUBLIC_DELIVERY_MAX_CONCURRENCY = 4;

const expectedSiteId = "dfconnect";
const expectedEnvironment = "production";
const heartbeatCheckId = "guard.scheduler.public_delivery";
const heartbeatScope =
  "scheduled:dfconnect:production:public-delivery";
const scheduledAuditContext = {
  actorId: "scheduled-public-producer",
  policyVersion: "dfconnect-public-delivery-v1",
} as const;

export interface RunDfconnectScheduledPublicDeliveryInput {
  database: D1DatabasePort;
  ports: CloudflareWorkerPublicDeliveryProbePorts;
  scheduledTime: number;
  cron: string;
  configuredSiteId: string | undefined;
  configuredEnvironment: Environment | undefined;
  receivedAt: string;
}

export interface RunDfconnectScheduledPublicDeliveryResult {
  correlationId: string;
  targetObservations: readonly Observation[];
  heartbeat: Observation;
}

function canonicalScheduledTime(value: number): string {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("scheduled_time_invalid");
  }
  try {
    return new Date(value).toISOString();
  } catch {
    throw new Error("scheduled_time_invalid");
  }
}

function runCorrelationId(scheduledTime: number): string {
  return `scheduled-${scheduledTime}`;
}

function targetIdempotencyKey(
  scheduledTime: number,
  checkId: string,
): string {
  return (
    `scheduled:${expectedSiteId}:${expectedEnvironment}:` +
    `${scheduledTime}:${checkId}`
  );
}

function heartbeatIdempotencyKey(scheduledTime: number): string {
  return targetIdempotencyKey(scheduledTime, heartbeatCheckId);
}

async function digest(value: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(value));
}

async function normalizeScheduledObservation(
  observation: Observation,
  scheduledTime: number,
  correlationId: string,
): Promise<Observation> {
  const idempotencyKey = targetIdempotencyKey(
    scheduledTime,
    observation.checkId,
  );
  const identity = await digest(`observation:${idempotencyKey}`);
  return {
    ...observation,
    observationId: `obs_${identity.slice(0, 32)}`,
    correlationId,
    idempotencyKey,
  };
}

async function validateExistingTargetObservation(
  observation: Observation,
  check: PublicDeliveryCheck,
  scheduledTime: number,
  correlationId: string,
): Promise<void> {
  const idempotencyKey = targetIdempotencyKey(
    scheduledTime,
    check.checkId,
  );
  const identity = await digest(`observation:${idempotencyKey}`);
  const target = new URL(check.url);
  if (
    observation.schemaVersion !== 1 ||
    observation.observationId !== `obs_${identity.slice(0, 32)}` ||
    observation.siteId !== expectedSiteId ||
    observation.environment !== expectedEnvironment ||
    observation.component !== "public_delivery" ||
    observation.checkId !== check.checkId ||
    observation.observedAt !== canonicalScheduledTime(scheduledTime) ||
    observation.validUntil !==
      canonicalScheduledTime(
        scheduledTime + check.validForSeconds * 1_000,
      ) ||
    observation.source !== "public_probe" ||
    observation.scope !== `${target.origin}${target.pathname}` ||
    observation.correlationId !== correlationId ||
    observation.idempotencyKey !== idempotencyKey ||
    !/^ev_[a-f0-9]{32}$/u.test(observation.evidenceId) ||
    !/^[A-Za-z0-9_.:-]{1,128}$/u.test(observation.reasonCode) ||
    (check.kind !== "dns" && observation.status === "pass")
  ) {
    throw new Error("scheduled_observation_conflict");
  }
}

async function heartbeatObservation(
  scheduledTime: number,
  status: Extract<ObservationStatus, "pass" | "unknown">,
  reasonCode: string,
): Promise<Observation> {
  const idempotencyKey = heartbeatIdempotencyKey(scheduledTime);
  const observationDigest = await digest(
    `observation:${idempotencyKey}`,
  );
  const evidenceDigest = await digest(
    `evidence:${idempotencyKey}:${status}:${reasonCode}`,
  );
  return {
    schemaVersion: 1,
    observationId: `obs_${observationDigest.slice(0, 32)}`,
    siteId: expectedSiteId,
    environment: expectedEnvironment,
    component: "autoguard_control_plane",
    checkId: heartbeatCheckId,
    status,
    reasonCode,
    observedAt: canonicalScheduledTime(scheduledTime),
    validUntil: canonicalScheduledTime(scheduledTime + 180_000),
    source: "autoguard_self",
    scope: heartbeatScope,
    evidenceId: `ev_${evidenceDigest.slice(0, 32)}`,
    correlationId: runCorrelationId(scheduledTime),
    idempotencyKey,
  };
}

async function persistHeartbeat(
  repository: D1ObservationRepository,
  input: RunDfconnectScheduledPublicDeliveryInput,
  status: Extract<ObservationStatus, "pass" | "unknown">,
  reasonCode: string,
): Promise<Observation> {
  const candidate = await heartbeatObservation(
    input.scheduledTime,
    status,
    reasonCode,
  );
  const existing = await repository.findByIdempotencyKey(
    candidate.idempotencyKey,
  );
  if (existing) {
    if (stableJson(existing) !== stableJson(candidate)) {
      throw new Error("scheduled_heartbeat_conflict");
    }
    return existing;
  }
  return (await repository.record(candidate, input.receivedAt)).observation;
}

async function compileReviewedManifest(
  repository: D1ObservationRepository,
  input: RunDfconnectScheduledPublicDeliveryInput,
): Promise<PublicDeliveryManifest> {
  try {
    return compilePublicDeliveryManifest(
      dfconnectProductionManifest,
    );
  } catch {
    await persistHeartbeat(
      repository,
      input,
      "unknown",
      "scheduled_manifest_invalid",
    );
    throw new Error("scheduled_manifest_invalid");
  }
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  maximumConcurrency: number,
  operation: (value: T, index: number) => Promise<R>,
): Promise<{
  results: Array<R | undefined>;
  errors: unknown[];
}> {
  const results: Array<R | undefined> = Array.from({
    length: values.length,
  });
  const errors: unknown[] = [];
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = await operation(values[index]!, index);
      } catch (error) {
        errors.push(error);
      }
    }
  }
  await Promise.all(
    Array.from(
      {
        length: Math.min(maximumConcurrency, values.length),
      },
      () => worker(),
    ),
  );
  return { results, errors };
}

async function observeAndPersist(
  manifest: PublicDeliveryManifest,
  check: PublicDeliveryCheck,
  repository: D1ObservationRepository,
  input: RunDfconnectScheduledPublicDeliveryInput,
  correlationId: string,
): Promise<Observation> {
  const idempotencyKey = targetIdempotencyKey(
    input.scheduledTime,
    check.checkId,
  );
  const existing = await repository.findByIdempotencyKey(idempotencyKey);
  if (existing) {
    await validateExistingTargetObservation(
      existing,
      check,
      input.scheduledTime,
      correlationId,
    );
    return existing;
  }
  const result = await runPublicDeliveryCheck({
    manifest,
    selection: {
      siteId: expectedSiteId,
      environment: expectedEnvironment,
      checkId: check.checkId,
    },
    ports: input.ports,
    now: input.scheduledTime,
    correlationId,
  });
  const observation = await normalizeScheduledObservation(
    result.observation,
    input.scheduledTime,
    correlationId,
  );
  return (await repository.record(observation, input.receivedAt)).observation;
}

export async function runDfconnectScheduledPublicDelivery(
  input: RunDfconnectScheduledPublicDeliveryInput,
): Promise<RunDfconnectScheduledPublicDeliveryResult> {
  canonicalScheduledTime(input.scheduledTime);
  const repository = new D1ObservationRepository(
    input.database,
    scheduledAuditContext,
  );
  const manifest = await compileReviewedManifest(repository, input);
  if (
    input.cron !== SCHEDULED_PUBLIC_DELIVERY_CRON ||
    input.configuredSiteId !== expectedSiteId ||
    input.configuredEnvironment !== expectedEnvironment ||
    manifest.siteId !== expectedSiteId ||
    manifest.environment !== expectedEnvironment
  ) {
    await persistHeartbeat(
      repository,
      input,
      "unknown",
      "scheduled_configuration_invalid",
    );
    throw new Error("scheduled_configuration_invalid");
  }

  const correlationId = runCorrelationId(input.scheduledTime);
  const attempted = await mapWithConcurrency(
    manifest.checks,
    SCHEDULED_PUBLIC_DELIVERY_MAX_CONCURRENCY,
    (check) =>
      observeAndPersist(
        manifest,
        check,
        repository,
        input,
        correlationId,
      ),
  );
  if (
    attempted.errors.length > 0 ||
    attempted.results.some((result) => result === undefined)
  ) {
    try {
      await persistHeartbeat(
        repository,
        input,
        "unknown",
        "scheduled_cycle_incomplete",
      );
    } catch {
      // A failed D1 binding cannot persist its own outage. The handler still
      // rejects so the missing heartbeat remains externally detectable.
    }
    throw new Error("scheduled_cycle_incomplete");
  }

  const heartbeat = await persistHeartbeat(
    repository,
    input,
    "pass",
    "scheduled_cycle_persisted",
  );
  return {
    correlationId,
    targetObservations:
      attempted.results as readonly Observation[],
    heartbeat,
  };
}
