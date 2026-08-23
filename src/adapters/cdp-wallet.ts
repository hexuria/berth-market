import { WalletError, type Wallet } from "../domain/wallet.js";
import type { CreateAgentInput, ListingPayout, WalletPort } from "../ports/wallet.js";
import type { MarketStore } from "../ports/store.js";
import { MemoryWalletAdapter } from "./memory-wallet.js";

export const CDP_ENV_KEYS = ["CDP_API_KEY_ID", "CDP_API_KEY_SECRET", "CDP_WALLET_SECRET"] as const;
export const WALLET_ADAPTER_ENV = "WALLET_ADAPTER";

/**
 * Production WalletPort targeting Coinbase Agentic Wallet / CDP.
 *
 * This adapter **compiles** as a full `WalletPort` and is **env-flagged**.
 * It is never selected unless `WALLET_ADAPTER=cdp` and the three CDP keys
 * are present. Tests and CI use `MemoryWalletAdapter` — no live CDP keys
 * are required, and this class must not be constructed in those runs.
 *
 * Do **not** add `@coinbase/cdp-sdk` as a runtime dependency in this slice.
 * Live calls stay behind the flag so a missing SDK cannot leak into CI.
 *
 * Intended mapping (do not invent a second ledger):
 * - Treasury = CDP EVM smart account with `enableSpendPermissions: true`
 * - Agent    = spender EOA + `cdp.evm.createSpendPermission({ token: "usdc", ... })`
 * - Fund     = USDC transfer / faucet on Base (`eip155:8453`)
 * - Settle   = `useSpendPermission` then split 90/10 to listing.payTo + protocol
 *
 * @see https://docs.cdp.coinbase.com/wallets/using-wallets/spend-permissions
 * @see docs/WALLET.md
 */
export class CdpWalletAdapter implements WalletPort {
  readonly kind = "cdp" as const;

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {
    const missing = missingCdpKeys(this.env);
    if (missing.length > 0) {
      throw new Error(
        `CdpWalletAdapter requires ${missing.join(", ")}. ` +
          `It is env-flagged via ${WALLET_ADAPTER_ENV}=cdp. ` +
          "Use MemoryWalletAdapter for local/CI. See docs/WALLET.md.",
      );
    }
  }

  createTreasury(_input?: { label?: string; address?: string }): Promise<Wallet> {
    return this.notLive("createTreasury");
  }

  createAgent(_input: CreateAgentInput): Promise<Wallet> {
    return this.notLive("createAgent");
  }

  fund(_id: string, _amountAtomic: bigint): Promise<Wallet> {
    return this.notLive("fund");
  }

  get(_id: string): Promise<Wallet | undefined> {
    return this.notLive("get");
  }

  getByAddress(_address: string): Promise<Wallet | undefined> {
    return this.notLive("getByAddress");
  }

  settleListingPayment(): Promise<ListingPayout> {
    return this.notLive("settleListingPayment");
  }

  private notLive(method: string): never {
    throw new WalletError(
      "cdp_not_live",
      `CdpWalletAdapter.${method} is documented and compiles, but live CDP calls are not made without @coinbase/cdp-sdk. Tests must use MemoryWalletAdapter.`,
      501,
    );
  }
}

export function missingCdpKeys(env: NodeJS.ProcessEnv = process.env): string[] {
  return CDP_ENV_KEYS.filter((key) => !env[key]);
}

export function cdpKeysPresent(env: NodeJS.ProcessEnv = process.env): boolean {
  return missingCdpKeys(env).length === 0;
}

/** True only when the operator opted in. Default is the in-memory wallet. */
export function shouldUseCdpWallet(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env[WALLET_ADAPTER_ENV] ?? "memory").toLowerCase() === "cdp";
}

/**
 * Default factory: memory wallet unless `WALLET_ADAPTER=cdp`.
 * Throws at boot if the flag is set without keys so CI cannot silently
 * construct a live adapter.
 */
export function createWalletPort(
  store: MarketStore,
  env: NodeJS.ProcessEnv = process.env,
): WalletPort {
  if (!shouldUseCdpWallet(env)) {
    return new MemoryWalletAdapter(store);
  }
  return new CdpWalletAdapter(env);
}

export function createCdpWalletAdapter(env: NodeJS.ProcessEnv = process.env): WalletPort {
  return new CdpWalletAdapter(env);
}
