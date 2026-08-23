/**
 * One fake USDC earn loop against the in-process market.
 * No CDP keys, no chain. Run: `npm run earn-loop`
 */
import { createApp } from "../app.js";
import { formatUsdc } from "../domain/money.js";
import {
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  decodeX402Header,
  encodeX402Header,
  readHeader,
  type PaymentPayload,
  type PaymentRequired,
} from "../domain/x402.js";
import { testPaymentSignature } from "../adapters/test-facilitator.js";

const { app, deps } = await createApp();

const seller = await json(
  app,
  "POST",
  "/wallets/treasury",
  { label: "seller-treasury" },
);
const agent = await json(app, "POST", "/wallets/agent", {
  treasuryId: seller.wallet.id,
  spendCap: "5000000",
  label: "research-agent",
});
await json(app, "POST", `/wallets/${agent.wallet.id}/fund`, { amount: "2000000" });

const listed = await json(app, "POST", "/listings", {
  kind: "http",
  title: "weather.now",
  description: "Demo HTTP SKU",
  price: { amount: "100000", asset: "USDC", network: "eip155:8453" },
  payTo: seller.wallet.address,
  endpoint: { url: "https://example.com/weather", method: "GET" },
});

const unpaid = await app.request(`/listings/${listed.listing.id}/invoke`);
if (unpaid.status !== 402) {
  throw new Error(`expected 402, got ${unpaid.status}`);
}
const requiredHeader = readHeader(unpaid.headers, PAYMENT_REQUIRED_HEADER);
if (!requiredHeader) throw new Error("missing PAYMENT-REQUIRED header");
const quote = decodeX402Header<PaymentRequired>(requiredHeader);
const accepted = quote.accepts[0];
if (!accepted) throw new Error("quote has no accepts[]");

const now = Math.floor(Date.now() / 1000);
const payload: PaymentPayload = {
  x402Version: 2,
  resource: quote.resource,
  accepted,
  payload: {
    signature: testPaymentSignature(agent.wallet.id),
    authorization: {
      from: agent.wallet.address,
      to: accepted.payTo,
      value: accepted.amount,
      validAfter: String(now - 30),
      validBefore: String(now + 60),
      nonce: `0x${crypto.randomUUID().replaceAll("-", "")}`,
    },
  },
};

const paid = await app.request(`/listings/${listed.listing.id}/invoke`, {
  headers: { [PAYMENT_SIGNATURE_HEADER]: encodeX402Header(payload) },
});
if (paid.status !== 200) {
  throw new Error(`expected 200 after pay, got ${paid.status}: ${await paid.text()}`);
}
const body = (await paid.json()) as {
  receipt: { sellerAtomic: string; protocolAtomic: string; amountAtomic: string; transaction: string };
};
if (!readHeader(paid.headers, PAYMENT_RESPONSE_HEADER)) {
  throw new Error("missing PAYMENT-RESPONSE header");
}

const sellerAfter = await json(app, "GET", `/wallets/${seller.wallet.id}`);
const agentAfter = await json(app, "GET", `/wallets/${agent.wallet.id}`);
const protocolAfter = await json(app, "GET", `/wallets/${deps.protocolTreasury.id}`);

console.log("Berth Market fake USDC earn loop — ok");
console.log(`  listing     ${listed.listing.id}  ${listed.listing.title}  ${formatUsdc(100000n)} USDC`);
console.log(`  unpaid      HTTP 402 + ${PAYMENT_REQUIRED_HEADER}`);
console.log(`  paid        HTTP 200 + ${PAYMENT_RESPONSE_HEADER}  tx=${body.receipt.transaction}`);
console.log(`  agent spent ${formatUsdc(BigInt(body.receipt.amountAtomic))}  remaining cap tracked`);
console.log(`  seller earn ${formatUsdc(BigInt(body.receipt.sellerAtomic))}  (90%)  bal=${formatUsdc(BigInt(sellerAfter.wallet.balanceAtomic))}`);
console.log(`  protocol    ${formatUsdc(BigInt(body.receipt.protocolAtomic))}  (10%)  bal=${formatUsdc(BigInt(protocolAfter.wallet.balanceAtomic))}`);
console.log(`  agent left  ${formatUsdc(BigInt(agentAfter.wallet.balanceAtomic))} USDC`);

async function json(app: { request: typeof import("hono").Hono.prototype.request }, method: string, path: string, body?: unknown) {
  const response = await app.request(path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    throw new Error(`${method} ${path} → ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as {
    wallet: {
      id: string;
      address: string;
      balanceAtomic: string;
    };
    listing: { id: string; title: string };
  };
}
