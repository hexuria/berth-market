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
