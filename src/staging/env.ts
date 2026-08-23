import {
  BASE_SEPOLIA_CAIP2,
  isEvmAddress,
  isMainnetCaip2,
  parseListingNetwork,
} from "../domain/money.js";

export const PUBLIC_X402_FACILITATOR_URL = "https://x402.org/facilitator";
/** $0.001 USDC — a 1 USDC faucet tap lasts ~1000 staging payments. */
export const STAGING_AMOUNT_ATOMIC = "1000";
export const STAGING_PAYER_KEY_ENVS = ["STAGING_PAYER_PRIVATE_KEY", "X402_PAYER_PRIVATE_KEY"] as const;
export const STAGING_PAY_TO_ENV = "STAGING_PAY_TO";

export const PRIVATE_KEY_HEX = /^0x[0-9a-fA-F]{64}$/;

export type StagingLoopReady = {
  skipped: false;
  payerPrivateKey: `0x${string}`;
  payTo: string;
  facilitatorUrl: string;
  network: typeof BASE_SEPOLIA_CAIP2;
};

export type StagingLoopSkipped = {
  skipped: true;
  reason: string;
  network: typeof BASE_SEPOLIA_CAIP2;
};

export type StagingLoopEnv = StagingLoopReady | StagingLoopSkipped;

const SKIP_REASON =
  "sepolia-loop: skipped (STAGING_PAYER_PRIVATE_KEY or X402_PAYER_PRIVATE_KEY, and STAGING_PAY_TO, are unset). " +
  "CI stays secret-free. Fund a Base Sepolia EOA, then set those env vars to settle a real testnet x402 payment.";

/**
 * Resolve staging-loop env. Never logs key material.
 * Refuses mainnet so this script cannot send traffic to eip155:8453.
 */
export function resolveStagingLoopEnv(env: NodeJS.ProcessEnv = process.env): StagingLoopEnv {
  const requested = env.NETWORK?.trim();
  if (requested) {
    if (isMainnetCaip2(requested)) {
      throw new Error(
        "sepolia-loop refuses mainnet (eip155:8453 / base). Use NETWORK=base-sepolia or eip155:84532.",
      );
    }
    const parsed = parseListingNetwork(requested);
    if (parsed !== BASE_SEPOLIA_CAIP2) {
      throw new Error(`sepolia-loop only settles Base Sepolia (${BASE_SEPOLIA_CAIP2}), got ${parsed}`);
    }
  }

  const rawKey = firstEnv(env, STAGING_PAYER_KEY_ENVS);
  const payTo = env[STAGING_PAY_TO_ENV]?.trim();

  if (!rawKey || !payTo) {
    return { skipped: true, reason: SKIP_REASON, network: BASE_SEPOLIA_CAIP2 };
  }

  if (!PRIVATE_KEY_HEX.test(rawKey)) {
    throw new Error(
      "STAGING_PAYER_PRIVATE_KEY / X402_PAYER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key (value is never logged)",
    );
  }
  if (!isEvmAddress(payTo)) {
    throw new Error("STAGING_PAY_TO must be a 0x-prefixed 20-byte EVM address");
  }

  return {
    skipped: false,
    payerPrivateKey: rawKey as `0x${string}`,
    payTo,
    facilitatorUrl: env.FACILITATOR_URL?.trim() || PUBLIC_X402_FACILITATOR_URL,
    network: BASE_SEPOLIA_CAIP2,
  };
}

function firstEnv(env: NodeJS.ProcessEnv, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}
