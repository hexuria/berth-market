import type { Wallet } from "../domain/wallet.js";
import type { CreateAgentInput, ListingPayout, WalletPort } from "../ports/wallet.js";

/**
 * Production WalletPort targeting Coinbase Agentic Wallet / CDP.
 *
 * v1 does **not** require live CDP keys. This adapter is a documented TODO:
 * instantiate only when CDP_API_KEY_ID, CDP_API_KEY_SECRET, and
 * CDP_WALLET_SECRET are present. Tests must use `MemoryWalletAdapter`.
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
  constructor() {
    const missing = ["CDP_API_KEY_ID", "CDP_API_KEY_SECRET", "CDP_WALLET_SECRET"].filter(
      (key) => !process.env[key],
    );
    const hint =
      missing.length > 0
        ? `Missing ${missing.join(", ")}. `
        : "CDP keys are set but the live adapter is not wired in v1. ";
    throw new Error(
      `${hint}CdpWalletAdapter is a documented TODO. Use MemoryWalletAdapter for local/CI. See docs/WALLET.md.`,
    );
  }

  createTreasury(): Promise<Wallet> {
    return this.unreachable();
  }

  createAgent(_input: CreateAgentInput): Promise<Wallet> {
    return this.unreachable();
  }

  fund(_id: string, _amountAtomic: bigint): Promise<Wallet> {
    return this.unreachable();
  }

  get(_id: string): Promise<Wallet | undefined> {
    return this.unreachable();
  }

  getByAddress(_address: string): Promise<Wallet | undefined> {
    return this.unreachable();
  }

  settleListingPayment(): Promise<ListingPayout> {
    return this.unreachable();
  }

  private unreachable(): never {
    throw new Error("CdpWalletAdapter is not implemented in v1");
  }
}

export function createCdpWalletAdapter(): WalletPort {
  return new CdpWalletAdapter();
}
