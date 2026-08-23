import { createApp } from "../app.js";
import {
  BASE_CAIP2,
  BASE_SEPOLIA_CAIP2,
  USDC_BASE_SEPOLIA_ADDRESS,
  formatUsdc,
  splitProceeds,
} from "../domain/money.js";
import {
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  decodeX402Header,
  encodeX402Header,
  readHeader,
  type PaymentRequired,
} from "../domain/x402.js";
import { PUBLIC_X402_FACILITATOR_URL, STAGING_AMOUNT_ATOMIC, resolveStagingLoopEnv } from "./env.js";
import { payerAddressFromKey, signExactEvmPayment } from "./signer.js";

export interface SepoliaLoopReceipt {
  id: string;
  transaction: string;
  network: string;
  amountAtomic: string;
  sellerAtomic: string;
  protocolAtomic: string;
  payerAddress: string;
  sellerAddress: string;
}

export type SepoliaLoopResult =
  | { skipped: true; reason: string }
  | { skipped: false; receipt: SepoliaLoopReceipt; facilitatorUrl: string; payerAddress: string };

/**
 * Opt-in Base Sepolia x402 loop. HTTP listing only (desktop stays behind BERTHOS_URL
 * on the main server, not this script). Never quotes or settles eip155:8453.
 */
export async function runSepoliaLoop(options: {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
} = {}): Promise<SepoliaLoopResult> {
  const env = options.env ?? process.env;
  const log = options.log ?? console.log;
  const resolved = resolveStagingLoopEnv(env);

  if (resolved.skipped) {
    log(resolved.reason);
    return { skipped: true, reason: resolved.reason };
  }

  const payerAddress = payerAddressFromKey(resolved.payerPrivateKey);
  const { app } = await createApp({
    env: {
      ...env,
      FACILITATOR_URL: resolved.facilitatorUrl,
      WALLET_ADAPTER: "memory",
      NETWORK: BASE_SEPOLIA_CAIP2,
    },
    fetchImpl: options.fetchImpl,
  });

  const listed = await json(app, "POST", "/listings", {
    kind: "http",
    title: "sepolia.staging.ping",
    description: "Base Sepolia staging SKU — testnet USDC only",
    price: {
      amount: STAGING_AMOUNT_ATOMIC,
      asset: "USDC",
      network: BASE_SEPOLIA_CAIP2,
    },
    payTo: resolved.payTo,
    endpoint: { url: "https://example.com/sepolia-ping", method: "GET" },
  });
  const listing = listed.listing as { id: string; price: { network: string; amount: string } };
  if (listing.price.network !== BASE_SEPOLIA_CAIP2) {
    throw new Error(`staging listing stored ${listing.price.network}, expected ${BASE_SEPOLIA_CAIP2}`);
  }

  const unpaid = await app.request(`/listings/${listing.id}/invoke`);
  if (unpaid.status !== 402) {
    throw new Error(`expected 402, got ${unpaid.status}: ${await unpaid.text()}`);
  }
  const requiredHeader = readHeader(unpaid.headers, PAYMENT_REQUIRED_HEADER);
  if (!requiredHeader) throw new Error("missing PAYMENT-REQUIRED header");
  const quote = decodeX402Header<PaymentRequired>(requiredHeader);
  const accepted = quote.accepts[0];
  if (!accepted) throw new Error("quote has no accepts[]");
  assertStagingQuote(accepted);

  const { payload } = await signExactEvmPayment({
    privateKey: resolved.payerPrivateKey,
    quote,
  });
  if (payload.accepted.network === BASE_CAIP2) {
    throw new Error("sepolia-loop refused to sign a mainnet (eip155:8453) quote");
  }

  const paid = await app.request(`/listings/${listing.id}/invoke`, {
    headers: { [PAYMENT_SIGNATURE_HEADER]: encodeX402Header(payload) },
  });
  if (paid.status !== 200) {
    throw new Error(`expected 200 after pay, got ${paid.status}: ${await paid.text()}`);
  }
  if (!readHeader(paid.headers, PAYMENT_RESPONSE_HEADER)) {
    throw new Error("missing PAYMENT-RESPONSE header");
  }

  const body = (await paid.json()) as { receipt: SepoliaLoopReceipt };
  const receipt = body.receipt;
  const expected = splitProceeds(BigInt(STAGING_AMOUNT_ATOMIC));
  if (receipt.network !== BASE_SEPOLIA_CAIP2) {
    throw new Error(`receipt.network is ${receipt.network}, expected ${BASE_SEPOLIA_CAIP2}`);
  }
  if (!receipt.transaction) {
    throw new Error("receipt is missing facilitator settle / tx hash");
  }
  if (receipt.sellerAtomic !== expected.sellerAtomic.toString()) {
    throw new Error(`expected seller 90% ${expected.sellerAtomic}, got ${receipt.sellerAtomic}`);
  }
  if (receipt.protocolAtomic !== expected.protocolAtomic.toString()) {
    throw new Error(`expected protocol 10% ${expected.protocolAtomic}, got ${receipt.protocolAtomic}`);
  }

  log("Berth Market Base Sepolia x402 loop — ok (testnet, not mainnet)");
  log(`  network     ${BASE_SEPOLIA_CAIP2}  USDC ${USDC_BASE_SEPOLIA_ADDRESS}`);
  log(`  facilitator ${resolved.facilitatorUrl}`);
  log(`  listing     ${listing.id}  ${formatUsdc(BigInt(STAGING_AMOUNT_ATOMIC))} USDC`);
  log(`  payer       ${payerAddress}`);
  log(`  payTo       ${resolved.payTo}`);
  log(`  unpaid      HTTP 402 + ${PAYMENT_REQUIRED_HEADER}`);
  log(`  paid        HTTP 200 + ${PAYMENT_RESPONSE_HEADER}  tx=${receipt.transaction}`);
  log(
    `  split       seller ${formatUsdc(BigInt(receipt.sellerAtomic))} (90%)  protocol ${formatUsdc(BigInt(receipt.protocolAtomic))} (10%)`,
  );
  log("  note        on-chain transfer is 100% to payTo; 90/10 is receipt accounting (no second ledger)");

  return {
    skipped: false,
    receipt,
    facilitatorUrl: resolved.facilitatorUrl,
    payerAddress,
  };
}

export function assertStagingQuote(accepted: {
  network: string;
  asset: string;
  amount: string;
}): void {
  if (accepted.network === BASE_CAIP2 || accepted.network === "base") {
    throw new Error("staging quote used Base mainnet (eip155:8453); refusing to pay");
  }
  if (accepted.network !== BASE_SEPOLIA_CAIP2) {
    throw new Error(`staging quote network is ${accepted.network}, expected ${BASE_SEPOLIA_CAIP2}`);
  }
  if (accepted.asset.toLowerCase() !== USDC_BASE_SEPOLIA_ADDRESS.toLowerCase()) {
    throw new Error(
      `staging quote asset is ${accepted.asset}, expected Base Sepolia USDC ${USDC_BASE_SEPOLIA_ADDRESS}`,
    );
  }
  if (accepted.amount !== STAGING_AMOUNT_ATOMIC) {
    throw new Error(`staging quote amount is ${accepted.amount}, expected ${STAGING_AMOUNT_ATOMIC}`);
  }
}

export { PUBLIC_X402_FACILITATOR_URL };

async function json(
  app: { request: typeof import("hono").Hono.prototype.request },
  method: string,
  path: string,
  body?: unknown,
) {
  const response = await app.request(path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    throw new Error(`${method} ${path} → ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as {
    listing: { id: string; title: string; price: { network: string; amount: string } };
  };
}
