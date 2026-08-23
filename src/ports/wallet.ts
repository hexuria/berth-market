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
  sellerTxHash?: string;
  protocolTxHash?: string;
  /** Set when this adapter moved 90/10 on-chain (CDP two transfers). */
  onChainSettlement?: "cdp_split_90_10";
}

/**
 * WalletPort is the only way the market moves USDC.
 *
 * Production target: Coinbase Agentic Wallet / CDP (`CdpWalletAdapter`),
 * env-flagged with `WALLET_ADAPTER=cdp` **and** the three CDP keys.
 * Tests and local loops use `MemoryWalletAdapter` — no CDP keys required.
 * MemoryWallet is not on-chain. Public x402.org settle is one `payTo`
 * (100% on-chain); the receipt still stores 90/10. CDP settle is two
 * transfers on Sepolia when this port is the live adapter.
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
