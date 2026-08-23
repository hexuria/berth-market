import type { Listing } from "../domain/listing.js";
import type { Receipt, Wallet } from "../domain/wallet.js";

export interface MarketStore {
  putListing(listing: Listing): Promise<void>;
  getListing(id: string): Promise<Listing | undefined>;
  listListings(): Promise<Listing[]>;
  putWallet(wallet: Wallet): Promise<void>;
  getWallet(id: string): Promise<Wallet | undefined>;
  getWalletByAddress(address: string): Promise<Wallet | undefined>;
  putReceipt(receipt: Receipt): Promise<void>;
  getReceipt(id: string): Promise<Receipt | undefined>;
  listReceipts(listingId?: string): Promise<Receipt[]>;
  consumeNonce(nonce: string): Promise<boolean>;
  hasNonce(nonce: string): Promise<boolean>;
}
