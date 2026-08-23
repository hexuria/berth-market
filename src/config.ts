import { BASE_CAIP2, USDC_BASE_ADDRESS } from "./domain/money.js";
import { DEFAULT_ATTESTATION_MAX_AGE_MS } from "./domain/eligibility.js";
import { BERTHOS_ELIGIBILITY_PATH } from "./adapters/http-eligibility.js";

export type WalletAdapterName = "memory" | "cdp";

export interface MarketConfig {
  port: number;
  protocolTreasuryAddress?: string;
  protocolTreasuryLabel: string;
  berthosUrl?: string;
  berthosEligibilityPath: string;
  berthosLeaseToken?: string;
  berthosPairCode?: string;
  facilitatorUrl?: string;
  walletAdapter: WalletAdapterName;
  attestationMaxAgeMs: number;
  usdcAsset: string;
  network: typeof BASE_CAIP2;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): MarketConfig {
  const port = Number.parseInt(env.PORT ?? "8787", 10);
  const maxAge = Number.parseInt(env.ATTESTATION_MAX_AGE_MS ?? "", 10);
  const walletAdapter = (env.WALLET_ADAPTER ?? "memory").toLowerCase();
  return {
    port: Number.isFinite(port) ? port : 8787,
    protocolTreasuryAddress: env.PROTOCOL_TREASURY_ADDRESS || undefined,
    protocolTreasuryLabel: env.PROTOCOL_TREASURY_LABEL ?? "berth-protocol",
    berthosUrl: env.BERTHOS_URL || undefined,
    berthosEligibilityPath: env.BERTHOS_ELIGIBILITY_PATH ?? BERTHOS_ELIGIBILITY_PATH,
    berthosLeaseToken: env.BERTHOS_LEASE_TOKEN || undefined,
    berthosPairCode: env.BERTHOS_PAIR_CODE || undefined,
    facilitatorUrl: env.FACILITATOR_URL || undefined,
    walletAdapter: walletAdapter === "cdp" ? "cdp" : "memory",
    attestationMaxAgeMs: Number.isFinite(maxAge) && maxAge > 0 ? maxAge : DEFAULT_ATTESTATION_MAX_AGE_MS,
    usdcAsset: USDC_BASE_ADDRESS,
    network: BASE_CAIP2,
  };
}
