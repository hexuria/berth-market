import { CdpWalletAdapter } from "./adapters/cdp-wallet.js";
import { HttpBerthosEligibilityClient } from "./adapters/http-eligibility.js";
import { HttpBerthosLeaseClient } from "./adapters/http-lease.js";
import { LiveFacilitator } from "./adapters/live-facilitator.js";
import { MemoryEligibilityClient } from "./adapters/memory-eligibility.js";
import { MemoryLeaseClient } from "./adapters/memory-lease.js";
import { MemoryStore } from "./adapters/memory-store.js";
import { MemoryWalletAdapter } from "./adapters/memory-wallet.js";
import { TestFacilitator } from "./adapters/test-facilitator.js";
import { loadConfig, type MarketConfig } from "./config.js";
import type { MarketDependencies } from "./deps.js";
import { createRouter } from "./http/routes.js";
import type { EligibilityClient } from "./ports/eligibility.js";
import type { FacilitatorPort } from "./ports/facilitator.js";
import type { LeaseClient } from "./ports/lease.js";
import type { MarketStore } from "./ports/store.js";
import type { WalletPort } from "./ports/wallet.js";

export type { MarketDependencies } from "./deps.js";

export interface CreateAppOptions {
  config?: MarketConfig;
  store?: MarketStore;
  wallets?: WalletPort;
  facilitator?: FacilitatorPort;
  eligibility?: EligibilityClient;
  leases?: LeaseClient;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

export async function createApp(options: CreateAppOptions = {}) {
  const env = options.env ?? process.env;
  const config = options.config ?? loadConfig(env);
  const store = options.store ?? new MemoryStore();
  const wallets =
    options.wallets ??
    (config.walletAdapter === "cdp" ? new CdpWalletAdapter(env) : new MemoryWalletAdapter(store));
  const facilitator =
    options.facilitator ??
    (config.facilitatorUrl
      ? new LiveFacilitator(config.facilitatorUrl, options.fetchImpl ?? fetch)
      : new TestFacilitator(store));
  const eligibility =
    options.eligibility ??
    (config.berthosUrl
      ? new HttpBerthosEligibilityClient({
          berthosUrl: config.berthosUrl,
          eligibilityPath: config.berthosEligibilityPath,
          fetchImpl: options.fetchImpl ?? fetch,
          maxAgeMs: config.attestationMaxAgeMs,
        })
      : new MemoryEligibilityClient({ maxAgeMs: config.attestationMaxAgeMs }));
  const leases =
    options.leases ??
    (config.berthosUrl
      ? new HttpBerthosLeaseClient({
          berthosUrl: config.berthosUrl,
          leaseToken: config.berthosLeaseToken,
          pairCode: config.berthosPairCode,
          fetchImpl: options.fetchImpl ?? fetch,
        })
      : new MemoryLeaseClient());

  const protocolTreasury = await wallets.createTreasury({
    label: config.protocolTreasuryLabel,
    address: config.protocolTreasuryAddress,
  });

  const deps: MarketDependencies = {
    store,
    wallets,
    facilitator,
    eligibility,
    leases,
    protocolTreasury,
  };

  const app = createRouter(deps);
  return { app, deps, config };
}
