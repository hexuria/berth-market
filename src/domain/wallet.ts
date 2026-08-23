export type WalletKind = "treasury" | "agent";

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
