import { ContractError } from "../contracts/ops-signal.ts";
import type {
  NotificationProviderPort,
  NotificationProviderResponse,
} from "./notification-delivery.ts";

export type HttpNotificationFetchPort = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface HttpNotificationProviderConfig {
  enabled: string | undefined;
  endpoint: string | undefined;
  token: string | undefined;
  fetcher?: HttpNotificationFetchPort;
  timeoutSignal?(milliseconds: number): AbortSignal;
}

function invalid(): never {
  throw new ContractError("notification_provider_config_invalid");
}

function dnsHostname(hostname: string): boolean {
  if (
    hostname.length < 4 ||
    hostname.length > 253 ||
    !hostname.includes(".") ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost")
  ) {
    return false;
  }
  const labels = hostname.split(".");
  if (!/[a-z]/u.test(labels.at(-1) ?? "")) return false;
  return labels.every(
    (label) =>
      label.length >= 1 &&
      label.length <= 63 &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
  );
}

function providerEndpoint(value: string | undefined): string {
  if (
    value === undefined ||
    value.length < 1 ||
    value.length > 2_048 ||
    /[\r\n]/u.test(value)
  ) {
    invalid();
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid();
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.port !== "" ||
    !dnsHostname(hostname)
  ) {
    invalid();
  }
  return url.toString();
}

function providerToken(value: string | undefined): string {
  if (
    value === undefined ||
    value.length < 16 ||
    value.length > 4_096 ||
    /[\r\n]/u.test(value)
  ) {
    invalid();
  }
  return value;
}

function numericRetryAfter(headers: Headers): number | undefined {
  const value = headers.get("retry-after");
  if (value === null || !/^[0-9]{1,9}$/u.test(value)) {
    return undefined;
  }
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) ? seconds : undefined;
}

export function createHttpNotificationProvider(
  config: HttpNotificationProviderConfig,
): NotificationProviderPort | null {
  if (config.enabled !== "true") return null;
  const endpoint = providerEndpoint(config.endpoint);
  const token = providerToken(config.token);
  const fetcher = config.fetcher ?? fetch;
  const timeoutSignal =
    config.timeoutSignal ??
    ((milliseconds: number) => AbortSignal.timeout(milliseconds));

  return {
    async send(request): Promise<NotificationProviderResponse> {
      if (
        request.contentType !== "application/json" ||
        request.timeoutMs !== 5_000 ||
        request.body.length < 2 ||
        request.body.length > 64 * 1_024 ||
        request.idempotencyKey.length < 1 ||
        request.idempotencyKey.length > 180 ||
        /[\r\n]/u.test(request.idempotencyKey)
      ) {
        throw new ContractError("notification_provider_request_invalid");
      }
      const response = await fetcher(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "idempotency-key": request.idempotencyKey,
        },
        body: request.body,
        redirect: "manual",
        credentials: "omit",
        cache: "no-store",
        signal: timeoutSignal(request.timeoutMs),
      });
      const retryAfterSeconds = numericRetryAfter(response.headers);
      return retryAfterSeconds === undefined
        ? { status: response.status }
        : { status: response.status, retryAfterSeconds };
    },
  };
}
