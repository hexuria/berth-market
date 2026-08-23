import { WalletError, type Wallet } from "../domain/wallet.js";
import {
  BASE_CAIP2,
  BASE_SEPOLIA_CAIP2,
  isMainnetCaip2,
  normalizeAddress,
  parseListingNetwork,
  splitProceeds,
} from "../domain/money.js";
import type { CreateAgentInput, ListingPayout, WalletPort } from "../ports/wallet.js";
import type { MarketStore } from "../ports/store.js";
import { MemoryStore } from "./memory-store.js";
import { MemoryWalletAdapter } from "./memory-wallet.js";
import { newId, nowIso } from "./ids.js";

export const CDP_ENV_KEYS = ["CDP_API_KEY_ID", "CDP_API_KEY_SECRET", "CDP_WALLET_SECRET"] as const;
export const WALLET_ADAPTER_ENV = "WALLET_ADAPTER";

/** Live CDP network id. Default is Sepolia. `base` only when NETWORK/CDP_NETWORK is explicit. */
export type CdpNetworkId = "base-sepolia" | "base";

export interface CdpTransferResult {
  transactionHash?: string;
  userOpHash?: string;
}

export interface CdpSpendPermissionInput {
  account: string;
  spender: string;
  token: "usdc";
  allowance: bigint;
  periodInDays: number;
}

/**
 * Narrow CDP surface used by this adapter. Tests inject a mock. The live
 * `@coinbase/cdp-sdk` `CdpClient` is constructed only when the env flag and
 * all three keys are present and no mock was injected.
 */
export interface CdpAccountLike {
  address: string;
  transfer(options: {
    to: string;
    amount: bigint;
    token: "usdc";
    network: CdpNetworkId;
  }): Promise<CdpTransferResult>;
  useSpendPermission?(options: {
    spendPermission: CdpSpendPermissionInput;
    value: bigint;
    network: CdpNetworkId;
  }): Promise<CdpTransferResult>;
}

export interface CdpEvmLike {
  createAccount(options?: { name?: string }): Promise<CdpAccountLike>;
  createSmartAccount(options: {
    owner: CdpAccountLike;
    name?: string;
    enableSpendPermissions?: boolean;
  }): Promise<CdpAccountLike>;
  createSpendPermission(options: {
    network: CdpNetworkId;
    spendPermission: CdpSpendPermissionInput;
  }): Promise<{ userOpHash?: string }>;
  requestFaucet(options: {
    address: string;
    network: "base-sepolia" | "ethereum-sepolia";
    token: "usdc";
  }): Promise<{ transactionHash: string }>;
  getAccount?(options: { address?: string; name?: string }): Promise<CdpAccountLike>;
}

export interface CdpSdkLike {
  evm: CdpEvmLike;
}

export interface CdpWalletAdapterOptions {
  store?: MarketStore;
  /** Injected in tests. Never a live client in CI. */
  client?: CdpSdkLike;
}

/**
 * Production WalletPort targeting Coinbase Agentic Wallet / CDP.
 *
 * Selected only when `WALLET_ADAPTER=cdp` **and** the three CDP keys are
 * present. Default boot and CI use `MemoryWalletAdapter`. Missing keys
 * refuse construction — they do not fall back to a half-live adapter.
 *
 * Live network is Base Sepolia (`base-sepolia` / `eip155:84532`) unless
 * `NETWORK` or `CDP_NETWORK` is explicitly `base` / `eip155:8453`.
 * There is no mainnet default.
 *
 * Settle mapping (one CDP ledger, not a second in-process mint):
 * - Treasury = EVM smart account with `enableSpendPermissions: true`
 * - Agent    = spender EOA + `createSpendPermission({ token: "usdc", … })`
 * - Fund     = `requestFaucet` on `base-sepolia` (drip size is Coinbase's)
 * - Settle   = `useSpendPermission` then two USDC transfers: 90% payTo, 10% protocol
 *
 * The public x402.org facilitator still settles 100% to one `payTo`. That
 * path is not this adapter. Do not pair this adapter with a live facilitator
 * settle and then move funds again.
 *
 * @see https://docs.cdp.coinbase.com/wallets/using-wallets/spend-permissions
 * @see docs/WALLET.md
 */
export class CdpWalletAdapter implements WalletPort {
  readonly kind = "cdp" as const;
  readonly network: CdpNetworkId;

  private readonly store: MarketStore;
  private client: CdpSdkLike | undefined;
  private readonly accounts = new Map<string, CdpAccountLike>();

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    options: CdpWalletAdapterOptions = {},
  ) {
    const missing = missingCdpKeys(this.env);
    if (missing.length > 0) {
      throw new Error(
        `CdpWalletAdapter requires ${missing.join(", ")}. ` +
          `It is env-flagged via ${WALLET_ADAPTER_ENV}=cdp. ` +
          "Use MemoryWalletAdapter for local/CI. See docs/WALLET.md.",
      );
    }
    this.store = options.store ?? new MemoryStore();
    this.client = options.client;
    this.network = resolveCdpNetwork(this.env);
  }

  async createTreasury(input: { label?: string; address?: string } = {}): Promise<Wallet> {
    const id = newId("wal");
    let address: string;
    let ownerAddress: string | undefined;

    if (input.address) {
      address = normalizeAddress(input.address);
    } else {
      const sdk = await this.sdk();
      const owner = await sdk.evm.createAccount({ name: `${id}-owner` });
      this.cache(owner);
      const smart = await sdk.evm.createSmartAccount({
        owner,
        name: id,
        enableSpendPermissions: true,
      });
      this.cache(smart);
      address = normalizeAddress(smart.address);
      ownerAddress = normalizeAddress(owner.address);
    }

    const wallet: Wallet = {
      id,
      kind: "treasury",
      label: input.label ?? "treasury",
      address,
      spendCapAtomic: "0",
      spentAtomic: "0",
      balanceAtomic: "0",
      createdAt: nowIso(),
      cdp: ownerAddress ? { ownerAddress } : undefined,
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

    const id = newId("wal");
    const sdk = await this.sdk();
    const spender = await sdk.evm.createAccount({ name: id });
    this.cache(spender);

    const permission: CdpSpendPermissionInput = {
      account: treasury.address,
      spender: spender.address,
      token: "usdc",
      allowance: input.spendCapAtomic,
      periodInDays: 365,
    };
    await sdk.evm.createSpendPermission({
      network: this.network,
      spendPermission: permission,
    });

    const wallet: Wallet = {
      id,
      kind: "agent",
      label: input.label ?? "agent",
      address: normalizeAddress(spender.address),
      parentId: treasury.id,
      spendCapAtomic: input.spendCapAtomic.toString(),
      spentAtomic: "0",
      balanceAtomic: "0",
      createdAt: nowIso(),
      cdp: {
        ownerAddress: treasury.cdp?.ownerAddress,
        spendPermission: {
          account: permission.account,
          spender: permission.spender,
          token: "usdc",
          allowance: permission.allowance.toString(),
          periodInDays: permission.periodInDays,
        },
      },
    };
    await this.store.putWallet(wallet);
    return clone(wallet);
  }

  async fund(id: string, amountAtomic: bigint): Promise<Wallet> {
    if (amountAtomic <= 0n) {
      throw new WalletError("invalid_amount", "fund amount must be greater than 0");
    }
    if (this.network !== "base-sepolia") {
      throw new WalletError(
        "faucet_unavailable",
        "CDP fund() calls requestFaucet on base-sepolia only. There is no mainnet faucet in this adapter.",
        400,
      );
    }
    const wallet = await this.require(id);
    const sdk = await this.sdk();
    await sdk.evm.requestFaucet({
      address: wallet.address,
      network: "base-sepolia",
      token: "usdc",
    });
    // Faucet drip size is Coinbase's. amountAtomic is the market spend-cap credit.
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
    const account = await this.accountFor(payer.address);

    if (payer.cdp?.spendPermission && account.useSpendPermission) {
      await account.useSpendPermission({
        spendPermission: {
          account: payer.cdp.spendPermission.account,
          spender: payer.cdp.spendPermission.spender,
          token: "usdc",
          allowance: BigInt(payer.cdp.spendPermission.allowance),
          periodInDays: payer.cdp.spendPermission.periodInDays,
        },
        value: input.amountAtomic,
        network: this.network,
      });
    }

    const sellerTx = await account.transfer({
      to: normalizeAddress(input.sellerAddress),
      amount: sellerAtomic,
      token: "usdc",
      network: this.network,
    });
    let protocolTx: CdpTransferResult | undefined;
    if (protocolAtomic > 0n) {
      protocolTx = await account.transfer({
        to: normalizeAddress(input.protocolAddress),
        amount: protocolAtomic,
        token: "usdc",
        network: this.network,
      });
    }

    payer.balanceAtomic = (balance - input.amountAtomic).toString();
    if (payer.kind === "agent") {
      payer.spentAtomic = (BigInt(payer.spentAtomic) + input.amountAtomic).toString();
    }
    await this.store.putWallet(payer);
    await this.credit(input.sellerAddress, sellerAtomic);
    await this.credit(input.protocolAddress, protocolAtomic);

    const txHash =
      hashOf(sellerTx) ?? hashOf(protocolTx) ?? `cdp:${payer.id}:${nowIso()}`;

    return {
      txHash,
      sellerAtomic,
      protocolAtomic,
      payer: clone(payer),
      sellerTxHash: hashOf(sellerTx),
      protocolTxHash: hashOf(protocolTx),
      onChainSettlement: "cdp_split_90_10",
    };
  }

  private async require(id: string): Promise<Wallet> {
    const wallet = await this.store.getWallet(id);
    if (!wallet) throw new WalletError("wallet_not_found", `wallet ${id} not found`, 404);
    return { ...wallet, cdp: wallet.cdp ? { ...wallet.cdp } : undefined };
  }

  private async credit(address: string, amount: bigint): Promise<void> {
    if (amount === 0n) return;
    const existing = await this.store.getWalletByAddress(normalizeAddress(address));
    if (!existing) return;
    existing.balanceAtomic = (BigInt(existing.balanceAtomic) + amount).toString();
    await this.store.putWallet(existing);
  }

  private cache(account: CdpAccountLike): void {
    this.accounts.set(account.address.toLowerCase(), account);
  }

  private async accountFor(address: string): Promise<CdpAccountLike> {
    const cached = this.accounts.get(address.toLowerCase());
    if (cached) return cached;
    const sdk = await this.sdk();
    if (!sdk.evm.getAccount) {
      throw new WalletError("cdp_account_missing", `no cached CDP account for ${address}`, 500);
    }
    const account = await sdk.evm.getAccount({ address });
    this.cache(account);
    return account;
  }

  private async sdk(): Promise<CdpSdkLike> {
    if (this.client) return this.client;
    this.client = await loadCdpClient(this.env);
    return this.client;
  }
}

function clone(wallet: Wallet): Wallet {
  return {
    ...wallet,
    cdp: wallet.cdp
      ? {
          ...wallet.cdp,
          spendPermission: wallet.cdp.spendPermission ? { ...wallet.cdp.spendPermission } : undefined,
        }
      : undefined,
  };
}

function hashOf(result: CdpTransferResult | undefined): string | undefined {
  return result?.transactionHash || result?.userOpHash;
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
 * Live CDP chain. Unset NETWORK → `base-sepolia`. Explicit `base` / `eip155:8453`
 * is the only way to select mainnet. Catalog `loadConfig` defaults are ignored.
 */
export function resolveCdpNetwork(env: NodeJS.ProcessEnv = process.env): CdpNetworkId {
  const raw = env.CDP_NETWORK?.trim() || env.NETWORK?.trim();
  if (!raw) return "base-sepolia";
  if (isMainnetCaip2(raw) || raw === "base" || raw === BASE_CAIP2) return "base";
  const parsed = parseListingNetwork(raw);
  return parsed === BASE_SEPOLIA_CAIP2 ? "base-sepolia" : "base";
}

export function cdpNetworkToCaip2(network: CdpNetworkId): typeof BASE_SEPOLIA_CAIP2 | typeof BASE_CAIP2 {
  return network === "base" ? BASE_CAIP2 : BASE_SEPOLIA_CAIP2;
}

/**
 * Default factory: memory wallet unless `WALLET_ADAPTER=cdp` **and** all three
 * keys are present. The live adapter is never constructed when keys are missing.
 */
export function createWalletPort(
  store: MarketStore,
  env: NodeJS.ProcessEnv = process.env,
  options: CdpWalletAdapterOptions = {},
): WalletPort {
  if (!shouldUseCdpWallet(env)) {
    return new MemoryWalletAdapter(store);
  }
  const missing = missingCdpKeys(env);
  if (missing.length > 0) {
    throw new Error(
      `CdpWalletAdapter requires ${missing.join(", ")}. ` +
        `It is env-flagged via ${WALLET_ADAPTER_ENV}=cdp. ` +
        "Use MemoryWalletAdapter for local/CI. See docs/WALLET.md.",
    );
  }
  return new CdpWalletAdapter(env, { store, client: options.client });
}

export function createCdpWalletAdapter(
  env: NodeJS.ProcessEnv = process.env,
  options: CdpWalletAdapterOptions = {},
): WalletPort {
  return new CdpWalletAdapter(env, options);
}

/** Load the real SDK. Tests must inject `client` so this is never called in CI. */
export async function loadCdpClient(env: NodeJS.ProcessEnv): Promise<CdpSdkLike> {
  const missing = missingCdpKeys(env);
  if (missing.length > 0) {
    throw new Error(`loadCdpClient requires ${missing.join(", ")}`);
  }
  const { CdpClient } = await import("@coinbase/cdp-sdk");
  return new CdpClient({
    apiKeyId: env.CDP_API_KEY_ID,
    apiKeySecret: env.CDP_API_KEY_SECRET,
    walletSecret: env.CDP_WALLET_SECRET,
  }) as unknown as CdpSdkLike;
}
