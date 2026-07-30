import { ContractError } from "../contracts/ops-signal.ts";
import type {
  NotificationDeliveryMarker,
  NotificationDeliveryRepository,
} from "../adapters/notification-delivery.ts";
import type { D1DatabasePort } from "./observations.ts";

interface NotificationDeliveryRow {
  delivery_key: string;
  incident_id: string;
  payload_digest: string;
  provider_code: string;
  delivered_at: string;
  correlation_id: string;
}

function invalid(code: string): never {
  throw new ContractError(code);
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

function validateMarker(
  marker: NotificationDeliveryMarker,
): NotificationDeliveryMarker {
  identifier(
    marker.deliveryKey,
    "notification_delivery_key_invalid",
  );
  if (!/^inc_[a-f0-9]{32}$/u.test(marker.incidentId)) {
    invalid("notification_incident_id_invalid");
  }
  if (!/^[a-f0-9]{64}$/u.test(marker.payloadDigest)) {
    invalid("notification_payload_digest_invalid");
  }
  if (!/^http_[2-5][0-9]{2}$/u.test(marker.providerCode)) {
    invalid("notification_provider_code_invalid");
  }
  const deliveredAt = Date.parse(marker.deliveredAt);
  if (
    !Number.isFinite(deliveredAt) ||
    new Date(deliveredAt).toISOString() !== marker.deliveredAt
  ) {
    invalid("notification_delivered_at_invalid");
  }
  identifier(
    marker.correlationId,
    "notification_correlation_id_invalid",
  );
  return marker;
}

function fromRow(
  row: NotificationDeliveryRow,
): NotificationDeliveryMarker {
  return {
    deliveryKey: row.delivery_key,
    incidentId: row.incident_id,
    payloadDigest: row.payload_digest,
    providerCode: row.provider_code,
    deliveredAt: row.delivered_at,
    correlationId: row.correlation_id,
  };
}

export class D1NotificationDeliveryRepository
  implements NotificationDeliveryRepository
{
  readonly database: D1DatabasePort;

  constructor(database: D1DatabasePort) {
    this.database = database;
  }

  async find(
    deliveryKey: string,
  ): Promise<NotificationDeliveryMarker | null> {
    identifier(deliveryKey, "notification_delivery_key_invalid");
    const row = await this.database
      .prepare(
        `
          SELECT delivery_key, incident_id, payload_digest, provider_code,
            delivered_at, correlation_id
          FROM notification_deliveries
          WHERE delivery_key = ?1
          LIMIT 1
        `,
      )
      .bind(deliveryKey)
      .first<NotificationDeliveryRow>();
    return row ? fromRow(row) : null;
  }

  async record(
    input: NotificationDeliveryMarker,
  ): Promise<NotificationDeliveryMarker> {
    const marker = validateMarker(input);
    await this.database
      .prepare(
        `
          INSERT OR IGNORE INTO notification_deliveries (
            delivery_key, incident_id, payload_digest, provider_code,
            delivered_at, correlation_id
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
        `,
      )
      .bind(
        marker.deliveryKey,
        marker.incidentId,
        marker.payloadDigest,
        marker.providerCode,
        marker.deliveredAt,
        marker.correlationId,
      )
      .run();
    const persisted = await this.find(marker.deliveryKey);
    if (!persisted) throw new Error("notification_marker_write_incomplete");
    if (
      persisted.payloadDigest !== marker.payloadDigest ||
      persisted.incidentId !== marker.incidentId
    ) {
      invalid("notification_idempotency_conflict");
    }
    return persisted;
  }
}
