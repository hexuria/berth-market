import { MemoryEligibilityClient } from "./adapters/memory-eligibility.js";
import { MemoryStore } from "./adapters/memory-store.js";
import { MemoryWalletAdapter } from "./adapters/memory-wallet.js";
import { TestFacilitator } from "./adapters/test-facilitator.js";
import { loadConfig, type MarketConfig } from "./config.js";
import type { MarketDependencies } from "./deps.js";
import { createRouter } from "./http/routes.js";
import type { EligibilityClient } from "./ports/eligibility.js";
import type { FacilitatorPort } from "./ports/facilitator.js";
import type { MarketStore } from "./ports/store.js";
import type { WalletPort } from "./ports/wallet.js";

export type { MarketDependencies } from "./deps.js";

export interface CreateAppOptions {
  config?: MarketConfig;
  store?: MarketStore;
  wallets?: WalletPort;
  facilitator?: FacilitatorPort;
  eligibility?: EligibilityClient;
}

export async function createApp(options: CreateAppOptions = {}) {
  const config = options.config ?? loadConfig();
  const store = options.store ?? new MemoryStore();
  const wallets = options.wallets ?? new MemoryWalletAdapter(store);
  const facilitator = options.facilitator ?? new TestFacilitator(store);
  const eligibility = options.eligibility ?? new MemoryEligibilityClient();

  const protocolTreasury = await wallets.createTreasury({
    label: config.protocolTreasuryLabel,
    address: config.protocolTreasuryAddress,
  });

  const deps: MarketDependencies = {
    store,
    wallets,
    facilitator,
    eligibility,
    protocolTreasury,
  };

  const app = createRouter(deps);
  return { app, deps, config };
}
