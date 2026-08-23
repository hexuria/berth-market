import { BERTHOS_ELIGIBILITY_PATH } from "./adapters/http-eligibility.js";
import { DEFAULT_ATTESTATION_MAX_AGE_MS } from "./domain/eligibility.js";
import {
  DEFAULT_LISTING_NETWORK,
  parseListingNetwork,
  usdcAddressFor,
  type SupportedCaip2,
} from "./domain/money.js";
import { parseCorsOrigins } from "./http/cors.js";

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
  /** Catalog default for new listings that omit `price.network`. Stored listings keep their own network. */
  network: SupportedCaip2;
  /** Browser origins allowed to call this process. Default is Vite loopback, not `*`. */
  corsOrigins: string[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): MarketConfig {
  const port = Number.parseInt(env.PORT ?? "8787", 10);
  const maxAge = Number.parseInt(env.ATTESTATION_MAX_AGE_MS ?? "", 10);
  const walletAdapter = (env.WALLET_ADAPTER ?? "memory").toLowerCase();
  const network = parseListingNetwork(env.NETWORK ?? DEFAULT_LISTING_NETWORK);
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
    usdcAsset: usdcAddressFor(network),
    network,
    corsOrigins: parseCorsOrigins(env.CORS_ORIGIN),
  };
}
