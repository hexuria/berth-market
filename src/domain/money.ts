/** USDC on Base uses 6 decimals. Amounts in this repo are atomic units as bigint. */
export const USDC_DECIMALS = 6;
export const USDC_BASE_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const BASE_CAIP2 = "eip155:8453";

/** 10% protocol cut, in basis points. */
export const PROTOCOL_CUT_BPS = 1000n;
export const BPS_DENOMINATOR = 10_000n;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

export function parseAtomic(value: string | number | bigint): bigint {
  if (typeof value === "bigint") {
    if (value < 0n) throw new MoneyError("amount must be non-negative");
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0) {
      throw new MoneyError("numeric amount must be a non-negative integer of atomic USDC");
    }
    return BigInt(value);
  }
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new MoneyError(`invalid atomic amount: ${value}`);
  }
  return BigInt(trimmed);
}

/** Parse a human USDC decimal string ("1.50") into atomic units. */
export function parseUsdc(value: string): bigint {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new MoneyError(`invalid USDC amount: ${value}`);
  }
  const [wholeRaw, fracRaw = ""] = trimmed.split(".");
  if (fracRaw.length > USDC_DECIMALS) {
    throw new MoneyError(`USDC supports at most ${USDC_DECIMALS} decimal places`);
  }
  const frac = fracRaw.padEnd(USDC_DECIMALS, "0");
  return BigInt(wholeRaw ?? "0") * 10n ** BigInt(USDC_DECIMALS) + BigInt(frac || "0");
}

export function formatUsdc(atomic: bigint): string {
  const neg = atomic < 0n;
  const abs = neg ? -atomic : atomic;
  const whole = abs / 10n ** BigInt(USDC_DECIMALS);
  const frac = (abs % 10n ** BigInt(USDC_DECIMALS)).toString().padStart(USDC_DECIMALS, "0");
  const trimmedFrac = frac.replace(/0+$/, "");
  const body = trimmedFrac.length === 0 ? `${whole}` : `${whole}.${trimmedFrac}`;
  return neg ? `-${body}` : body;
}

export function splitProceeds(amountAtomic: bigint): { sellerAtomic: bigint; protocolAtomic: bigint } {
  if (amountAtomic < 0n) throw new MoneyError("cannot split a negative amount");
  const protocolAtomic = (amountAtomic * PROTOCOL_CUT_BPS) / BPS_DENOMINATOR;
  return { sellerAtomic: amountAtomic - protocolAtomic, protocolAtomic };
}

export function isEvmAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

export function normalizeAddress(value: string): string {
  if (!isEvmAddress(value)) {
    throw new MoneyError(`invalid EVM address: ${value}`);
  }
  return value.toLowerCase();
}
