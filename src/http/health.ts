import type { MarketConfig, WalletAdapterName } from "../config.js";
import type { MarketDependencies } from "../deps.js";
import { BASE_CAIP2, BASE_SEPOLIA_CAIP2 } from "../domain/money.js";

export type FacilitatorIdentity = "test" | "live";

/** Public GET /health body. Never include keys, tokens, or spend-permission material. */
export interface MarketHealth {
  ok: true;
  service: "berth-market";
  asset: "USDC";
  usdcAsset: string;
  network: MarketConfig["network"];
  networks: string[];
  stagingNetwork: typeof BASE_SEPOLIA_CAIP2;
  protocolCutBps: 1000;
  walletAdapter: WalletAdapterName;
  facilitator: FacilitatorIdentity;
  facilitatorUrl?: string;
}

function namedKind(value: object): string | undefined {
  const kind = (value as { kind?: unknown }).kind;
  return typeof kind === "string" ? kind : undefined;
}

export function resolveWalletAdapter(
  deps: MarketDependencies,
  config: MarketConfig,
): WalletAdapterName {
  const kind = namedKind(deps.wallets);
  if (kind === "cdp" || kind === "memory") return kind;
  return config.walletAdapter;
}

export function resolveFacilitator(
  deps: MarketDependencies,
  config: MarketConfig,
): FacilitatorIdentity {
  const kind = namedKind(deps.facilitator);
  if (kind === "live" || kind === "test") return kind;
  return config.facilitatorUrl ? "live" : "test";
}

export function publicHealth(deps: MarketDependencies, config: MarketConfig): MarketHealth {
  const health: MarketHealth = {
    ok: true,
    service: "berth-market",
    asset: "USDC",
    usdcAsset: config.usdcAsset,
    network: config.network,
    networks: [BASE_CAIP2, BASE_SEPOLIA_CAIP2],
    stagingNetwork: BASE_SEPOLIA_CAIP2,
    protocolCutBps: 1000,
    walletAdapter: resolveWalletAdapter(deps, config),
    facilitator: resolveFacilitator(deps, config),
  };
  if (config.facilitatorUrl) {
    health.facilitatorUrl = config.facilitatorUrl;
  }
  return health;
}
