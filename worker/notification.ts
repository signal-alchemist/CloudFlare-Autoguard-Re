import {
  processNotificationBatch,
  type NotificationDeliveryDependencies,
  type QueueMessagePort,
} from "../lib/adapters/notification-delivery.ts";
import {
  createHttpNotificationProvider,
  type HttpNotificationFetchPort,
} from "../lib/adapters/http-notification-provider.ts";
import type {
  Environment,
} from "../lib/contracts/ops-signal.ts";
import { D1NotificationDeliveryRepository } from "../lib/repositories/notification-deliveries.ts";
import { D1NotificationOutboxRepository } from "../lib/repositories/notification-outbox.ts";
import type {
  D1DatabasePort,
} from "../lib/repositories/observations.ts";
import {
  dispatchPendingNotifications,
  type DispatchPendingNotificationsResult,
  type NotificationQueuePort,
} from "../lib/services/notification-dispatcher.ts";

export interface NotificationMessageBatchPort {
  messages: readonly QueueMessagePort[];
}

export interface ConfiguredNotificationMessageBatchPort
  extends NotificationMessageBatchPort {
  queue: string;
  retryAll(options?: { delaySeconds?: number }): void;
}

export interface NotificationRuntimeEnv {
  DB?: D1DatabasePort;
  GUARD_SITE_ID?: string;
  GUARD_ENVIRONMENT?: Environment;
  NOTIFICATION_QUEUE_NAME?: string;
  NOTIFICATION_PROVIDER_ENABLED?: string;
  NOTIFICATION_PROVIDER_ENDPOINT?: string;
  NOTIFICATION_PROVIDER_TOKEN?: string;
  NOTIFICATION_QUEUE?: NotificationQueuePort;
}

export interface NotificationRuntimePorts {
  fetcher?: HttpNotificationFetchPort;
  timeoutSignal?(milliseconds: number): AbortSignal;
  clock?(): number;
}

const dependencyRetrySeconds = 5;

export async function consumeNotificationBatch(
  batch: NotificationMessageBatchPort,
  dependencies: NotificationDeliveryDependencies,
): Promise<void> {
  await processNotificationBatch(batch.messages, dependencies);
}

function runtimeScope(
  env: NotificationRuntimeEnv,
): { siteId: string; environment: Environment } | null {
  if (
    !env.GUARD_SITE_ID ||
    !/^[a-z][a-z0-9-]{2,63}$/u.test(env.GUARD_SITE_ID) ||
    (env.GUARD_ENVIRONMENT !== "staging" &&
      env.GUARD_ENVIRONMENT !== "production")
  ) {
    return null;
  }
  return {
    siteId: env.GUARD_SITE_ID,
    environment: env.GUARD_ENVIRONMENT,
  };
}

function queueName(value: string | undefined): string | null {
  if (
    value === undefined ||
    value.length < 1 ||
    value.length > 128 ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(value)
  ) {
    return null;
  }
  return value;
}

function retryEntireBatch(
  batch: ConfiguredNotificationMessageBatchPort,
): void {
  batch.retryAll({ delaySeconds: dependencyRetrySeconds });
}

export async function consumeConfiguredNotificationBatch(
  batch: ConfiguredNotificationMessageBatchPort,
  env: NotificationRuntimeEnv,
  ports: NotificationRuntimePorts = {},
): Promise<void> {
  const scope = runtimeScope(env);
  const expectedQueue = queueName(env.NOTIFICATION_QUEUE_NAME);
  if (
    !env.DB ||
    !scope ||
    expectedQueue === null ||
    batch.queue !== expectedQueue
  ) {
    retryEntireBatch(batch);
    return;
  }
  let provider;
  try {
    provider = createHttpNotificationProvider({
      enabled: env.NOTIFICATION_PROVIDER_ENABLED,
      endpoint: env.NOTIFICATION_PROVIDER_ENDPOINT,
      token: env.NOTIFICATION_PROVIDER_TOKEN,
      fetcher: ports.fetcher,
      timeoutSignal: ports.timeoutSignal,
    });
  } catch {
    retryEntireBatch(batch);
    return;
  }
  if (provider === null) {
    retryEntireBatch(batch);
    return;
  }
  const outbox = new D1NotificationOutboxRepository(env.DB, scope);
  await consumeNotificationBatch(batch, {
    provider,
    repository: new D1NotificationDeliveryRepository(env.DB),
    outbox,
    scope,
    clock: ports.clock ?? Date.now,
  });
}

const noDispatch: DispatchPendingNotificationsResult = {
  selected: 0,
  enqueued: 0,
  blocked: 0,
  retainedPending: 0,
};

export async function dispatchConfiguredPendingNotifications(
  env: NotificationRuntimeEnv,
  clock: () => number = Date.now,
): Promise<DispatchPendingNotificationsResult> {
  const scope = runtimeScope(env);
  if (!env.DB || !scope) return { ...noDispatch };
  return dispatchPendingNotifications({
    repository: new D1NotificationOutboxRepository(env.DB, scope),
    queue: env.NOTIFICATION_QUEUE,
    clock,
  });
}
