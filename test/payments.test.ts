import { describe, expect, it } from "vitest";
import { PAYMENT_RESPONSE_HEADER } from "../src/domain/x402.js";
import {
  bootMarket,
  createSellerAndAgent,
  httpListing,
  payHeaders,
  quoteOf,
  requestJson,
} from "./helpers.js";

describe("x402 spend then earn", () => {
  it("returns 402, then 200 + receipt, and pays the treasury 90%", async () => {
    const { app, deps } = await bootMarket();
    const { treasury, agent } = await createSellerAndAgent(app, {
      spendCap: "5000000",
      fund: "2000000",
    });

    const listed = await requestJson(app, "POST", "/listings", httpListing(treasury.address));
    expect(listed.status).toBe(201);
    const listing = listed.json.listing as { id: string; price: { amount: string } };

    const unpaid = await requestJson(app, "GET", `/listings/${listing.id}/invoke`);
    expect(unpaid.status).toBe(402);
    expect(unpaid.headers.get("payment-required") ?? unpaid.headers.get("PAYMENT-REQUIRED")).toBeTruthy();
    const quote = unpaid.json.quote as { x402Version: number; accepts: { amount: string; network: string }[] };
    expect(quote.x402Version).toBe(2);
    expect(quote.accepts[0]?.amount).toBe("100000");
    expect(quote.accepts[0]?.network).toBe("eip155:8453");

    const required = await quoteOf(app, listing.id);
    const paid = await requestJson(
      app,
      "GET",
      `/listings/${listing.id}/invoke`,
      undefined,
      payHeaders(required, agent.id, agent.address),
    );
    expect(paid.status).toBe(200);
    expect(paid.headers.get(PAYMENT_RESPONSE_HEADER.toLowerCase()) ?? paid.headers.get(PAYMENT_RESPONSE_HEADER)).toBeTruthy();

    const receipt = paid.json.receipt as {
      amountAtomic: string;
      sellerAtomic: string;
      protocolAtomic: string;
      sellerAddress: string;
    };
    expect(receipt.amountAtomic).toBe("100000");
    expect(receipt.sellerAtomic).toBe("90000");
    expect(receipt.protocolAtomic).toBe("10000");
    expect(receipt.sellerAddress).toBe(treasury.address);

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

  it("rejects a replayed nonce on the paid retry path", async () => {
    const { app } = await bootMarket();
    const { treasury, agent } = await createSellerAndAgent(app, { fund: "2000000" });
    const listed = await requestJson(app, "POST", "/listings", httpListing(treasury.address));
    const listing = listed.json.listing as { id: string };
    const quote = await quoteOf(app, listing.id);
    const headers = payHeaders(quote, agent.id, agent.address);

    const first = await requestJson(app, "GET", `/listings/${listing.id}/invoke`, undefined, headers);
    expect(first.status).toBe(200);

    const replay = await requestJson(app, "GET", `/listings/${listing.id}/invoke`, undefined, headers);
    expect(replay.status).toBe(402);
  });
});
