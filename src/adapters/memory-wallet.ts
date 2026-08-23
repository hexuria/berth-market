import { normalizeAddress, splitProceeds } from "../domain/money.js";
import { WalletError, type Wallet } from "../domain/wallet.js";
import type { CreateAgentInput, ListingPayout, WalletPort } from "../ports/wallet.js";
import type { MarketStore } from "../ports/store.js";
import { newAddress, newId, newTxHash, nowIso } from "./ids.js";

function clone(wallet: Wallet): Wallet {
  return { ...wallet };
}

export class MemoryWalletAdapter implements WalletPort {
  readonly kind = "memory" as const;

  constructor(private readonly store: MarketStore) {}

  async createTreasury(input: { label?: string; address?: string } = {}): Promise<Wallet> {
    const wallet: Wallet = {
      id: newId("wal"),
      kind: "treasury",
      label: input.label ?? "treasury",
      address: input.address ? normalizeAddress(input.address) : newAddress(),
      spendCapAtomic: "0",
      spentAtomic: "0",
      balanceAtomic: "0",
      createdAt: nowIso(),
    };
    await this.store.putWallet(wallet);
    return clone(wallet);
  }

  async createAgent(input: CreateAgentInput): Promise<Wallet> {
    if (input.spendCapAtomic <= 0n) {
      throw new WalletError("invalid_cap", "spendCap must be greater than 0");
    }
    const treasury = await this.store.getWallet(input.treasuryId);
    if (!treasury || treasury.kind !== "treasury") {
      throw new WalletError("treasury_not_found", "parent treasury not found", 404);
    }
    const wallet: Wallet = {
      id: newId("wal"),
      kind: "agent",
      label: input.label ?? "agent",
      address: newAddress(),
      parentId: treasury.id,
      spendCapAtomic: input.spendCapAtomic.toString(),
      spentAtomic: "0",
      balanceAtomic: "0",
      createdAt: nowIso(),
    };
    await this.store.putWallet(wallet);
    return clone(wallet);
  }

  async fund(id: string, amountAtomic: bigint): Promise<Wallet> {
    if (amountAtomic <= 0n) {
      throw new WalletError("invalid_amount", "fund amount must be greater than 0");
    }
    const wallet = await this.require(id);
    wallet.balanceAtomic = (BigInt(wallet.balanceAtomic) + amountAtomic).toString();
    await this.store.putWallet(wallet);
    return clone(wallet);
  }

  async get(id: string): Promise<Wallet | undefined> {
    const wallet = await this.store.getWallet(id);
    return wallet ? clone(wallet) : undefined;
  }

  async getByAddress(address: string): Promise<Wallet | undefined> {
    const wallet = await this.store.getWalletByAddress(normalizeAddress(address));
    return wallet ? clone(wallet) : undefined;
  }

  async settleListingPayment(input: {
    payerId: string;
    sellerAddress: string;
    protocolAddress: string;
    amountAtomic: bigint;
  }): Promise<ListingPayout> {
    const payer = await this.require(input.payerId);
    if (payer.kind === "agent") {
      const spent = BigInt(payer.spentAtomic);
      const cap = BigInt(payer.spendCapAtomic);
      if (spent + input.amountAtomic > cap) {
        throw new WalletError(
          "spend_cap_exceeded",
          `agent spend cap exceeded (spent ${spent} + ${input.amountAtomic} > cap ${cap})`,
          402,
        );
      }
    }
    const balance = BigInt(payer.balanceAtomic);
    if (balance < input.amountAtomic) {
      throw new WalletError("insufficient_funds", "agent wallet has insufficient USDC", 402);
    }

    const { sellerAtomic, protocolAtomic } = splitProceeds(input.amountAtomic);
    payer.balanceAtomic = (balance - input.amountAtomic).toString();
    if (payer.kind === "agent") {
      payer.spentAtomic = (BigInt(payer.spentAtomic) + input.amountAtomic).toString();
    }
    await this.store.putWallet(payer);

    await this.credit(input.sellerAddress, sellerAtomic);
    await this.credit(input.protocolAddress, protocolAtomic);

    return {
      txHash: newTxHash(),
      sellerAtomic,
      protocolAtomic,
      payer: clone(payer),
    };
  }

  private async require(id: string): Promise<Wallet> {
    const wallet = await this.store.getWallet(id);
    if (!wallet) throw new WalletError("wallet_not_found", `wallet ${id} not found`, 404);
    return { ...wallet };
  }

  private async credit(address: string, amount: bigint): Promise<void> {
    if (amount === 0n) return;
    const existing = await this.store.getWalletByAddress(normalizeAddress(address));
    if (!existing) return;
    existing.balanceAtomic = (BigInt(existing.balanceAtomic) + amount).toString();
    await this.store.putWallet(existing);
  }
}
