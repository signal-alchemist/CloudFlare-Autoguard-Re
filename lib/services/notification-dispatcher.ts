import { compileNotificationDelivery } from "../contracts/notifications.ts";
import {
  NOTIFICATION_DISPATCH_LIMIT,
  NOTIFICATION_OUTBOX_PAYLOAD_INVALID,
  type NotificationOutboxRepository,
  type PendingNotificationOutboxEntry,
} from "../repositories/notification-outbox.ts";

export interface NotificationQueuePort {
  send(
    body: unknown,
    options: { contentType: "json" },
  ): Promise<unknown>;
}

export interface DispatchPendingNotificationsInput {
  repository: NotificationOutboxRepository;
  queue: NotificationQueuePort | undefined;
  clock(): number;
}

export interface DispatchPendingNotificationsResult {
  selected: number;
  enqueued: number;
  blocked: number;
  retainedPending: number;
}

function timestamp(clock: () => number): string {
  const milliseconds = clock();
  if (!Number.isFinite(milliseconds)) {
    throw new Error("notification_dispatch_clock_invalid");
  }
  return new Date(milliseconds).toISOString();
}

async function compileOutboxEntry(
  entry: PendingNotificationOutboxEntry,
  repository: NotificationOutboxRepository,
) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(entry.payloadJson);
  } catch {
    throw new Error("notification_outbox_payload_invalid");
  }
  const compiled = await compileNotificationDelivery(parsed);
  if (
    compiled.body !== entry.payloadJson ||
    compiled.payloadDigest !== entry.payloadDigest ||
    compiled.envelope.incidentId !== entry.incidentId ||
    entry.outboxId !==
      `outbox:${entry.incidentId}:incident_opened` ||
    compiled.envelope.siteId !== repository.scope.siteId ||
    compiled.envelope.environment !== repository.scope.environment
  ) {
    throw new Error("notification_outbox_payload_invalid");
  }
  return compiled;
}

export async function dispatchPendingNotifications(
  input: DispatchPendingNotificationsInput,
): Promise<DispatchPendingNotificationsResult> {
  if (input.queue === undefined) {
    return {
      selected: 0,
      enqueued: 0,
      blocked: 0,
      retainedPending: 0,
    };
  }
  const entries = await input.repository.listPending(
    NOTIFICATION_DISPATCH_LIMIT,
  );
  const result: DispatchPendingNotificationsResult = {
    selected: entries.length,
    enqueued: 0,
    blocked: 0,
    retainedPending: 0,
  };
  for (const entry of entries) {
    if (entry.integrity === "corrupt") {
      try {
        await input.repository.markCorruptBlocked(
          entry,
          NOTIFICATION_OUTBOX_PAYLOAD_INVALID,
          timestamp(input.clock),
        );
        result.blocked += 1;
      } catch {
        result.retainedPending += 1;
      }
      continue;
    }
    let compiled;
    try {
      compiled = await compileOutboxEntry(entry, input.repository);
    } catch {
      try {
        await input.repository.markBlocked(
          entry,
          NOTIFICATION_OUTBOX_PAYLOAD_INVALID,
          timestamp(input.clock),
        );
        result.blocked += 1;
      } catch {
        result.retainedPending += 1;
      }
      continue;
    }
    try {
      await input.queue.send(compiled.envelope, {
        contentType: "json",
      });
    } catch {
      result.retainedPending += 1;
      continue;
    }
    try {
      await input.repository.markEnqueued(
        entry,
        timestamp(input.clock),
      );
      result.enqueued += 1;
    } catch {
      result.retainedPending += 1;
    }
  }
  return result;
}
