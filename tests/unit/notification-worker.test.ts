import assert from "node:assert/strict";
import test from "node:test";

import type { QueueMessagePort } from "../../lib/adapters/notification-delivery.ts";
import type {
  D1DatabasePort,
  D1PreparedStatementPort,
  D1RunResult,
} from "../../lib/repositories/observations.ts";
import {
  consumeConfiguredNotificationBatch,
  type NotificationRuntimeEnv,
} from "../../worker/notification.ts";

class TestMessage implements QueueMessagePort {
  readonly body: unknown;
  readonly attempts = 1;
  ackCount = 0;
  retryCount = 0;

  constructor(body: unknown = {}) {
    this.body = body;
  }

  ack(): void {
    this.ackCount += 1;
  }

  retry(): void {
    this.retryCount += 1;
  }
}

class TestBatch {
  readonly queue: string;
  readonly messages: readonly TestMessage[];
  retryAllDelays: Array<number | undefined> = [];
  ackAllCount = 0;

  constructor(queue: string, messages = [new TestMessage()]) {
    this.queue = queue;
    this.messages = messages;
  }

  retryAll(options?: { delaySeconds?: number }): void {
    this.retryAllDelays.push(options?.delaySeconds);
  }

  ackAll(): void {
    this.ackAllCount += 1;
  }
}

const unusedStatement: D1PreparedStatementPort = {
  bind() {
    return this;
  },
  async first() {
    throw new Error("unexpected_d1_read");
  },
  async run() {
    throw new Error("unexpected_d1_write");
  },
};
const unusedDatabase: D1DatabasePort = {
  prepare() {
    return unusedStatement;
  },
  async batch(): Promise<D1RunResult[]> {
    throw new Error("unexpected_d1_batch");
  },
};

const configuredEnv: NotificationRuntimeEnv = {
  DB: unusedDatabase,
  GUARD_SITE_ID: "dfconnect",
  GUARD_ENVIRONMENT: "production",
  NOTIFICATION_QUEUE_NAME: "cloudflare-guard-notifications",
  NOTIFICATION_PROVIDER_ENABLED: "true",
  NOTIFICATION_PROVIDER_ENDPOINT:
    "https://alerts.example.com/v1/incidents",
  NOTIFICATION_PROVIDER_TOKEN:
    "provider-token-0123456789abcdef",
};

test("missing DB/provider/scope config and wrong batch queue explicitly retry all without provider, ACK, or per-message mutation", async () => {
  const variants: NotificationRuntimeEnv[] = [
    { ...configuredEnv, DB: undefined },
    { ...configuredEnv, GUARD_SITE_ID: undefined },
    { ...configuredEnv, GUARD_ENVIRONMENT: undefined },
    { ...configuredEnv, NOTIFICATION_QUEUE_NAME: undefined },
    {
      ...configuredEnv,
      NOTIFICATION_PROVIDER_ENABLED: undefined,
    },
    {
      ...configuredEnv,
      NOTIFICATION_PROVIDER_ENDPOINT: undefined,
    },
    {
      ...configuredEnv,
      NOTIFICATION_PROVIDER_TOKEN: undefined,
    },
  ];
  let providerCalls = 0;
  for (const env of variants) {
    const batch = new TestBatch("cloudflare-guard-notifications");
    await consumeConfiguredNotificationBatch(batch, env, {
      async fetcher() {
        providerCalls += 1;
        return new Response(null, { status: 204 });
      },
      timeoutSignal: () => new AbortController().signal,
      clock: () => Date.parse("2026-07-31T07:00:00.000Z"),
    });
    assert.deepEqual(batch.retryAllDelays, [5]);
    assert.equal(batch.ackAllCount, 0);
    assert.equal(batch.messages[0]?.ackCount, 0);
    assert.equal(batch.messages[0]?.retryCount, 0);
  }

  const wrongQueue = new TestBatch("cms-contact-notifications");
  await consumeConfiguredNotificationBatch(
    wrongQueue,
    configuredEnv,
    {
      async fetcher() {
        providerCalls += 1;
        return new Response(null, { status: 204 });
      },
      timeoutSignal: () => new AbortController().signal,
      clock: () => Date.parse("2026-07-31T07:00:00.000Z"),
    },
  );
  assert.deepEqual(wrongQueue.retryAllDelays, [5]);
  assert.equal(wrongQueue.messages[0]?.ackCount, 0);
  assert.equal(wrongQueue.messages[0]?.retryCount, 0);
  assert.equal(providerCalls, 0);
});
