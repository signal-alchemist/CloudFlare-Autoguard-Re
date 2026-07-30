import { compileNotificationDelivery } from "../contracts/notifications.ts";

export interface NotificationDeliveryMarker {
  deliveryKey: string;
  incidentId: string;
  payloadDigest: string;
  providerCode: string;
  deliveredAt: string;
  correlationId: string;
}

export interface NotificationDeliveryRepository {
  find(deliveryKey: string): Promise<NotificationDeliveryMarker | null>;
  record(
    marker: NotificationDeliveryMarker,
  ): Promise<NotificationDeliveryMarker>;
}

export interface NotificationProviderRequest {
  body: string;
  contentType: "application/json";
  idempotencyKey: string;
  timeoutMs: 5_000;
}

export interface NotificationProviderResponse {
  status: number;
  retryAfter?: string;
}

export interface NotificationProviderPort {
  send(
    request: NotificationProviderRequest,
  ): Promise<NotificationProviderResponse>;
}

export interface QueueMessagePort {
  body: unknown;
  attempts: number;
  ack(): void;
  retry(options: { delaySeconds: number }): void;
}

export interface NotificationDeliveryDependencies {
  provider: NotificationProviderPort;
  repository: NotificationDeliveryRepository;
  clock(): number;
}

export interface NotificationDeliveryOutcome {
  status:
    | "delivered"
    | "already_delivered"
    | "retry_scheduled"
    | "poison_retry_scheduled";
  reasonCode:
    | "notification_delivered"
    | "notification_already_delivered"
    | "notification_provider_retryable"
    | "notification_marker_write_failed"
    | "notification_payload_invalid"
    | "notification_idempotency_conflict"
    | "notification_provider_rejected";
  delaySeconds?: number;
}

function exponentialDelay(attempts: number): number {
  const safeAttempts =
    Number.isInteger(attempts) && attempts > 0
      ? Math.min(attempts, 16)
      : 1;
  return Math.min(300, 5 * 2 ** (safeAttempts - 1));
}

function retryAfterSeconds(value: string | undefined): number | null {
  if (value === undefined || !/^[0-9]{1,9}$/u.test(value)) return null;
  return Math.max(1, Math.min(300, Number(value)));
}

function scheduleRetry(
  message: QueueMessagePort,
  reasonCode: NotificationDeliveryOutcome["reasonCode"],
  poison: boolean,
  requestedDelay?: number | null,
): NotificationDeliveryOutcome {
  const delaySeconds =
    requestedDelay ?? exponentialDelay(message.attempts);
  message.retry({ delaySeconds });
  return {
    status: poison ? "poison_retry_scheduled" : "retry_scheduled",
    reasonCode,
    delaySeconds,
  };
}

export async function processNotificationMessage(
  message: QueueMessagePort,
  dependencies: NotificationDeliveryDependencies,
): Promise<NotificationDeliveryOutcome> {
  let compiled;
  try {
    compiled = await compileNotificationDelivery(message.body);
  } catch {
    return scheduleRetry(
      message,
      "notification_payload_invalid",
      true,
    );
  }

  let existing: NotificationDeliveryMarker | null;
  try {
    existing = await dependencies.repository.find(
      compiled.envelope.deliveryKey,
    );
  } catch {
    return scheduleRetry(
      message,
      "notification_marker_write_failed",
      false,
    );
  }
  if (existing) {
    if (existing.payloadDigest !== compiled.payloadDigest) {
      return scheduleRetry(
        message,
        "notification_idempotency_conflict",
        true,
      );
    }
    message.ack();
    return {
      status: "already_delivered",
      reasonCode: "notification_already_delivered",
    };
  }

  let response: NotificationProviderResponse;
  try {
    response = await dependencies.provider.send({
      body: compiled.body,
      contentType: "application/json",
      idempotencyKey: compiled.envelope.deliveryKey,
      timeoutMs: 5_000,
    });
  } catch {
    return scheduleRetry(
      message,
      "notification_provider_retryable",
      false,
    );
  }
  if (
    !Number.isInteger(response.status) ||
    response.status < 100 ||
    response.status > 599
  ) {
    return scheduleRetry(
      message,
      "notification_provider_rejected",
      true,
    );
  }
  if (response.status >= 200 && response.status < 300) {
    const now = dependencies.clock();
    if (!Number.isFinite(now)) {
      return scheduleRetry(
        message,
        "notification_marker_write_failed",
        false,
      );
    }
    try {
      await dependencies.repository.record({
        deliveryKey: compiled.envelope.deliveryKey,
        incidentId: compiled.envelope.incidentId,
        payloadDigest: compiled.payloadDigest,
        providerCode: `http_${response.status}`,
        deliveredAt: new Date(now).toISOString(),
        correlationId: compiled.envelope.correlationId,
      });
    } catch {
      return scheduleRetry(
        message,
        "notification_marker_write_failed",
        false,
      );
    }
    message.ack();
    return {
      status: "delivered",
      reasonCode: "notification_delivered",
    };
  }
  if (response.status === 429 || response.status >= 500) {
    return scheduleRetry(
      message,
      "notification_provider_retryable",
      false,
      response.status === 429
        ? retryAfterSeconds(response.retryAfter)
        : null,
    );
  }
  return scheduleRetry(
    message,
    "notification_provider_rejected",
    true,
  );
}

export async function processNotificationBatch(
  messages: readonly QueueMessagePort[],
  dependencies: NotificationDeliveryDependencies,
): Promise<readonly NotificationDeliveryOutcome[]> {
  const outcomes: NotificationDeliveryOutcome[] = [];
  for (const message of messages) {
    outcomes.push(
      await processNotificationMessage(message, dependencies),
    );
  }
  return outcomes;
}
