/**
 * Secret-free MemoryWallet earn loop: HTTP + MCP + desktop.linux.
 * TestFacilitator + in-process eligibility/lease. No CDP, no live settle, no Berthos URL.
 */
import { MemoryEligibilityClient } from "../adapters/memory-eligibility.js";
import { MemoryLeaseClient } from "../adapters/memory-lease.js";
import { createApp } from "../app.js";
import { formatUsdc, splitProceeds } from "../domain/money.js";
import type { OnChainSettlement } from "../domain/wallet.js";
import {
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  decodeX402Header,
  readHeader,
  type PaymentRequired,
} from "../domain/x402.js";
import { buildTestPayment } from "../testing/pay.js";

const HTTP_AMOUNT = "100000";
const MCP_AMOUNT = "100000";
const DESKTOP_AMOUNT = "1000000";
const AGENT_FUND = "2000000";
const DESKTOP_OCCUPANCY_SECONDS = 12;

export interface EarnLoopReceipt {
  id: string;
  amountAtomic: string;
  sellerAtomic: string;
  protocolAtomic: string;
  transaction: string;
  onChainSettlement?: OnChainSettlement;
  leaseId?: string;
}

export interface EarnLoopKindResult {
  kind: "http" | "mcp" | "desktop.linux";
  listingId: string;
  title: string;
  receipt: EarnLoopReceipt;
  fulfillment?: Record<string, unknown>;
}

export interface EarnLoopOccupancy {
  chargedHere: boolean;
  seconds: number;
  billedSeconds: number;
}

export interface EarnLoopResult {
  http: EarnLoopKindResult;
  mcp: EarnLoopKindResult;
  desktop: EarnLoopKindResult & { occupancy: EarnLoopOccupancy };
  refused: { laptop: true; hostDesktop: true };
}

/** Strip live / CDP / Berthos knobs so the smoke cannot accidentally settle or lease for real. */
export function earnLoopSmokeEnv(source: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...source };
  delete env.FACILITATOR_URL;
  delete env.BERTHOS_URL;
  delete env.BERTHOS_LEASE_TOKEN;
  delete env.BERTHOS_PAIR_CODE;
  delete env.STAGING_PAYER_PRIVATE_KEY;
  delete env.STAGING_PAY_TO;
  delete env.CDP_API_KEY_ID;
  delete env.CDP_API_KEY_SECRET;
  delete env.CDP_WALLET_SECRET;
  env.WALLET_ADAPTER = "memory";
  return env;
}

export async function runEarnLoop(
  options: {
    env?: NodeJS.ProcessEnv;
    log?: (line: string) => void;
  } = {},
): Promise<EarnLoopResult> {
  const log = options.log ?? console.log;
  const leases = new MemoryLeaseClient({ occupancySecondsOnEnd: DESKTOP_OCCUPANCY_SECONDS });
  const { app, deps } = await createApp({
    env: earnLoopSmokeEnv(options.env),
    eligibility: new MemoryEligibilityClient(),
    leases,
    fetchImpl: async () => {
      throw new Error("earn-loop MemoryWallet smoke must not fetch the network");
    },
  });

  const seller = await json(app, "POST", "/wallets/treasury", { label: "seller-treasury" });
  const agent = await json(app, "POST", "/wallets/agent", {
    treasuryId: seller.wallet.id,
    spendCap: "5000000",
    label: "research-agent",
  });
  await json(app, "POST", `/wallets/${agent.wallet.id}/fund`, { amount: AGENT_FUND });

  const http = await payKind(app, {
    kind: "http",
    title: "weather.now",
    amount: HTTP_AMOUNT,
    walletId: agent.wallet.id,
    from: agent.wallet.address,
    listing: {
      kind: "http",
      title: "weather.now",
      description: "Demo HTTP SKU",
      price: { amount: HTTP_AMOUNT, asset: "USDC", network: "eip155:84532" },
      payTo: seller.wallet.address,
      endpoint: { url: "https://example.com/weather", method: "GET" },
    },
  });
  if (http.receipt.leaseId) {
    throw new Error("HTTP receipt must not carry a leaseId");
  }

  const mcp = await payKind(app, {
    kind: "mcp",
    title: "search.web",
    amount: MCP_AMOUNT,
    walletId: agent.wallet.id,
    from: agent.wallet.address,
    listing: {
      kind: "mcp",
      title: "search.web",
      description: "Demo MCP SKU",
      price: { amount: MCP_AMOUNT, asset: "USDC" },
      payTo: seller.wallet.address,
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
    title: "gpu-box.session",
    amount: DESKTOP_AMOUNT,
    walletId: agent.wallet.id,
    from: agent.wallet.address,
    listing: {
      kind: "desktop.linux",
      title: "gpu-box.session",
      price: { amount: DESKTOP_AMOUNT, asset: "USDC", network: "eip155:84532" },
      payTo: seller.wallet.address,
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
  const occupancy = ended.occupancy as EarnLoopOccupancy | undefined;
  if (!occupancy || occupancy.chargedHere !== false) {
    throw new Error(
      `end-lease must store occupancy with chargedHere: false, got ${JSON.stringify(ended.occupancy)}`,
    );
  }

  await refuseForbidden(app, seller.wallet.address, "laptop");
  await refuseForbidden(app, seller.wallet.address, "host-desktop");

  const sellerAfter = await json(app, "GET", `/wallets/${seller.wallet.id}`);
  const agentAfter = await json(app, "GET", `/wallets/${agent.wallet.id}`);
  const protocolAfter = await json(app, "GET", `/wallets/${deps.protocolTreasury.id}`);

  log("Berth Market fake USDC earn loop — ok (HTTP + MCP + desktop.linux)");
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
    `  agent spent    ${formatUsdc(BigInt(agentAfter.wallet.spentAtomic ?? "0"))}  remaining cap tracked`,
  );
  log(
    `  seller earn    ${formatUsdc(BigInt(sellerAfter.wallet.balanceAtomic))}  (90% × 3)  bal=${formatUsdc(BigInt(sellerAfter.wallet.balanceAtomic))}`,
  );
  log(
    `  protocol       ${formatUsdc(BigInt(protocolAfter.wallet.balanceAtomic))}  (10% × 3)  bal=${formatUsdc(BigInt(protocolAfter.wallet.balanceAtomic))}`,
  );
  log(`  agent left     ${formatUsdc(BigInt(agentAfter.wallet.balanceAtomic))} USDC`);

  return {
    http,
    mcp,
    desktop: { ...desktopPaid, occupancy },
    refused: { laptop: true, hostDesktop: true },
  };
}

function logKind(
  log: (line: string) => void,
  paid: EarnLoopKindResult,
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
    kind: EarnLoopKindResult["kind"];
    title: string;
    amount: string;
    walletId: string;
    from: string;
    listing: Record<string, unknown>;
  },
): Promise<EarnLoopKindResult> {
  const listed = await json(app, "POST", "/listings", input.listing);
  const listing = listed.listing as { id: string; title: string; kind: string };
  if (listing.kind !== input.kind) {
    throw new Error(`expected listing kind ${input.kind}, got ${listing.kind}`);
  }

  const unpaid = await app.request(`/listings/${listing.id}/invoke`);
  if (unpaid.status !== 402) {
    throw new Error(`${input.kind}: expected 402, got ${unpaid.status}: ${await unpaid.text()}`);
  }
  const requiredHeader = readHeader(unpaid.headers, PAYMENT_REQUIRED_HEADER);
  if (!requiredHeader) throw new Error(`${input.kind}: missing ${PAYMENT_REQUIRED_HEADER} header`);
  const quote = decodeX402Header<PaymentRequired>(requiredHeader);

  const { header } = buildTestPayment({
    quote,
    walletId: input.walletId,
    from: input.from,
  });
  const paid = await app.request(`/listings/${listing.id}/invoke`, { headers: header });
  if (paid.status !== 200) {
    throw new Error(`${input.kind}: expected 200 after pay, got ${paid.status}: ${await paid.text()}`);
  }
  if (!readHeader(paid.headers, PAYMENT_RESPONSE_HEADER)) {
    throw new Error(`${input.kind}: missing ${PAYMENT_RESPONSE_HEADER} header`);
  }

  const body = (await paid.json()) as {
    fulfillment?: Record<string, unknown>;
    receipt: EarnLoopReceipt;
  };
  assertMemorySplit(input.kind, body.receipt, input.amount);

  return {
    kind: input.kind,
    listingId: listing.id,
    title: listing.title,
    receipt: body.receipt,
    fulfillment: body.fulfillment,
  };
}

function assertMemorySplit(kind: string, receipt: EarnLoopReceipt, amountAtomic: string): void {
  const expected = splitProceeds(BigInt(amountAtomic));
  if (receipt.amountAtomic !== amountAtomic) {
    throw new Error(`${kind}: amountAtomic ${receipt.amountAtomic}, expected ${amountAtomic}`);
  }
  if (receipt.sellerAtomic !== expected.sellerAtomic.toString()) {
    throw new Error(`${kind}: seller 90% ${expected.sellerAtomic}, got ${receipt.sellerAtomic}`);
  }
  if (receipt.protocolAtomic !== expected.protocolAtomic.toString()) {
    throw new Error(`${kind}: protocol 10% ${expected.protocolAtomic}, got ${receipt.protocolAtomic}`);
  }
  if (receipt.onChainSettlement !== "payTo_100") {
    throw new Error(
      `${kind}: MemoryWallet onChainSettlement must be payTo_100 (90/10 is receipt accounting), got ${receipt.onChainSettlement}`,
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
      price: { amount: "100000", asset: "USDC", network: "eip155:84532" },
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

type AppLike = { request: typeof import("hono").Hono.prototype.request };

async function json(
  app: AppLike,
  method: string,
  path: string,
  body?: unknown,
): Promise<{
  wallet: { id: string; address: string; balanceAtomic: string; spentAtomic?: string };
  listing: { id: string; title: string; kind?: string };
  occupancy?: EarnLoopOccupancy;
  receipt?: EarnLoopReceipt;
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
    wallet: { id: string; address: string; balanceAtomic: string; spentAtomic?: string };
    listing: { id: string; title: string; kind?: string };
    occupancy?: EarnLoopOccupancy;
    receipt?: EarnLoopReceipt;
  };
}
