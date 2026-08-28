import { describe, expect, it } from "vitest";
import {
  BASE_CAIP2,
  BASE_SEPOLIA_CAIP2,
  USDC_BASE_ADDRESS,
  USDC_BASE_SEPOLIA_ADDRESS,
} from "../src/domain/money.js";
import { PAYMENT_RESPONSE_HEADER, PAYMENT_SIGNATURE_HEADER, encodeX402Header } from "../src/domain/x402.js";
import { buildTestPayment } from "../src/testing/pay.js";
import {
  bootMarket,
  createSellerAndAgent,
  mcpListing,
  payHeaders,
  quoteOf,
  requestJson,
} from "./helpers.js";

const PAY_TO = "0x1111111111111111111111111111111111111111";

describe("MCP invoke / pay / earn", () => {
  it("creates an mcp listing with endpoint.tool and quotes 402 on Base Sepolia by default", async () => {
    const { app } = await bootMarket();

    const listed = await requestJson(app, "POST", "/listings", mcpListing(PAY_TO));
    expect(listed.status).toBe(201);
    const listing = listed.json.listing as {
      id: string;
      kind: string;
      price: { network: string; amount: string };
      endpoint?: { url: string; method: string; tool?: string };
    };
    expect(listing.kind).toBe("mcp");
    expect(listing.endpoint?.url).toBe("https://mcp.example.com/sse");
    expect(listing.endpoint?.tool).toBe("search");
    expect(listing.price.network).toBe(BASE_SEPOLIA_CAIP2);

    const unpaid = await requestJson(app, "GET", `/listings/${listing.id}/invoke`);
    expect(unpaid.status).toBe(402);
    expect(unpaid.headers.get("payment-required") ?? unpaid.headers.get("PAYMENT-REQUIRED")).toBeTruthy();
    const quote = unpaid.json.quote as {
      x402Version: number;
      accepts: { amount: string; network: string; asset: string }[];
    };
    expect(quote.x402Version).toBe(2);
    expect(quote.accepts[0]?.amount).toBe("100000");
    expect(quote.accepts[0]?.network).toBe(BASE_SEPOLIA_CAIP2);
    expect(quote.accepts[0]?.asset).toBe(USDC_BASE_SEPOLIA_ADDRESS);
    expect(quote.accepts[0]?.asset).not.toBe(USDC_BASE_ADDRESS);
    expect(JSON.stringify(unpaid.json)).not.toContain(`"${BASE_CAIP2}"`);
    expect(JSON.stringify(unpaid.json)).not.toContain(USDC_BASE_ADDRESS);
  });

  it("quotes an explicit eip155:8453 mcp listing on mainnet USDC", async () => {
    const { app } = await bootMarket();
    const listed = await requestJson(
      app,
      "POST",
      "/listings",
      mcpListing(PAY_TO, { price: { amount: "100000", asset: "USDC", network: BASE_CAIP2 } }),
    );
    expect(listed.status).toBe(201);
    const listing = listed.json.listing as { id: string; price: { network: string } };
    expect(listing.price.network).toBe(BASE_CAIP2);

    const unpaid = await requestJson(app, "GET", `/listings/${listing.id}/invoke`);
    expect(unpaid.status).toBe(402);
    const accepted = (unpaid.json.quote as { accepts: { network: string; asset: string }[] }).accepts[0];
    expect(accepted?.network).toBe(BASE_CAIP2);
    expect(accepted?.asset).toBe(USDC_BASE_ADDRESS);
    expect(JSON.stringify(unpaid.json)).not.toContain(BASE_SEPOLIA_CAIP2);
  });

  it("paid MCP invoke returns 200 + receipt with MemoryWallet 90/10 and onChainSettlement=payTo_100", async () => {
    const { app, deps } = await bootMarket();
    const { treasury, agent } = await createSellerAndAgent(app, {
      spendCap: "5000000",
      fund: "2000000",
    });

    const listed = await requestJson(app, "POST", "/listings", mcpListing(treasury.address));
    expect(listed.status).toBe(201);
    const listing = listed.json.listing as { id: string };

    const unpaid = await requestJson(app, "GET", `/listings/${listing.id}/invoke`);
    expect(unpaid.status).toBe(402);

    const required = await quoteOf(app, listing.id);
    const paid = await requestJson(
      app,
      "GET",
      `/listings/${listing.id}/invoke`,
      undefined,
      payHeaders(required, agent.id, agent.address),
    );
    expect(paid.status).toBe(200);
    expect(
      paid.headers.get(PAYMENT_RESPONSE_HEADER.toLowerCase()) ?? paid.headers.get(PAYMENT_RESPONSE_HEADER),
    ).toBeTruthy();

    const fulfillment = paid.json.fulfillment as {
      status: string;
      kind: string;
      tool: string;
      result: { ok: boolean; tool: string; proxied: boolean };
      endpoint?: { tool?: string };
    };
    expect(fulfillment.status).toBe("accepted");
    expect(fulfillment.kind).toBe("mcp");
    expect(fulfillment.tool).toBe("search");
    expect(fulfillment.result).toEqual({ ok: true, tool: "search", proxied: false });
    expect(fulfillment.endpoint?.tool).toBe("search");

    const receipt = paid.json.receipt as {
      amountAtomic: string;
      sellerAtomic: string;
      protocolAtomic: string;
      sellerAddress: string;
      onChainSettlement?: string;
      network: string;
    };
    expect(receipt.amountAtomic).toBe("100000");
    expect(receipt.sellerAtomic).toBe("90000");
    expect(receipt.protocolAtomic).toBe("10000");
    expect(receipt.sellerAddress).toBe(treasury.address);
    expect(receipt.network).toBe(BASE_SEPOLIA_CAIP2);
    expect(receipt.onChainSettlement).toBe("payTo_100");
    expect(receipt.onChainSettlement).not.toBe("cdp_split_90_10");

    const sellerAfter = await requestJson(app, "GET", `/wallets/${treasury.id}`);
    const agentAfter = await requestJson(app, "GET", `/wallets/${agent.id}`);
    const protocolAfter = await requestJson(app, "GET", `/wallets/${deps.protocolTreasury.id}`);

    expect((sellerAfter.json.wallet as { balanceAtomic: string }).balanceAtomic).toBe("90000");
    expect((protocolAfter.json.wallet as { balanceAtomic: string }).balanceAtomic).toBe("10000");
    expect((agentAfter.json.wallet as { balanceAtomic: string; spentAtomic: string }).balanceAtomic).toBe(
      "1900000",
    );
    expect((agentAfter.json.wallet as { spentAtomic: string }).spentAtomic).toBe("100000");
  });

  it("rejects a replayed nonce on MCP invoke without a second charge", async () => {
    const { app } = await bootMarket();
    const { treasury, agent } = await createSellerAndAgent(app, { fund: "2000000" });
    const listed = await requestJson(app, "POST", "/listings", mcpListing(treasury.address));
    const listing = listed.json.listing as { id: string };
    const quote = await quoteOf(app, listing.id);
    const headers = payHeaders(quote, agent.id, agent.address);

    const first = await requestJson(app, "GET", `/listings/${listing.id}/invoke`, undefined, headers);
    expect(first.status).toBe(200);

    const replay = await requestJson(app, "GET", `/listings/${listing.id}/invoke`, undefined, headers);
    expect(replay.status).toBe(402);
    expect((replay.json.error as { code: string }).code).toBe("payment_required");

    const agentAfter = await requestJson(app, "GET", `/wallets/${agent.id}`);
    const sellerAfter = await requestJson(app, "GET", `/wallets/${treasury.id}`);
    expect((agentAfter.json.wallet as { spentAtomic: string }).spentAtomic).toBe("100000");
    expect((sellerAfter.json.wallet as { balanceAtomic: string }).balanceAtomic).toBe("90000");

    const receipts = await requestJson(app, "GET", `/receipts?listingId=${listing.id}`);
    expect((receipts.json.receipts as unknown[]).length).toBe(1);
  });

  it("rejects an MCP invoke that would exceed the agent spend cap without charging", async () => {
    const { app, deps } = await bootMarket();
    const { treasury, agent } = await createSellerAndAgent(app, {
      spendCap: "50000",
      fund: "2000000",
    });
    const listed = await requestJson(app, "POST", "/listings", mcpListing(treasury.address));
    const listing = listed.json.listing as { id: string };
    const quote = await quoteOf(app, listing.id);

    const paid = await requestJson(
      app,
      "GET",
      `/listings/${listing.id}/invoke`,
      undefined,
      payHeaders(quote, agent.id, agent.address),
    );
    expect(paid.status).toBe(402);
    expect((paid.json.error as { code: string }).code).toBe("spend_cap_exceeded");

    const agentAfter = await requestJson(app, "GET", `/wallets/${agent.id}`);
    const sellerAfter = await requestJson(app, "GET", `/wallets/${treasury.id}`);
    const protocolAfter = await requestJson(app, "GET", `/wallets/${deps.protocolTreasury.id}`);
    expect((agentAfter.json.wallet as { spentAtomic: string; balanceAtomic: string }).spentAtomic).toBe("0");
    expect((agentAfter.json.wallet as { balanceAtomic: string }).balanceAtomic).toBe("2000000");
    expect((sellerAfter.json.wallet as { balanceAtomic: string }).balanceAtomic).toBe("0");
    expect((protocolAfter.json.wallet as { balanceAtomic: string }).balanceAtomic).toBe("0");

    const receipts = await requestJson(app, "GET", `/receipts?listingId=${listing.id}`);
    expect((receipts.json.receipts as unknown[]).length).toBe(0);
  });

  it("rejects a bad PAYMENT-SIGNATURE on MCP invoke without charging", async () => {
    const { app, deps } = await bootMarket();
    const { treasury, agent } = await createSellerAndAgent(app, { fund: "2000000" });
    const listed = await requestJson(app, "POST", "/listings", mcpListing(treasury.address));
    const listing = listed.json.listing as { id: string };
    const quote = await quoteOf(app, listing.id);
    const { payload } = buildTestPayment({ quote, walletId: agent.id, from: agent.address });
    payload.payload.signature = "not-a-test-signature";

    const paid = await requestJson(app, "GET", `/listings/${listing.id}/invoke`, undefined, {
      [PAYMENT_SIGNATURE_HEADER]: encodeX402Header(payload),
    });
    expect(paid.status).toBe(402);
    expect((paid.json.error as { code: string }).code).toBe("payment_required");
    expect(paid.headers.get("payment-required") ?? paid.headers.get("PAYMENT-REQUIRED")).toBeTruthy();

    const agentAfter = await requestJson(app, "GET", `/wallets/${agent.id}`);
    const sellerAfter = await requestJson(app, "GET", `/wallets/${treasury.id}`);
    const protocolAfter = await requestJson(app, "GET", `/wallets/${deps.protocolTreasury.id}`);
    expect((agentAfter.json.wallet as { spentAtomic: string }).spentAtomic).toBe("0");
    expect((sellerAfter.json.wallet as { balanceAtomic: string }).balanceAtomic).toBe("0");
    expect((protocolAfter.json.wallet as { balanceAtomic: string }).balanceAtomic).toBe("0");

    const receipts = await requestJson(app, "GET", `/receipts?listingId=${listing.id}`);
    expect((receipts.json.receipts as unknown[]).length).toBe(0);
  });

  it("rejects an mcp listing without endpoint.tool", async () => {
    const { app } = await bootMarket();
    const res = await requestJson(app, "POST", "/listings", {
      kind: "mcp",
      title: "search.web",
      price: { amount: "250000", asset: "USDC" },
      payTo: PAY_TO,
      endpoint: { url: "https://mcp.example.com/sse", method: "POST" },
    });
    expect(res.status).toBe(400);
    expect((res.json.error as { code: string }).code).toBe("endpoint_required");
  });

  it("still rejects an mcp listing that claims class=laptop", async () => {
    const { app } = await bootMarket();
    const res = await requestJson(app, "POST", "/listings", mcpListing(PAY_TO, { class: "laptop" }));
    expect(res.status).toBe(400);
    expect((res.json.error as { code: string }).code).toBe("forbidden_class");
  });
});
