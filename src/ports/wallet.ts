import type { Wallet } from "../domain/wallet.js";

export interface CreateAgentInput {
  treasuryId: string;
  spendCapAtomic: bigint;
  label?: string;
}

export interface ListingPayout {
  txHash: string;
  sellerAtomic: bigint;
  protocolAtomic: bigint;
  payer: Wallet;
}

/**
 * WalletPort is the only way the market moves USDC.
 *
 * Production target: Coinbase Agentic Wallet / CDP (`CdpWalletAdapter`).
 * Tests and local loops use `MemoryWalletAdapter` — no CDP keys required.
 */
export interface WalletPort {
  createTreasury(input?: { label?: string; address?: string }): Promise<Wallet>;
  createAgent(input: CreateAgentInput): Promise<Wallet>;
  fund(id: string, amountAtomic: bigint): Promise<Wallet>;
  get(id: string): Promise<Wallet | undefined>;
  getByAddress(address: string): Promise<Wallet | undefined>;
  /**
   * Debit a capped agent (or treasury), credit seller + protocol.
   * Must enforce spend cap and available balance. Atomic in-process.
   */
  settleListingPayment(input: {
    payerId: string;
    sellerAddress: string;
    protocolAddress: string;
    amountAtomic: bigint;
  }): Promise<ListingPayout>;
}
