import {
  BERTHOS_GUEST_OS,
  DEFAULT_LEASE_MIN_SECONDS,
  LeaseError,
  billedOccupancySeconds,
  notChargedHere,
  type CreateLeaseInput,
  type EndLeaseInput,
  type LeaseRecord,
  type OccupancyReceipt,
} from "../domain/lease.js";
import type { LeaseClient } from "../ports/lease.js";
import { newId } from "./ids.js";

export type MemoryLeaseMode = "ok" | "unreachable" | "laptop" | "ineligible" | "conflict";

export interface MemoryLeaseClientOptions {
  mode?: MemoryLeaseMode;
  berthosUrl?: string;
  /** When set, `end` reports this occupancy instead of wall-clock elapsed. */
  occupancySecondsOnEnd?: number;
  minSeconds?: number;
  now?: () => number;
}

/**
 * In-memory Berthos lease port. One live lease, occupancy seconds,
 * 409 on a second create. Does not talk to a node or Docker.
 */
export class MemoryLeaseClient implements LeaseClient {
  readonly kind = "memory" as const;
  mode: MemoryLeaseMode;
  live: LeaseRecord | undefined;
  readonly created: LeaseRecord[] = [];
  readonly ended: OccupancyReceipt[] = [];
  occupancySecondsOnEnd?: number;
  private readonly defaultUrl: string;
  private readonly minSeconds: number;
  private readonly now: () => number;

  constructor(options: MemoryLeaseClientOptions = {}) {
    this.mode = options.mode ?? "ok";
    this.defaultUrl = options.berthosUrl ?? "https://berthos.example";
    this.occupancySecondsOnEnd = options.occupancySecondsOnEnd;
    this.minSeconds = options.minSeconds ?? DEFAULT_LEASE_MIN_SECONDS;
    this.now = options.now ?? Date.now;
  }

  async create(input: CreateLeaseInput): Promise<LeaseRecord> {
    this.assertCreateAllowed();
    if (input.os !== BERTHOS_GUEST_OS) {
      throw new LeaseError(
        "unsupported_os",
        "v1 leases only os=linux; windows and macos are out of scope",
        400,
      );
    }
    if (this.live) {
      throw new LeaseError("already_leased", "a lease is already live", 409);
    }

    const startedAt = new Date(this.now()).toISOString();
    const lease: LeaseRecord = {
      id: newId("l"),
      state: "live",
      os: BERTHOS_GUEST_OS,
      berthosUrl: input.berthosUrl ?? this.defaultUrl,
      startedAt,
      quote: {
        vcpu: input.vcpu ?? 2,
        memGib: input.memGib ?? 4,
        diskGib: input.diskGib ?? 40,
        os: BERTHOS_GUEST_OS,
        density: "isolated",
        minSeconds: this.minSeconds,
        occupancyUnit: "seconds",
        notionalUsdPerHour: "0.048",
        settlement: notChargedHere(),
      },
    };
    this.live = lease;
    this.created.push(lease);
    return { ...lease, quote: { ...lease.quote, settlement: { ...lease.quote.settlement } } };
  }

  async end(input: EndLeaseInput): Promise<OccupancyReceipt> {
    this.assertReachable();
    const live = this.live;
    if (!live || live.id !== input.leaseId) {
      throw new LeaseError("lease_not_found", "lease not found", 404);
    }
    const occupancySeconds =
      this.occupancySecondsOnEnd ??
      Math.max(0, Math.floor((this.now() - Date.parse(live.startedAt)) / 1000));
    const receipt: OccupancyReceipt = {
      leaseId: live.id,
      occupancySeconds,
      minSeconds: live.quote.minSeconds,
      billedSeconds: billedOccupancySeconds(occupancySeconds, live.quote.minSeconds),
      occupancyUnit: "seconds",
      reason: "graceful",
      settlement: notChargedHere(),
    };
    this.live = undefined;
    this.ended.push(receipt);
    return { ...receipt, settlement: { ...receipt.settlement } };
  }

  private assertCreateAllowed(): void {
    this.assertReachable();
    if (this.mode === "laptop") {
      throw new LeaseError(
        "forbidden_class",
        "class=laptop is rejected; only a VM guest or a dedicated server guest may be leased",
        400,
      );
    }
    if (this.mode === "ineligible") {
      throw new LeaseError("node_ineligible", "node is ineligible; run berth doctor", 403);
    }
    if (this.mode === "conflict") {
      throw new LeaseError("already_leased", "a lease is already live", 409);
    }
  }

  private assertReachable(): void {
    if (this.mode === "unreachable") {
      throw new LeaseError("node_unreachable", "node_unreachable:ECONNREFUSED", 400);
    }
  }
}
