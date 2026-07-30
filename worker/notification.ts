import {
  processNotificationBatch,
  type NotificationDeliveryDependencies,
  type QueueMessagePort,
} from "../lib/adapters/notification-delivery.ts";

export interface NotificationMessageBatchPort {
  messages: readonly QueueMessagePort[];
}

export async function consumeNotificationBatch(
  batch: NotificationMessageBatchPort,
  dependencies: NotificationDeliveryDependencies,
): Promise<void> {
  await processNotificationBatch(batch.messages, dependencies);
}
