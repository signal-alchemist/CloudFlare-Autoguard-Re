import dns from "node:dns";

import type {
  CloudflareWorkerPublicDeliveryProbePorts,
  PublicDeliveryCapability,
  PublicDeliveryDnsResult,
  PublicDeliveryWorkerExchange,
  PublicDeliveryWorkerExchangeRequest,
  PublicDeliveryWorkerExchangeResult,
} from "../probes/public-delivery.ts";

interface DnsAddressRecord {
  address: string;
  ttl: number;
}

export interface CloudflareWorkerDnsResolver {
  resolve4(hostname: string): Promise<readonly DnsAddressRecord[]>;
  resolve6(hostname: string): Promise<readonly DnsAddressRecord[]>;
}

export interface CloudflareWorkerPublicDeliveryDependencies {
  resolver?: CloudflareWorkerDnsResolver;
  fetcher?(
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response>;
  monotonicClock?(): number;
  timeoutSignal?(timeoutMs: number): AbortSignal;
}

const defaultResolver: CloudflareWorkerDnsResolver = {
  async resolve4(hostname) {
    return dns.promises.resolve4(hostname, { ttl: true });
  },
  async resolve6(hostname) {
    return dns.promises.resolve6(hostname, { ttl: true });
  },
};

function dnsUnavailable(
  reasonCode:
    | "dns_resolution_failed"
    | "dns_response_invalid"
    | "worker_dns_evidence_unavailable",
): PublicDeliveryCapability<PublicDeliveryDnsResult> {
  return { kind: "unavailable", reasonCode };
}

function validDnsRecord(
  value: DnsAddressRecord,
): value is DnsAddressRecord {
  return (
    typeof value.address === "string" &&
    value.address.length > 0 &&
    Number.isInteger(value.ttl) &&
    value.ttl > 0
  );
}

async function resolveHostname(
  resolver: CloudflareWorkerDnsResolver,
  hostname: string,
): Promise<PublicDeliveryCapability<PublicDeliveryDnsResult>> {
  const results = await Promise.allSettled([
    resolver.resolve4(hostname),
    resolver.resolve6(hostname),
  ]);
  const fulfilled = results
    .filter(
      (
        result,
      ): result is PromiseFulfilledResult<
        readonly DnsAddressRecord[]
      > => result.status === "fulfilled",
    )
    .flatMap((result) => result.value);
  if (fulfilled.some((record) => !validDnsRecord(record))) {
    return dnsUnavailable("dns_response_invalid");
  }
  const records = fulfilled.filter(validDnsRecord);
  if (records.length === 0) {
    return dnsUnavailable("dns_resolution_failed");
  }
  const addresses = [...new Set(records.map((record) => record.address))];
  if (addresses.length === 0 || addresses.length > 32) {
    return dnsUnavailable("dns_response_invalid");
  }
  return {
    kind: "observed",
    value: {
      addresses,
      ttlSeconds: Math.min(...records.map((record) => record.ttl)),
    },
  };
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Cancellation is best effort after the bounded result is already known.
  }
}

async function readBoundedBody(
  response: Response,
  maximumBytes: number,
): Promise<{
  body: Uint8Array;
  bodyTooLarge: boolean;
}> {
  if (maximumBytes === 0 || response.body === null) {
    await cancelBody(response);
    return { body: new Uint8Array(), bodyTooLarge: false };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = Uint8Array.from(next.value);
      total += chunk.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        return { body: new Uint8Array(), bodyTooLarge: true };
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body, bodyTooLarge: false };
}

function safeHeaders(
  response: Response,
  requiredHeaders: readonly string[],
): Readonly<Record<string, string>> {
  const headers: Record<string, string> = {};
  for (const name of ["content-type", "location"]) {
    const value = response.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  for (const header of requiredHeaders) {
    const name = header.toLowerCase();
    if (
      name !== "content-type" &&
      name !== "location" &&
      response.headers.has(name)
    ) {
      headers[name] = "present";
    }
  }
  return headers;
}

function timeoutFailure(
  error: unknown,
  signal: AbortSignal,
): boolean {
  if (signal.aborted) return true;
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || error.name === "TimeoutError";
}

async function exchange(
  dependencies: Required<
    Omit<
      CloudflareWorkerPublicDeliveryDependencies,
      "resolver"
    >
  >,
  request: PublicDeliveryWorkerExchangeRequest,
): Promise<PublicDeliveryWorkerExchangeResult> {
  let signal: AbortSignal;
  try {
    signal = dependencies.timeoutSignal(request.timeoutMs);
  } catch {
    return {
      kind: "unavailable",
      reasonCode: "probe_transport_error",
    };
  }
  const startedAt = dependencies.monotonicClock();
  try {
    const response = await dependencies.fetcher(request.url, {
      method: request.method,
      redirect: "manual",
      cache: "no-store",
      credentials: "omit",
      headers: {
        accept: "*/*",
      },
      signal,
    });
    const bounded = await readBoundedBody(
      response,
      request.maxResponseBytes,
    );
    const elapsedMs = Math.max(
      0,
      dependencies.monotonicClock() - startedAt,
    );
    const value: PublicDeliveryWorkerExchange = {
      status: response.status,
      headers: safeHeaders(response, request.requiredHeaders),
      body: bounded.body,
      bodyTooLarge: bounded.bodyTooLarge,
      elapsedMs,
    };
    return { kind: "response", value };
  } catch (error) {
    return {
      kind: "unavailable",
      reasonCode: timeoutFailure(error, signal)
        ? "probe_timeout"
        : "probe_transport_error",
    };
  }
}

export function createCloudflareWorkerPublicDeliveryProbePorts(
  dependencies: CloudflareWorkerPublicDeliveryDependencies = {},
): CloudflareWorkerPublicDeliveryProbePorts {
  const resolver = dependencies.resolver ?? defaultResolver;
  const resolved = new Map<
    string,
    Promise<PublicDeliveryCapability<PublicDeliveryDnsResult>>
  >();
  const runtime = {
    fetcher: dependencies.fetcher ?? fetch,
    monotonicClock:
      dependencies.monotonicClock ?? (() => performance.now()),
    timeoutSignal:
      dependencies.timeoutSignal ??
      ((timeoutMs: number) => AbortSignal.timeout(timeoutMs)),
  };
  return {
    mode: "cloudflare-worker",
    resolve(hostname) {
      const existing = resolved.get(hostname);
      if (existing) return existing;
      const pending = resolveHostname(resolver, hostname);
      resolved.set(hostname, pending);
      return pending;
    },
    exchange(request) {
      return exchange(runtime, request);
    },
  };
}
