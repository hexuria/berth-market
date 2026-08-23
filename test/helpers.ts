import { createApp } from "../src/app.js";
import type { MarketDependencies } from "../src/deps.js";
import { PAYMENT_REQUIRED_HEADER, decodeX402Header, type PaymentRequired } from "../src/domain/x402.js";
import { buildTestPayment } from "../src/testing/pay.js";
import type { Hono } from "hono";

export interface TestMarket {
  app: Hono;
  deps: MarketDependencies;
}

export async function bootMarket(): Promise<TestMarket> {
  const { app, deps } = await createApp();
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
      attestedAt: "2026-08-23T07:00:00.000Z",
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
