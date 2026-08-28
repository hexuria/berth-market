import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { BASE_SEPOLIA_CAIP2 } from "../src/domain/money.js";
import {
  createSellerAndAgent,
  mcpListing,
  mockCdpClient,
  payHeaders,
  quoteOf,
  requestJson,
  TEST_CDP_ENV,
} from "./helpers.js";

function settleOps(calls: { op: string }[]) {
  return calls.filter((row) => row.op === "useSpendPermission" || row.op === "transfer");
}

describe("CDP MCP invoke (mocked SDK, no live Coinbase)", () => {
  it("copies cdp_split_90_10 onto the public receipt after two Sepolia transfers", async () => {
    const { client, calls } = mockCdpClient();
    const { app, deps } = await createApp({
      env: { ...TEST_CDP_ENV },
      cdp: client,
    });

    const { treasury, agent } = await createSellerAndAgent(app, {
      spendCap: "5000000",
      fund: "2000000",
    });

    const listed = await requestJson(app, "POST", "/listings", mcpListing(treasury.address));
    expect(listed.status).toBe(201);
    const listing = listed.json.listing as {
      id: string;
      kind: string;
      price: { network: string };
      endpoint?: { tool?: string };
    };
    expect(listing.kind).toBe("mcp");
    expect(listing.endpoint?.tool).toBe("search");
    expect(listing.price.network).toBe(BASE_SEPOLIA_CAIP2);

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

    const fulfillment = paid.json.fulfillment as {
      status: string;
      kind: string;
      tool: string;
      result: { ok: boolean; tool: string; proxied: boolean };
    };
    expect(fulfillment.status).toBe("accepted");
    expect(fulfillment.kind).toBe("mcp");
    expect(fulfillment.tool).toBe("search");
    expect(fulfillment.result).toEqual({ ok: true, tool: "search", proxied: false });

    const receipt = paid.json.receipt as {
      amountAtomic: string;
      sellerAtomic: string;
      protocolAtomic: string;
      sellerAddress: string;
      protocolAddress: string;
      network: string;
      onChainSettlement?: string;
    };
    expect(receipt.amountAtomic).toBe("100000");
    expect(receipt.sellerAtomic).toBe("90000");
    expect(receipt.protocolAtomic).toBe("10000");
    expect(receipt.sellerAddress).toBe(treasury.address);
    expect(receipt.protocolAddress).toBe(deps.protocolTreasury.address);
    expect(receipt.network).toBe(BASE_SEPOLIA_CAIP2);
    expect(receipt.onChainSettlement).toBe("cdp_split_90_10");

    const spend = calls.find((row) => row.op === "useSpendPermission");
    expect(spend?.value).toBe("100000");
    expect(spend?.network).toBe("base-sepolia");

    const transfers = calls.filter((row) => row.op === "transfer");
    expect(transfers).toHaveLength(2);
    expect(transfers[0]).toMatchObject({
      to: treasury.address,
      amount: "90000",
      token: "usdc",
      network: "base-sepolia",
    });
    expect(transfers[1]).toMatchObject({
      to: deps.protocolTreasury.address,
      amount: "10000",
      token: "usdc",
      network: "base-sepolia",
    });
    expect(calls.every((row) => row.network !== "base")).toBe(true);
    expect(JSON.stringify(calls)).not.toContain('"base"');
  });

  it("still rejects an mcp listing that claims class=laptop with no CDP settle", async () => {
    const { client, calls } = mockCdpClient();
    const { app } = await createApp({
      env: { ...TEST_CDP_ENV },
      cdp: client,
    });
    const { treasury, agent } = await createSellerAndAgent(app, { fund: "2000000" });

    const res = await requestJson(
      app,
      "POST",
      "/listings",
      mcpListing(treasury.address, { class: "laptop" }),
    );
    expect(res.status).toBe(400);
    expect((res.json.error as { code: string }).code).toBe("forbidden_class");
    expect(settleOps(calls)).toHaveLength(0);

    const agentAfter = await requestJson(app, "GET", `/wallets/${agent.id}`);
    expect((agentAfter.json.wallet as { spentAtomic: string }).spentAtomic).toBe("0");
  });

  it("still rejects an mcp listing that claims class=host-desktop with no CDP settle", async () => {
    const { client, calls } = mockCdpClient();
    const { app } = await createApp({
      env: { ...TEST_CDP_ENV },
      cdp: client,
    });
    const { treasury, agent } = await createSellerAndAgent(app, { fund: "2000000" });

    const res = await requestJson(
      app,
      "POST",
      "/listings",
      mcpListing(treasury.address, { class: "host-desktop" }),
    );
    expect(res.status).toBe(400);
    expect((res.json.error as { code: string }).code).toBe("forbidden_class");
    expect(settleOps(calls)).toHaveLength(0);

    const agentAfter = await requestJson(app, "GET", `/wallets/${agent.id}`);
    expect((agentAfter.json.wallet as { spentAtomic: string }).spentAtomic).toBe("0");
  });
});
