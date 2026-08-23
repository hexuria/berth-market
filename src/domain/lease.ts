/**
 * Berthos lease types as the market stores them.
 *
 * The node meters occupancy seconds and never charges (`charged_here: false`).
 * Money stays here: USDC on Base, 90% seller / 10% protocol, settled at invoke.
 * Occupancy on the receipt is not a second x402.
 */

export const BERTHOS_GUEST_OS = "linux" as const;
export type BerthosGuestOs = typeof BERTHOS_GUEST_OS;

export const DEFAULT_LEASE_MIN_SECONDS = 60;
export const OCCUPANCY_UNIT = "seconds" as const;
export type OccupancyUnit = typeof OCCUPANCY_UNIT;

export type LeaseState = "live" | "ended";

export const OCCUPANCY_NOT_CHARGED_NOTE =
  "v1 is pay-then-occupy. Occupancy seconds are a receipt, not a second x402 charge. Money settled at invoke.";

export interface LeaseSettlementHint {
  chargedHere: false;
  note: string;
}

export function notChargedHere(): LeaseSettlementHint {
  return { chargedHere: false, note: OCCUPANCY_NOT_CHARGED_NOTE };
}

export interface LeaseQuote {
  vcpu: number;
  memGib: number;
  diskGib: number;
  os: BerthosGuestOs;
  density: "isolated";
  minSeconds: number;
  occupancyUnit: OccupancyUnit;
  notionalUsdPerHour?: string;
  settlement: LeaseSettlementHint;
}

export interface LeaseRecord {
  id: string;
  state: LeaseState;
  os: BerthosGuestOs;
  berthosUrl: string;
  startedAt: string;
  endedAt?: string;
  quote: LeaseQuote;
}

export interface OccupancyReceipt {
  leaseId: string;
  occupancySeconds: number;
  minSeconds: number;
  billedSeconds: number;
  occupancyUnit: OccupancyUnit;
  reason: "graceful";
  notionalUsd?: string;
  settlement: LeaseSettlementHint;
}

export interface CreateLeaseInput {
  os: BerthosGuestOs;
  berthosUrl?: string;
  token?: string;
  vcpu?: number;
  memGib?: number;
  diskGib?: number;
}

export interface EndLeaseInput {
  leaseId: string;
  berthosUrl?: string;
  token?: string;
}

export class LeaseError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "LeaseError";
    this.code = code;
    this.status = status;
  }
}

export function billedOccupancySeconds(
  occupancySeconds: number,
  minSeconds = DEFAULT_LEASE_MIN_SECONDS,
): number {
  const held = Math.max(0, Math.floor(occupancySeconds));
  return Math.max(held, minSeconds);
}
