export function newId(prefix: string): string {
  const uuid = crypto.randomUUID().replaceAll("-", "");
  return `${prefix}_${uuid.slice(0, 20)}`;
}

export function newAddress(seed?: string): string {
  const bytes = new Uint8Array(20);
  if (seed) {
    const encoded = new TextEncoder().encode(seed);
    for (let i = 0; i < 20; i += 1) {
      bytes[i] = (encoded[i % encoded.length] ?? 0) ^ (i * 17);
    }
  } else {
    crypto.getRandomValues(bytes);
  }
  return `0x${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Prefix for MemoryWallet / TestFacilitator settle ids. Never `0x` + 64 hex. */
export const OFF_CHAIN_SETTLE_PREFIX = "tf_settle";

/**
 * Off-chain settle id for TestFacilitator and MemoryWallet receipts.
 * Clients that treat `0x` + 64 hex as an explorer hash must not link this.
 */
export function newOffChainSettleId(): string {
  return newId(OFF_CHAIN_SETTLE_PREFIX);
}

/** True only for a 32-byte hex hash. Off-chain settle ids must never match. */
export function isEvmTxHash(value: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}

/**
 * Random `0x` + 64 hex. Do not use for TestFacilitator / MemoryWallet
 * receipts — those are not chain txs. Live facilitator / CDP hashes come
 * from the network (or a test mock of one).
 */
export function newTxHash(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
