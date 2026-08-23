import {
  BERTHOS_GUEST_OS,
  DEFAULT_LEASE_MIN_SECONDS,
  LeaseError,
  billedOccupancySeconds,
  notChargedHere,
  type CreateLeaseInput,
  type EndLeaseInput,
  type LeaseQuote,
  type LeaseRecord,
  type OccupancyReceipt,
} from "../domain/lease.js";
import type { LeaseClient } from "../ports/lease.js";
import { MemoryLeaseClient } from "./memory-lease.js";

export const BERTHOS_LEASES_PATH = "/v1/leases";
export const BERTHOS_PAIR_PATH = "/v1/pair";

export interface HttpBerthosLeaseClientOptions {
  /** Default node URL. Overridden per listing by `fulfillment.berthosUrl`. */
  berthosUrl?: string;
  /** Bearer token with the `lease` capability (`POST /v1/pair` or env). */
  leaseToken?: string;
  /** Optional pairing code. Used once when no token is configured. */
  pairCode?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Calls a Berthos node `POST /v1/leases` and `DELETE /v1/leases/{id}`.
 *
 * Authorization: `Authorization: Bearer <token>` (`lease` capability).
 * Token comes from `BERTHOS_LEASE_TOKEN`, listing `fulfillment.leaseToken`,
 * or a one-shot `POST /v1/pair` when `BERTHOS_PAIR_CODE` is set.
 *
 * Fail-closed on unreachable nodes, 403 ineligible, 409 already-leased,
 * missing token/URL, or a non-linux OS.
 */
export class HttpBerthosLeaseClient implements LeaseClient {
  readonly kind = "http" as const;
  private readonly berthosUrl?: string;
  private token?: string;
  private readonly pairCode?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpBerthosLeaseClientOptions = {}) {
    this.berthosUrl = options.berthosUrl;
    this.token = options.leaseToken;
    this.pairCode = options.pairCode;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async create(input: CreateLeaseInput): Promise<LeaseRecord> {
    if (input.os !== BERTHOS_GUEST_OS) {
      throw new LeaseError(
        "unsupported_os",
        "v1 leases only os=linux; windows and macos are out of scope",
        400,
      );
    }
    const base = this.resolveUrl(input.berthosUrl);
    const token = await this.resolveToken(base, input.token);
    const url = joinPath(base, BERTHOS_LEASES_PATH);
    const response = await this.request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ os: BERTHOS_GUEST_OS }),
    });
    if (response.status === 409) {
      throw new LeaseError("already_leased", await readError(response, "a lease is already live"), 409);
    }
    if (response.status === 403) {
      throw new LeaseError("node_ineligible", await readError(response, "node is ineligible"), 403);
    }
    if (response.status === 401) {
      throw new LeaseError("lease_unauthorized", await readError(response, "missing or invalid lease token"), 401);
    }
    if (!response.ok) {
      throw new LeaseError(
        "lease_create_failed",
        await readError(response, `lease create failed (HTTP ${response.status})`),
        400,
      );
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new LeaseError("lease_invalid_json", "lease create returned invalid JSON", 400);
    }
    const lease = parseLease(body, base);
    if (!lease) {
      throw new LeaseError("lease_invalid_body", "lease create returned an unreadable body", 400);
    }
    return lease;
  }

  async end(input: EndLeaseInput): Promise<OccupancyReceipt> {
    const base = this.resolveUrl(input.berthosUrl);
    const token = await this.resolveToken(base, input.token);
    const url = joinPath(base, `${BERTHOS_LEASES_PATH}/${encodeURIComponent(input.leaseId)}`);
    const response = await this.request(url, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
    if (response.status === 404) {
      throw new LeaseError("lease_not_found", await readError(response, "lease not found"), 404);
    }
    if (response.status === 401) {
      throw new LeaseError("lease_unauthorized", await readError(response, "missing or invalid lease token"), 401);
    }
    if (!response.ok) {
      throw new LeaseError(
        "lease_end_failed",
        await readError(response, `lease end failed (HTTP ${response.status})`),
        400,
      );
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new LeaseError("lease_invalid_json", "lease end returned invalid JSON", 400);
    }
    const receipt = parseOccupancy(body);
    if (!receipt) {
      throw new LeaseError("lease_invalid_body", "lease end returned an unreadable occupancy receipt", 400);
    }
    return receipt;
  }

  private resolveUrl(override?: string): string {
    const base = override || this.berthosUrl;
    if (!base) {
      throw new LeaseError(
        "missing_berthos_url",
        "desktop.linux fulfillment needs BERTHOS_URL or listing.fulfillment.berthosUrl",
        400,
      );
    }
    return base;
  }

  private async resolveToken(base: string, override?: string): Promise<string> {
    if (override) return override;
    if (this.token) return this.token;
    if (this.pairCode) {
      this.token = await this.pair(base, this.pairCode);
      return this.token;
    }
    throw new LeaseError(
      "missing_lease_token",
      "desktop.linux fulfillment needs BERTHOS_LEASE_TOKEN, listing.fulfillment.leaseToken, or BERTHOS_PAIR_CODE",
      400,
    );
  }

  private async pair(base: string, code: string): Promise<string> {
    const url = joinPath(base, BERTHOS_PAIR_PATH);
    const response = await this.request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    if (!response.ok) {
      throw new LeaseError(
        "pair_failed",
        await readError(response, `pairing failed (HTTP ${response.status})`),
        400,
      );
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new LeaseError("pair_invalid_json", "pairing returned invalid JSON", 400);
    }
    const token = asString((body as { token?: unknown }).token);
    if (!token) {
      throw new LeaseError("pair_invalid_body", "pairing response missing token", 400);
    }
    return token;
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, init);
    } catch (error) {
      const message = error instanceof Error ? error.message : "network_error";
      throw new LeaseError("node_unreachable", `node_unreachable:${message}`, 400);
    }
  }
}

export function createLeaseClient(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: typeof fetch,
): LeaseClient {
  const url = env.BERTHOS_URL;
  if (!url) {
    return new MemoryLeaseClient();
  }
  return new HttpBerthosLeaseClient({
    berthosUrl: url,
    leaseToken: env.BERTHOS_LEASE_TOKEN,
    pairCode: env.BERTHOS_PAIR_CODE,
    fetchImpl: fetchImpl ?? fetch,
  });
}

function joinPath(base: string, path: string): string {
  const root = base.endsWith("/") ? base : `${base}/`;
  return new URL(path.replace(/^\//, ""), root).href;
}

function parseLease(body: unknown, berthosUrl: string): LeaseRecord | undefined {
  if (!body || typeof body !== "object") return undefined;
  const raw = body as Record<string, unknown>;
  const id = asString(raw.id) ?? asString((raw.id as { 0?: unknown } | undefined)?.[0]);
  if (!id) return undefined;
  const startedAt = asString(raw.started_at) ?? asString(raw.startedAt) ?? new Date().toISOString();
  const endedAt = asString(raw.ended_at) ?? asString(raw.endedAt);
  const state = asString(raw.state) === "ended" ? "ended" : "live";
  return {
    id,
    state,
    os: BERTHOS_GUEST_OS,
    berthosUrl,
    startedAt,
    endedAt,
    quote: parseQuote(raw.quote),
  };
}

function parseQuote(value: unknown): LeaseQuote {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const minSeconds = asNumber(raw.min_seconds) ?? asNumber(raw.minSeconds) ?? DEFAULT_LEASE_MIN_SECONDS;
  return {
    vcpu: asNumber(raw.vcpu) ?? 2,
    memGib: asNumber(raw.mem_gib) ?? asNumber(raw.memGib) ?? 4,
    diskGib: asNumber(raw.disk_gib) ?? asNumber(raw.diskGib) ?? 40,
    os: BERTHOS_GUEST_OS,
    density: "isolated",
    minSeconds,
    occupancyUnit: "seconds",
    notionalUsdPerHour: asString(raw.notional_usd_per_hour) ?? asString(raw.notionalUsdPerHour),
    settlement: notChargedHere(),
  };
}

function parseOccupancy(body: unknown): OccupancyReceipt | undefined {
  if (!body || typeof body !== "object") return undefined;
  const raw = body as Record<string, unknown>;
  const leaseId =
    asString(raw.lease_id) ??
    asString(raw.leaseId) ??
    asString((raw.lease_id as { 0?: unknown } | undefined)?.[0]);
  if (!leaseId) return undefined;
  const occupancySeconds = asNumber(raw.occupancy_seconds) ?? asNumber(raw.occupancySeconds);
  if (occupancySeconds === undefined) return undefined;
  const minSeconds = asNumber(raw.min_seconds) ?? asNumber(raw.minSeconds) ?? DEFAULT_LEASE_MIN_SECONDS;
  const billed =
    asNumber(raw.billed_seconds) ??
    asNumber(raw.billedSeconds) ??
    billedOccupancySeconds(occupancySeconds, minSeconds);
  return {
    leaseId,
    occupancySeconds,
    minSeconds,
    billedSeconds: billed,
    occupancyUnit: "seconds",
    reason: "graceful",
    notionalUsd: asString(raw.notional_usd) ?? asString(raw.notionalUsd),
    settlement: notChargedHere(),
  };
}

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return asString(body.error) ?? fallback;
  } catch {
    return fallback;
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
