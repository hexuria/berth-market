export type WalletKind = "treasury" | "agent";

/** How USDC actually moved on-chain. Receipt 90/10 is always stored. */
export type OnChainSettlement = "payTo_100" | "cdp_split_90_10";

export interface CdpWalletMeta {
  ownerAddress?: string;
  spendPermission?: {
    account: string;
    spender: string;
    token: "usdc";
    allowance: string;
    periodInDays: number;
  };
}

export interface Wallet {
  id: string;
  kind: WalletKind;
  label?: string;
  address: string;
  parentId?: string;
  spendCapAtomic: string;
  spentAtomic: string;
  balanceAtomic: string;
  createdAt: string;
  /** Present when the wallet was created through `CdpWalletAdapter`. */
  cdp?: CdpWalletMeta;
}

export interface Receipt {
  id: string;
  listingId: string;
  payerWalletId: string;
  payerAddress: string;
  sellerAddress: string;
  protocolAddress: string;
  amountAtomic: string;
  sellerAtomic: string;
  protocolAtomic: string;
  transaction: string;
  network: string;
  createdAt: string;
  /** Berthos lease id when `kind=desktop.linux` was fulfilled. */
  leaseId?: string;
  berthosUrl?: string;
  leaseState?: "live" | "ended";
  /** Wall-clock seconds the guest was held. Not a second charge. */
  occupancySeconds?: number;
  billedSeconds?: number;
  occupancyMinSeconds?: number;
  occupancyUnit?: "seconds";
  /**
   * On-chain movement. `payTo_100` = public facilitator sent the full amount
   * to `sellerAddress`. `cdp_split_90_10` = CDP did two USDC transfers.
   * Omitted for the in-memory test ledger.
   */
  onChainSettlement?: OnChainSettlement;
}

export class WalletError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "WalletError";
    this.code = code;
    this.status = status;
  }
}
