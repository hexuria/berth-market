import { describe, expect, it } from "vitest";
import { MemoryEligibilityClient } from "../src/adapters/memory-eligibility.js";
import { MemoryLeaseClient } from "../src/adapters/memory-lease.js";
import { createApp } from "../src/app.js";
import { BASE_SEPOLIA_CAIP2 } from "../src/domain/money.js";
import {
  createSellerAndAgent,
  desktopListing,
  mockCdpClient,
  payHeaders,
  quoteOf,
  requestJson,
  TEST_CDP_ENV,
} from "./helpers.js";

function settleOps(calls: { op: string }[]) {
  return calls.filter((row) => row.op === "useSpendPermission" || row.op === "transfer");
}

function sepoliaDesktop(payTo: string, extra: Record<string, unknown> = {}) {
  return desktopListing(payTo, {
    price: { amount: "1000000", asset: "USDC", network: BASE_SEPOLIA_CAIP2 },
    ...extra,
  });
}

describe("CDP desktop.linux invoke (mocked SDK, no live Coinbase)", () => {
  it("pays on Sepolia, leases, then ends occupancy without a second CDP charge", async () => {
    const { client, calls } = mockCdpClient();
    const leases = new MemoryLeaseClient({ occupancySecondsOnEnd: 12 });
    const { app, deps } = await createApp({
      env: { ...TEST_CDP_ENV },
      cdp: client,
      leases,
    });
    expect(deps.eligibility).toBeInstanceOf(MemoryEligibilityClient);
    expect(deps.leases).toBeInstanceOf(MemoryLeaseClient);

    const { treasury, agent } = await createSellerAndAgent(app, {
      spendCap: "5000000",
      fund: "2000000",
    });

    const listed = await requestJson(app, "POST", "/listings", sepoliaDesktop(treasury.address));
    expect(listed.status).toBe(201);
    const listing = listed.json.listing as { id: string; kind: string; price: { network: string } };
    expect(listing.kind).toBe("desktop.linux");
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
      leaseId: string;
      berthosUrl: string;
      state: string;
    };
    expect(fulfillment.status).toBe("leased");
    expect(fulfillment.state).toBe("live");
    expect(fulfillment.leaseId).toMatch(/^l_/);
    expect(fulfillment.berthosUrl).toBe("https://berthos.example");
    expect(leases.live?.id).toBe(fulfillment.leaseId);
    expect(leases.created).toHaveLength(1);

    const receipt = paid.json.receipt as {
      id: string;
      amountAtomic: string;
      sellerAtomic: string;
      protocolAtomic: string;
      sellerAddress: string;
      protocolAddress: string;
      network: string;
      onChainSettlement?: string;
      leaseId: string;
      leaseState: string;
    };
    expect(receipt.amountAtomic).toBe("1000000");
    expect(receipt.sellerAtomic).toBe("900000");
    expect(receipt.protocolAtomic).toBe("100000");
    expect(receipt.sellerAddress).toBe(treasury.address);
    expect(receipt.protocolAddress).toBe(deps.protocolTreasury.address);
    expect(receipt.network).toBe(BASE_SEPOLIA_CAIP2);
    expect(receipt.onChainSettlement).toBe("cdp_split_90_10");
    expect(receipt.leaseId).toBe(fulfillment.leaseId);
    expect(receipt.leaseState).toBe("live");

    const spend = calls.find((row) => row.op === "useSpendPermission");
    expect(spend?.value).toBe("1000000");
    expect(spend?.network).toBe("base-sepolia");

    const transfers = calls.filter((row) => row.op === "transfer");
    expect(transfers).toHaveLength(2);
    expect(transfers[0]).toMatchObject({
      to: treasury.address,
      amount: "900000",
      token: "usdc",
      network: "base-sepolia",
    });
    expect(transfers[1]).toMatchObject({
      to: deps.protocolTreasury.address,
      amount: "100000",
      token: "usdc",
      network: "base-sepolia",
    });
    expect(calls.every((row) => row.network !== "base")).toBe(true);
    expect(JSON.stringify(calls)).not.toContain('"base"');

    const ended = await requestJson(app, "POST", `/receipts/${receipt.id}/end`);
    expect(ended.status).toBe(200);
    const stored = ended.json.receipt as {
      leaseState: string;
      occupancySeconds: number;
      billedSeconds: number;
      occupancyUnit: string;
    };
    const occupancy = ended.json.occupancy as {
      seconds: number;
      billedSeconds: number;
      unit: string;
      chargedHere: boolean;
    };
    expect(stored.leaseState).toBe("ended");
    expect(stored.occupancySeconds).toBe(12);
    expect(stored.billedSeconds).toBe(60);
    expect(stored.occupancyUnit).toBe("seconds");
    expect(occupancy.seconds).toBe(12);
    expect(occupancy.billedSeconds).toBe(60);
    expect(occupancy.unit).toBe("seconds");
    expect(occupancy.chargedHere).toBe(false);
    expect(leases.live).toBeUndefined();
    expect(leases.ended).toHaveLength(1);

    expect(calls.filter((row) => row.op === "useSpendPermission")).toHaveLength(1);
    expect(calls.filter((row) => row.op === "transfer")).toHaveLength(2);

    const agentAfter = await requestJson(app, "GET", `/wallets/${agent.id}`);
    expect((agentAfter.json.wallet as { spentAtomic: string }).spentAtomic).toBe("1000000");

    const again = await requestJson(app, "POST", `/receipts/${receipt.id}/end`);
    expect(again.status).toBe(200);
    expect((again.json.receipt as { occupancySeconds: number }).occupancySeconds).toBe(12);
    expect(leases.ended).toHaveLength(1);
    expect(calls.filter((row) => row.op === "transfer")).toHaveLength(2);
  });

  it("still rejects a desktop listing that claims class=laptop with no CDP settle", async () => {
    const { client, calls } = mockCdpClient();
    const leases = new MemoryLeaseClient();
    const { app } = await createApp({
      env: { ...TEST_CDP_ENV },
      cdp: client,
      leases,
    });
    const { treasury, agent } = await createSellerAndAgent(app, { fund: "2000000" });

    const res = await requestJson(
      app,
      "POST",
      "/listings",
      sepoliaDesktop(treasury.address, { class: "laptop" }),
    );
    expect(res.status).toBe(400);
    expect((res.json.error as { code: string }).code).toBe("forbidden_class");
    expect(leases.created).toHaveLength(0);
    expect(settleOps(calls)).toHaveLength(0);

    const agentAfter = await requestJson(app, "GET", `/wallets/${agent.id}`);
    expect((agentAfter.json.wallet as { spentAtomic: string }).spentAtomic).toBe("0");
  });

  it("still rejects a desktop listing whose attestation claims class=laptop", async () => {
    const { client, calls } = mockCdpClient();
    const leases = new MemoryLeaseClient();
    const { app } = await createApp({
      env: { ...TEST_CDP_ENV },
      cdp: client,
      leases,
    });
    const { treasury, agent } = await createSellerAndAgent(app, { fund: "2000000" });

    const res = await requestJson(
      app,
      "POST",
      "/listings",
      sepoliaDesktop(treasury.address, {
        eligibility: {
          source: "berthos.doctor",
          ok: true,
          class: "laptop",
          attestedAt: new Date().toISOString(),
        },
      }),
    );
    expect(res.status).toBe(400);
    expect((res.json.error as { code: string }).code).toBe("forbidden_class");
    expect(leases.created).toHaveLength(0);
    expect(settleOps(calls)).toHaveLength(0);

    const agentAfter = await requestJson(app, "GET", `/wallets/${agent.id}`);
    expect((agentAfter.json.wallet as { spentAtomic: string }).spentAtomic).toBe("0");
  });

  it("fails closed on laptop at invoke and does not call CDP settle", async () => {
    const { client, calls } = mockCdpClient();
    const leases = new MemoryLeaseClient();
    const { app, deps } = await createApp({
      env: { ...TEST_CDP_ENV },
      cdp: client,
      leases,
    });
    const { treasury, agent } = await createSellerAndAgent(app, {
      spendCap: "5000000",
      fund: "2000000",
    });
    const listed = await requestJson(app, "POST", "/listings", sepoliaDesktop(treasury.address));
    expect(listed.status).toBe(201);
    const listing = listed.json.listing as { id: string };

    deps.eligibility.verify = async () => ({ ok: false, reason: "forbidden_class:laptop" });

    const quote = await quoteOf(app, listing.id);
    const paid = await requestJson(
      app,
      "GET",
      `/listings/${listing.id}/invoke`,
      undefined,
      payHeaders(quote, agent.id, agent.address),
    );
    expect(paid.status).toBe(400);
    expect((paid.json.error as { code: string }).code).toBe("forbidden_class");
    expect(leases.created).toHaveLength(0);
    expect(settleOps(calls)).toHaveLength(0);

    const agentAfter = await requestJson(app, "GET", `/wallets/${agent.id}`);
    expect((agentAfter.json.wallet as { spentAtomic: string }).spentAtomic).toBe("0");
  });

  it("still rejects host-desktop class under the CDP app path", async () => {
    const { client, calls } = mockCdpClient();
    const leases = new MemoryLeaseClient();
    const { app } = await createApp({
      env: { ...TEST_CDP_ENV },
      cdp: client,
      leases,
    });
    const { treasury, agent } = await createSellerAndAgent(app, { fund: "2000000" });

    const res = await requestJson(
      app,
      "POST",
      "/listings",
      sepoliaDesktop(treasury.address, { class: "host-desktop" }),
    );
    expect(res.status).toBe(400);
    expect((res.json.error as { code: string }).code).toBe("forbidden_class");
    expect(leases.created).toHaveLength(0);
    expect(settleOps(calls)).toHaveLength(0);

    const agentAfter = await requestJson(app, "GET", `/wallets/${agent.id}`);
    expect((agentAfter.json.wallet as { spentAtomic: string }).spentAtomic).toBe("0");
  });
});
