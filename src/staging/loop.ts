import { MemoryEligibilityClient } from "../adapters/memory-eligibility.js";
import { MemoryLeaseClient } from "../adapters/memory-lease.js";
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

const DESKTOP_OCCUPANCY_SECONDS = 12;

export interface SepoliaLoopReceipt {
  id: string;
  transaction: string;
  network: string;
  amountAtomic: string;
  sellerAtomic: string;
  protocolAtomic: string;
  payerAddress: string;
  sellerAddress: string;
  onChainSettlement?: "payTo_100" | "cdp_split_90_10";
  leaseId?: string;
}

export interface SepoliaLoopKindResult {
  kind: "http" | "mcp" | "desktop.linux";
  listingId: string;
  title: string;
  receipt: SepoliaLoopReceipt;
  fulfillment?: Record<string, unknown>;
}

export interface SepoliaLoopOccupancy {
  chargedHere: boolean;
  seconds: number;
  billedSeconds: number;
}

export type SepoliaLoopResult =
  | { skipped: true; reason: string }
  | {
      skipped: false;
      http: SepoliaLoopKindResult;
      mcp: SepoliaLoopKindResult;
      desktop: SepoliaLoopKindResult & { occupancy: SepoliaLoopOccupancy };
      refused: { laptop: true; hostDesktop: true };
      facilitatorUrl: string;
      payerAddress: string;
      protocolBalanceAtomic: string;
    };

/**
 * Strip Berthos / CDP knobs so this script cannot lease a live node or
 * construct CdpWalletAdapter. Keeps FACILITATOR_URL + staging keys.
 */
export function sepoliaLoopAppEnv(
  source: NodeJS.ProcessEnv,
  extras: { facilitatorUrl: string },
): NodeJS.ProcessEnv {
  const env = { ...source };
  delete env.BERTHOS_URL;
  delete env.BERTHOS_LEASE_TOKEN;
  delete env.BERTHOS_PAIR_CODE;
  delete env.CDP_API_KEY_ID;
  delete env.CDP_API_KEY_SECRET;
  delete env.CDP_WALLET_SECRET;
  env.WALLET_ADAPTER = "memory";
  env.FACILITATOR_URL = extras.facilitatorUrl;
  env.NETWORK = BASE_SEPOLIA_CAIP2;
  return env;
}

/**
 * Opt-in Base Sepolia x402 loop. HTTP + MCP + desktop.linux — same catalog
 * kinds as earn-loop. Desktop uses in-process MemoryEligibility/MemoryLease
 * (no BERTHOS_URL, no Docker). Never quotes or settles eip155:8453.
 */
export async function runSepoliaLoop(
  options: {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
    log?: (line: string) => void;
  } = {},
): Promise<SepoliaLoopResult> {
  const env = options.env ?? process.env;
  const log = options.log ?? console.log;
  const resolved = resolveStagingLoopEnv(env);

  if (resolved.skipped) {
    log(resolved.reason);
    return { skipped: true, reason: resolved.reason };
  }

  const payerAddress = payerAddressFromKey(resolved.payerPrivateKey);
  const leases = new MemoryLeaseClient({ occupancySecondsOnEnd: DESKTOP_OCCUPANCY_SECONDS });
  const { app, deps } = await createApp({
    env: sepoliaLoopAppEnv(env, { facilitatorUrl: resolved.facilitatorUrl }),
    eligibility: new MemoryEligibilityClient(),
    leases,
    fetchImpl: options.fetchImpl,
  });

  const http = await payKind(app, {
    kind: "http",
    privateKey: resolved.payerPrivateKey,
    listing: {
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
    },
  });
  if (http.receipt.leaseId) {
    throw new Error("HTTP receipt must not carry a leaseId");
  }

  const mcp = await payKind(app, {
    kind: "mcp",
    privateKey: resolved.payerPrivateKey,
    listing: {
      kind: "mcp",
      title: "sepolia.staging.search",
      description: "Base Sepolia MCP SKU — in-process stub, not a live MCP server",
      price: {
        amount: STAGING_AMOUNT_ATOMIC,
        asset: "USDC",
        network: BASE_SEPOLIA_CAIP2,
      },
      payTo: resolved.payTo,
      endpoint: { url: "https://mcp.example.com/sse", method: "POST", tool: "search" },
    },
  });
  if (mcp.receipt.leaseId) {
    throw new Error("MCP receipt must not carry a leaseId");
  }
  const mcpFulfillment = mcp.fulfillment as {
    kind?: string;
    tool?: string;
    result?: { proxied?: boolean; tool?: string };
    endpoint?: { url?: string; tool?: string };
  };
  if (mcpFulfillment.kind !== "mcp" || mcpFulfillment.tool !== "search") {
    throw new Error(`expected MCP fulfillment tool=search, got ${JSON.stringify(mcp.fulfillment)}`);
  }
  if (mcpFulfillment.result?.proxied !== false) {
    throw new Error("MCP fulfillment must stay the in-process stub (proxied: false)");
  }
  if (!mcpFulfillment.endpoint?.url || mcpFulfillment.endpoint.tool !== "search") {
    throw new Error("MCP listing must publish endpoint.url + endpoint.tool");
  }

  const desktopPaid = await payKind(app, {
    kind: "desktop.linux",
    privateKey: resolved.payerPrivateKey,
    listing: {
      kind: "desktop.linux",
      title: "sepolia.staging.desktop",
      description: "Base Sepolia desktop SKU — in-process MemoryLease, no Berthos",
      price: {
        amount: STAGING_AMOUNT_ATOMIC,
        asset: "USDC",
        network: BASE_SEPOLIA_CAIP2,
      },
      payTo: resolved.payTo,
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
    },
  });
  const desktopFulfillment = desktopPaid.fulfillment as { leaseId?: string };
  if (!desktopPaid.receipt.leaseId || desktopPaid.receipt.leaseId !== desktopFulfillment.leaseId) {
    throw new Error("desktop.linux pay must return a leaseId on fulfillment and receipt");
  }

  const ended = await json(app, "POST", `/receipts/${desktopPaid.receipt.id}/end`);
  const occupancy = ended.occupancy as SepoliaLoopOccupancy | undefined;
  if (!occupancy || occupancy.chargedHere !== false) {
    throw new Error(
      `end-lease must store occupancy with chargedHere: false, got ${JSON.stringify(ended.occupancy)}`,
    );
  }

  await refuseForbidden(app, resolved.payTo, "laptop");
  await refuseForbidden(app, resolved.payTo, "host-desktop");

  const protocolAfter = await json(app, "GET", `/wallets/${deps.protocolTreasury.id}`);
  const protocolBalanceAtomic = protocolAfter.wallet.balanceAtomic;
  if (protocolBalanceAtomic !== "0") {
    throw new Error(
      `protocol MemoryWallet must stay 0 after facilitator settle (no second ledger), got ${protocolBalanceAtomic}`,
    );
  }

  log("Berth Market Base Sepolia x402 loop — ok (HTTP + MCP + desktop.linux, testnet, not mainnet)");
  log(`  network     ${BASE_SEPOLIA_CAIP2}  USDC ${USDC_BASE_SEPOLIA_ADDRESS}`);
  log(`  facilitator ${resolved.facilitatorUrl}`);
  log(`  payer       ${payerAddress}`);
  log(`  payTo       ${resolved.payTo}`);
  logKind(log, http, {
    extra: `90/10  onChainSettlement=${http.receipt.onChainSettlement}`,
  });
  logKind(log, mcp, {
    extra: `proxied=false  no leaseId  90/10  onChainSettlement=${mcp.receipt.onChainSettlement}`,
  });
  logKind(log, desktopPaid, {
    extra: `leaseId=${desktopPaid.receipt.leaseId}  90/10  onChainSettlement=${desktopPaid.receipt.onChainSettlement}`,
  });
  log(
    `  end-lease      occupancy=${occupancy.seconds}s billed=${occupancy.billedSeconds}s chargedHere=false`,
  );
  log("  refused        laptop / host-desktop → HTTP 400 forbidden_class");
  log(
    `  protocol       MemoryWallet bal=${formatUsdc(BigInt(protocolBalanceAtomic))}  (facilitator settle does not mint)`,
  );
  log("  note        on-chain transfer is 100% to payTo; 90/10 is receipt accounting (no second ledger)");

  return {
    skipped: false,
    http,
    mcp,
    desktop: { ...desktopPaid, occupancy },
    refused: { laptop: true, hostDesktop: true },
    facilitatorUrl: resolved.facilitatorUrl,
    payerAddress,
    protocolBalanceAtomic,
  };
}

function logKind(
  log: (line: string) => void,
  paid: SepoliaLoopKindResult,
  opts: { extra: string },
): void {
  const amount = formatUsdc(BigInt(paid.receipt.amountAtomic));
  log(`  ${paid.kind.padEnd(14)} ${paid.listingId}  ${paid.title}  ${amount} USDC`);
  log(`  unpaid         HTTP 402 + ${PAYMENT_REQUIRED_HEADER}`);
  log(`  paid           HTTP 200 + ${PAYMENT_RESPONSE_HEADER}  tx=${paid.receipt.transaction}  ${opts.extra}`);
}

async function payKind(
  app: AppLike,
  input: {
    kind: SepoliaLoopKindResult["kind"];
    privateKey: `0x${string}`;
    listing: Record<string, unknown>;
  },
): Promise<SepoliaLoopKindResult> {
  const listed = await json(app, "POST", "/listings", input.listing);
  const listing = listed.listing as { id: string; title: string; kind: string; price: { network: string } };
  if (listing.kind !== input.kind) {
    throw new Error(`expected listing kind ${input.kind}, got ${listing.kind}`);
  }
  if (listing.price.network !== BASE_SEPOLIA_CAIP2) {
    throw new Error(`staging listing stored ${listing.price.network}, expected ${BASE_SEPOLIA_CAIP2}`);
  }

  const unpaid = await app.request(`/listings/${listing.id}/invoke`);
  if (unpaid.status !== 402) {
    throw new Error(`${input.kind}: expected 402, got ${unpaid.status}: ${await unpaid.text()}`);
  }
  const requiredHeader = readHeader(unpaid.headers, PAYMENT_REQUIRED_HEADER);
  if (!requiredHeader) throw new Error(`${input.kind}: missing ${PAYMENT_REQUIRED_HEADER} header`);
  const quote = decodeX402Header<PaymentRequired>(requiredHeader);
  const accepted = quote.accepts[0];
  if (!accepted) throw new Error(`${input.kind}: quote has no accepts[]`);
  assertStagingQuote(accepted);

  const { payload } = await signExactEvmPayment({
    privateKey: input.privateKey,
    quote,
  });
  if (payload.accepted.network === BASE_CAIP2) {
    throw new Error("sepolia-loop refused to sign a mainnet (eip155:8453) quote");
  }

  const paid = await app.request(`/listings/${listing.id}/invoke`, {
    headers: { [PAYMENT_SIGNATURE_HEADER]: encodeX402Header(payload) },
  });
  if (paid.status !== 200) {
    throw new Error(`${input.kind}: expected 200 after pay, got ${paid.status}: ${await paid.text()}`);
  }
  if (!readHeader(paid.headers, PAYMENT_RESPONSE_HEADER)) {
    throw new Error(`${input.kind}: missing ${PAYMENT_RESPONSE_HEADER} header`);
  }

  const body = (await paid.json()) as {
    fulfillment?: Record<string, unknown>;
    receipt: SepoliaLoopReceipt;
  };
  assertFacilitatorReceipt(input.kind, body.receipt);

  return {
    kind: input.kind,
    listingId: listing.id,
    title: listing.title,
    receipt: body.receipt,
    fulfillment: body.fulfillment,
  };
}

function assertFacilitatorReceipt(kind: string, receipt: SepoliaLoopReceipt): void {
  const expected = splitProceeds(BigInt(STAGING_AMOUNT_ATOMIC));
  if (receipt.network !== BASE_SEPOLIA_CAIP2) {
    throw new Error(`${kind}: receipt.network is ${receipt.network}, expected ${BASE_SEPOLIA_CAIP2}`);
  }
  if (!receipt.transaction) {
    throw new Error(`${kind}: receipt is missing facilitator settle / tx hash`);
  }
  if (receipt.amountAtomic !== STAGING_AMOUNT_ATOMIC) {
    throw new Error(`${kind}: amountAtomic ${receipt.amountAtomic}, expected ${STAGING_AMOUNT_ATOMIC}`);
  }
  if (receipt.sellerAtomic !== expected.sellerAtomic.toString()) {
    throw new Error(`${kind}: expected seller 90% ${expected.sellerAtomic}, got ${receipt.sellerAtomic}`);
  }
  if (receipt.protocolAtomic !== expected.protocolAtomic.toString()) {
    throw new Error(`${kind}: expected protocol 10% ${expected.protocolAtomic}, got ${receipt.protocolAtomic}`);
  }
  if (receipt.onChainSettlement !== "payTo_100") {
    throw new Error(
      `${kind}: expected onChainSettlement=payTo_100 (public facilitator is one payTo), got ${receipt.onChainSettlement}`,
    );
  }
}

async function refuseForbidden(app: AppLike, payTo: string, kind: "laptop" | "host-desktop"): Promise<void> {
  const response = await app.request("/listings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind,
      title: `forbidden.${kind}`,
      price: { amount: STAGING_AMOUNT_ATOMIC, asset: "USDC", network: BASE_SEPOLIA_CAIP2 },
      payTo,
      endpoint: { url: "https://example.com/forbidden", method: "GET" },
    }),
  });
  const text = await response.text();
  if (response.status !== 400) {
    throw new Error(`${kind} must be refused, got ${response.status} ${text}`);
  }
  let code = "";
  try {
    code = (JSON.parse(text) as { error?: { code?: string } }).error?.code ?? "";
  } catch {
    code = "";
  }
  if (code !== "forbidden_class") {
    throw new Error(`${kind} must fail closed as forbidden_class, got ${text}`);
  }
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

type AppLike = { request: typeof import("hono").Hono.prototype.request };

async function json(
  app: AppLike,
  method: string,
  path: string,
  body?: unknown,
): Promise<{
  wallet: { id: string; address: string; balanceAtomic: string };
  listing: { id: string; title: string; kind?: string; price: { network: string; amount: string } };
  occupancy?: SepoliaLoopOccupancy;
  receipt?: SepoliaLoopReceipt;
}> {
  const response = await app.request(path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    throw new Error(`${method} ${path} → ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as {
    wallet: { id: string; address: string; balanceAtomic: string };
    listing: { id: string; title: string; kind?: string; price: { network: string; amount: string } };
    occupancy?: SepoliaLoopOccupancy;
    receipt?: SepoliaLoopReceipt;
  };
}
