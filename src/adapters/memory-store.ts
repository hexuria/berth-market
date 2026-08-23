import type { Listing } from "../domain/listing.js";
import type { Receipt, Wallet } from "../domain/wallet.js";
import type { MarketStore } from "../ports/store.js";

export class MemoryStore implements MarketStore {
  readonly listings = new Map<string, Listing>();
  readonly wallets = new Map<string, Wallet>();
  readonly receipts: Receipt[] = [];
  readonly nonces = new Set<string>();

  async putListing(listing: Listing): Promise<void> {
    this.listings.set(listing.id, listing);
  }

  async getListing(id: string): Promise<Listing | undefined> {
    return this.listings.get(id);
  }

  async listListings(): Promise<Listing[]> {
    return [...this.listings.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async putWallet(wallet: Wallet): Promise<void> {
    this.wallets.set(wallet.id, wallet);
  }

  async getWallet(id: string): Promise<Wallet | undefined> {
    return this.wallets.get(id);
  }

  async getWalletByAddress(address: string): Promise<Wallet | undefined> {
    const needle = address.toLowerCase();
    return [...this.wallets.values()].find((w) => w.address.toLowerCase() === needle);
  }

  async putReceipt(receipt: Receipt): Promise<void> {
    this.receipts.push(receipt);
  }

  async listReceipts(listingId?: string): Promise<Receipt[]> {
    return listingId ? this.receipts.filter((r) => r.listingId === listingId) : [...this.receipts];
  }

  async consumeNonce(nonce: string): Promise<boolean> {
    if (this.nonces.has(nonce)) return false;
    this.nonces.add(nonce);
    return true;
  }
}
