import type { Wallet } from "./domain/wallet.js";
import type { EligibilityClient } from "./ports/eligibility.js";
import type { FacilitatorPort } from "./ports/facilitator.js";
import type { MarketStore } from "./ports/store.js";
import type { WalletPort } from "./ports/wallet.js";

export interface MarketDependencies {
  store: MarketStore;
  wallets: WalletPort;
  facilitator: FacilitatorPort;
  eligibility: EligibilityClient;
  protocolTreasury: Wallet;
}
