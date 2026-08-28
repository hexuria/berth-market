import { createApp, type CreateAppOptions } from "../src/app.js";
import type { CdpAccountLike, CdpSdkLike } from "../src/adapters/cdp-wallet.js";
import type { MarketDependencies } from "../src/deps.js";
import { PAYMENT_REQUIRED_HEADER, decodeX402Header, type PaymentRequired } from "../src/domain/x402.js";
import { buildTestPayment } from "../src/testing/pay.js";
import type { Hono } from "hono";

/** Dummy CDP keys for construction tests. Not live credentials. Never used to call Coinbase. */
export const TEST_CDP_ENV = {
  WALLET_ADAPTER: "cdp",
  CDP_API_KEY_ID: "test-cdp-key-id",
  CDP_API_KEY_SECRET: "test-cdp-key-secret",
  CDP_WALLET_SECRET: "test-cdp-wallet-secret",
} as const;

export type MockCdpCall = {
  op: string;
  [key: string]: unknown;
};

/** In-process CDP stand-in. CI must use this instead of `@coinbase/cdp-sdk`. */
export function mockCdpClient(calls: MockCdpCall[] = []): { client: CdpSdkLike; calls: MockCdpCall[] } {
  const accounts = new Map<string, CdpAccountLike>();
  let n = 0;
  const nextAddr = () => {
    n += 1;
    return `0x${n.toString(16).padStart(40, "0")}`;
  };

  function makeAccount(address: string): CdpAccountLike {
    const account: CdpAccountLike = {
      address,
      transfer: async (opts) => {
        calls.push({ op: "transfer", from: address, ...opts, amount: opts.amount.toString() });
        return { transactionHash: `0x${"ab".repeat(32)}` };
      },
      useSpendPermission: async (opts) => {
        calls.push({
          op: "useSpendPermission",
          from: address,
          value: opts.value.toString(),
          network: opts.network,
          account: opts.spendPermission.account,
          spender: opts.spendPermission.spender,
        });
        return { transactionHash: `0x${"cd".repeat(32)}` };
      },
    };
    accounts.set(address.toLowerCase(), account);
    return account;
  }

  const client: CdpSdkLike = {
    evm: {
      createAccount: async (opts = {}) => {
        const account = makeAccount(nextAddr());
        calls.push({ op: "createAccount", name: opts.name, address: account.address });
        return account;
      },
      createSmartAccount: async (opts) => {
        const account = makeAccount(nextAddr());
        calls.push({
          op: "createSmartAccount",
          owner: opts.owner.address,
          name: opts.name,
          enableSpendPermissions: opts.enableSpendPermissions,
          address: account.address,
        });
        return account;
      },
      createSpendPermission: async (opts) => {
        calls.push({
          op: "createSpendPermission",
          network: opts.network,
          account: opts.spendPermission.account,
          spender: opts.spendPermission.spender,
          allowance: opts.spendPermission.allowance.toString(),
          token: opts.spendPermission.token,
        });
        return { userOpHash: `0x${"ef".repeat(32)}` };
      },
      requestFaucet: async (opts) => {
        calls.push({ op: "requestFaucet", ...opts });
        return { transactionHash: `0x${"11".repeat(32)}` };
      },
      getAccount: async (opts) => {
        const found = opts.address ? accounts.get(opts.address.toLowerCase()) : undefined;
        if (!found) throw new Error(`mock CDP has no account ${opts.address}`);
        return found;
      },
    },
  };

  return { client, calls };
}

export interface TestMarket {
  app: Hono;
  deps: MarketDependencies;
}

export async function bootMarket(options: CreateAppOptions = {}): Promise<TestMarket> {
  const { app, deps } = await createApp(options);
  return { app, deps };
}

export async function requestJson(
  app: Hono,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; json: Record<string, unknown>; headers: Headers; text: string }> {
  const response = await app.request(path, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json: Record<string, unknown> = {};
  if (text) {
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = { raw: text };
    }
  }
  return { status: response.status, json, headers: response.headers, text };
}

export async function createSellerAndAgent(
  app: Hono,
  opts: { spendCap?: string; fund?: string } = {},
) {
  const treasury = await requestJson(app, "POST", "/wallets/treasury", { label: "seller" });
  const treasuryWallet = treasury.json.wallet as { id: string; address: string };
  const agent = await requestJson(app, "POST", "/wallets/agent", {
    treasuryId: treasuryWallet.id,
    spendCap: opts.spendCap ?? "5000000",
    label: "agent",
  });
  const agentWallet = agent.json.wallet as { id: string; address: string };
  if (opts.fund) {
    await requestJson(app, "POST", `/wallets/${agentWallet.id}/fund`, { amount: opts.fund });
  }
  return { treasury: treasuryWallet, agent: agentWallet };
}

export function httpListing(payTo: string, extra: Record<string, unknown> = {}) {
  return {
    kind: "http",
    title: "weather.now",
    description: "demo",
    price: { amount: "100000", asset: "USDC", network: "eip155:8453" },
    payTo,
    endpoint: { url: "https://example.com/weather", method: "GET" },
    ...extra,
  };
}

/** MCP SKU. Omits `price.network` so the catalog default (`eip155:84532`) applies. */
export function mcpListing(payTo: string, extra: Record<string, unknown> = {}) {
  return {
    kind: "mcp",
    title: "search.web",
    description: "demo",
    price: { amount: "100000", asset: "USDC" },
    payTo,
    endpoint: { url: "https://mcp.example.com/sse", method: "POST", tool: "search" },
    ...extra,
  };
}

export function desktopListing(payTo: string, extra: Record<string, unknown> = {}) {
  return {
    kind: "desktop.linux",
    title: "gpu-box.session",
    price: { amount: "1000000", asset: "USDC", network: "eip155:8453" },
    payTo,
    class: "vm",
    fulfillment: {
      berthosUrl: "https://berthos.example",
      sku: "linux-gpu-1",
      nodeId: "node_01",
    },
    eligibility: {
      source: "berthos.doctor",
      ok: true,
      class: "vm",
      nodeId: "node_01",
      attestedAt: new Date().toISOString(),
      digest: "sha256:deadbeef",
      berthosUrl: "https://berthos.example",
    },
    ...extra,
  };
}

export async function quoteOf(app: Hono, listingId: string): Promise<PaymentRequired> {
  const unpaid = await requestJson(app, "GET", `/listings/${listingId}/invoke`);
  if (unpaid.status !== 402) {
    throw new Error(`expected 402, got ${unpaid.status} ${unpaid.text}`);
  }
  const header = unpaid.headers.get(PAYMENT_REQUIRED_HEADER) ?? unpaid.headers.get("payment-required");
  if (!header) throw new Error("missing PAYMENT-REQUIRED");
  return decodeX402Header<PaymentRequired>(header);
}

export function payHeaders(quote: PaymentRequired, walletId: string, from: string) {
  return buildTestPayment({ quote, walletId, from }).header;
}
