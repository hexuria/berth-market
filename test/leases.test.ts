import { describe, expect, it } from "vitest";
import {
  BERTHOS_LEASES_PATH,
  BERTHOS_PAIR_PATH,
  HttpBerthosLeaseClient,
  createLeaseClient,
} from "../src/adapters/http-lease.js";
import { MemoryLeaseClient } from "../src/adapters/memory-lease.js";
import { createApp } from "../src/app.js";
import type { FacilitatorPort } from "../src/ports/facilitator.js";
import { bootMarket, createSellerAndAgent, desktopListing, payHeaders, quoteOf, requestJson } from "./helpers.js";

const PAY_TO = "0x3333333333333333333333333333333333333333";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function berthosLeaseBody(id = "l_testlease01") {
  return {
    id,
    state: "live",
    quote: {
      vcpu: 2,
      mem_gib: 4,
      disk_gib: 40,
      os: "linux",
      density: "isolated",
      min_seconds: 60,
      occupancy_unit: "seconds",
      notional_usd_per_hour: "0.048",
      settlement: { charged_here: false, note: "quoted, not charged" },
    },
    started_at: new Date().toISOString(),
    ended_at: null,
  };
}

function berthosOccupancyBody(leaseId = "l_testlease01") {
  return {
    lease_id: leaseId,
    occupancy_seconds: 12,
    min_seconds: 60,
    billed_seconds: 60,
    occupancy_unit: "seconds",
    notional_usd: "0.000160",
    reason: "graceful",
    settlement: { charged_here: false, note: "quoted, not charged" },
  };
}

async function listAndPayDesktop(
  app: Awaited<ReturnType<typeof bootMarket>>["app"],
  extra: Record<string, unknown> = {},
) {
  const { treasury, agent } = await createSellerAndAgent(app, {
    spendCap: "5000000",
    fund: "2000000",
  });
  const listed = await requestJson(app, "POST", "/listings", desktopListing(treasury.address, extra));
  expect(listed.status).toBe(201);
  const listing = listed.json.listing as { id: string };
  const quote = await quoteOf(app, listing.id);
  const paid = await requestJson(
    app,
    "GET",
    `/listings/${listing.id}/invoke`,
    undefined,
    payHeaders(quote, agent.id, agent.address),
  );
  return { treasury, agent, listing, paid };
}

describe("desktop.linux lease fulfillment", () => {
  it("pays desktop.linux, creates a lease, ends it, and stores occupancy seconds", async () => {
    const leases = new MemoryLeaseClient({ occupancySecondsOnEnd: 12 });
    const { app } = await bootMarket({ leases });
    const { agent, paid } = await listAndPayDesktop(app);

    expect(paid.status).toBe(200);
    const fulfillment = paid.json.fulfillment as {
      status: string;
      leaseId: string;
      berthosUrl: string;
      state: string;
    };
    const receipt = paid.json.receipt as {
      id: string;
      leaseId: string;
      leaseState: string;
      amountAtomic: string;
    };
    expect(fulfillment.status).toBe("leased");
    expect(fulfillment.state).toBe("live");
    expect(fulfillment.leaseId).toMatch(/^l_/);
    expect(fulfillment.berthosUrl).toBe("https://berthos.example");
    expect(receipt.leaseId).toBe(fulfillment.leaseId);
    expect(receipt.leaseState).toBe("live");
    expect(leases.live?.id).toBe(fulfillment.leaseId);
    expect(leases.created).toHaveLength(1);

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

    const agentAfter = await requestJson(app, "GET", `/wallets/${agent.id}`);
    expect((agentAfter.json.wallet as { spentAtomic: string }).spentAtomic).toBe("1000000");

    const again = await requestJson(app, "POST", `/receipts/${receipt.id}/end`);
    expect(again.status).toBe(200);
    expect((again.json.receipt as { occupancySeconds: number }).occupancySeconds).toBe(12);
    expect(leases.ended).toHaveLength(1);
  });

  it("fails closed and does not charge when the node is unreachable", async () => {
    const leases = new MemoryLeaseClient({ mode: "unreachable" });
    const { app } = await bootMarket({ leases });
    const { agent, paid } = await listAndPayDesktop(app);
    expect(paid.status).toBe(400);
    expect((paid.json.error as { code: string }).code).toBe("node_unreachable");
    expect(leases.created).toHaveLength(0);

    const agentAfter = await requestJson(app, "GET", `/wallets/${agent.id}`);
    expect((agentAfter.json.wallet as { spentAtomic: string; balanceAtomic: string }).spentAtomic).toBe(
      "0",
    );
    expect((agentAfter.json.wallet as { balanceAtomic: string }).balanceAtomic).toBe("2000000");

    const receipts = await requestJson(app, "GET", "/receipts");
    expect((receipts.json.receipts as unknown[]).length).toBe(0);
  });

  it("fails closed and does not charge when live class is laptop", async () => {
    const leases = new MemoryLeaseClient();
    const { app, deps } = await bootMarket({ leases });
    const { treasury, agent } = await createSellerAndAgent(app, { fund: "2000000" });
    const listed = await requestJson(app, "POST", "/listings", desktopListing(treasury.address));
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

    const agentAfter = await requestJson(app, "GET", `/wallets/${agent.id}`);
    expect((agentAfter.json.wallet as { spentAtomic: string }).spentAtomic).toBe("0");
  });

  it("fails closed when the lease client itself rejects class=laptop", async () => {
    const leases = new MemoryLeaseClient({ mode: "laptop" });
    const { app } = await bootMarket({ leases });
    const { agent, paid } = await listAndPayDesktop(app);
    expect(paid.status).toBe(400);
    expect((paid.json.error as { code: string }).code).toBe("forbidden_class");
    expect(leases.created).toHaveLength(0);
    const agentAfter = await requestJson(app, "GET", `/wallets/${agent.id}`);
    expect((agentAfter.json.wallet as { spentAtomic: string }).spentAtomic).toBe("0");
  });

  it("returns 409 already_leased and does not charge a second payer", async () => {
    const leases = new MemoryLeaseClient();
    const { app } = await bootMarket({ leases });
    const first = await listAndPayDesktop(app);
    expect(first.paid.status).toBe(200);
    expect(leases.live).toBeTruthy();

    const second = await listAndPayDesktop(app, {
      title: "gpu-box.session-2",
    });
    expect(second.paid.status).toBe(409);
    expect((second.paid.json.error as { code: string }).code).toBe("already_leased");
    expect(leases.created).toHaveLength(1);

    const secondAfter = await requestJson(app, "GET", `/wallets/${second.agent.id}`);
    expect((secondAfter.json.wallet as { spentAtomic: string }).spentAtomic).toBe("0");
  });

  it("does not settle a replayed nonce and does not create a second lease", async () => {
    const leases = new MemoryLeaseClient();
    const { app } = await bootMarket({ leases });
    const { treasury, agent } = await createSellerAndAgent(app, { fund: "2000000" });
    const listed = await requestJson(app, "POST", "/listings", desktopListing(treasury.address));
    const listing = listed.json.listing as { id: string };
    const quote = await quoteOf(app, listing.id);
    const headers = payHeaders(quote, agent.id, agent.address);

    const first = await requestJson(app, "GET", `/listings/${listing.id}/invoke`, undefined, headers);
    expect(first.status).toBe(200);
    const leaseId = (first.json.fulfillment as { leaseId: string }).leaseId;
    await requestJson(app, "POST", `/receipts/${(first.json.receipt as { id: string }).id}/end`);
    expect(leases.live).toBeUndefined();

    const replay = await requestJson(app, "GET", `/listings/${listing.id}/invoke`, undefined, headers);
    expect(replay.status).toBe(402);
    expect((replay.json.error as { message: string }).message).toMatch(/already settled|replayed/);
    expect(leases.created).toHaveLength(1);
    expect(leases.live).toBeUndefined();
    expect(leases.created[0]?.id).toBe(leaseId);

    const agentAfter = await requestJson(app, "GET", `/wallets/${agent.id}`);
    expect((agentAfter.json.wallet as { spentAtomic: string }).spentAtomic).toBe("1000000");
  });

  it("aborts the guest when facilitator settle fails after create (no silent charge)", async () => {
    const leases = new MemoryLeaseClient();
    const facilitator: FacilitatorPort = {
      verify: async () => ({ isValid: true, payer: PAY_TO }),
      settle: async (request) => ({
        success: false,
        errorReason: "settlement_rejected",
        transaction: "",
        network: request.paymentRequirements.network,
      }),
    };
    const { app } = await createApp({ leases, facilitator });
    const { agent, paid } = await listAndPayDesktop(app);
    expect(paid.status).toBe(402);
    expect((paid.json.error as { message: string }).message).toMatch(/settlement_rejected/);
    expect(leases.created).toHaveLength(1);
    expect(leases.ended).toHaveLength(1);
    expect(leases.live).toBeUndefined();

    const agentAfter = await requestJson(app, "GET", `/wallets/${agent.id}`);
    expect((agentAfter.json.wallet as { spentAtomic: string }).spentAtomic).toBe("0");
  });

  it("redacts listing.fulfillment.leaseToken", async () => {
    const { app } = await bootMarket();
    const listed = await requestJson(
      app,
      "POST",
      "/listings",
      desktopListing(PAY_TO, {
        fulfillment: {
          berthosUrl: "https://berthos.example",
          sku: "linux-gpu-1",
          nodeId: "node_01",
          leaseToken: "secret-lease-token",
        },
      }),
    );
    expect(listed.status).toBe(201);
    const listing = listed.json.listing as { fulfillment?: { leaseToken?: string; sku?: string } };
    expect(listing.fulfillment?.leaseToken).toBeUndefined();
    expect(listing.fulfillment?.sku).toBe("linux-gpu-1");
  });

  it("defaults to MemoryLeaseClient and uses HttpBerthosLeaseClient only when BERTHOS_URL is set", async () => {
    const memory = await createApp({ env: {} });
    expect(memory.deps.leases).toBeInstanceOf(MemoryLeaseClient);
    expect(createLeaseClient({})).toBeInstanceOf(MemoryLeaseClient);

    const http = await createApp({
      env: { BERTHOS_URL: "http://127.0.0.1:7432", BERTHOS_LEASE_TOKEN: "tok" },
      fetchImpl: async () => {
        throw new Error("must not fetch during boot");
      },
    });
    expect(http.deps.leases).toBeInstanceOf(HttpBerthosLeaseClient);
  });
});

describe("HttpBerthosLeaseClient", () => {
  it("POSTs /v1/leases and DELETEs /v1/leases/{id} with the bearer token", async () => {
    const seen: { url: string; method: string; auth?: string; body?: unknown }[] = [];
    const client = new HttpBerthosLeaseClient({
      berthosUrl: "http://127.0.0.1:7432",
      leaseToken: "lease-token",
      fetchImpl: async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        seen.push({
          url,
          method: init?.method ?? "GET",
          auth: (init?.headers as Record<string, string> | undefined)?.authorization,
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        if (init?.method === "POST") return jsonResponse(berthosLeaseBody(), 201);
        return jsonResponse(berthosOccupancyBody());
      },
    });

    const created = await client.create({ os: "linux" });
    expect(created.id).toBe("l_testlease01");
    expect(created.state).toBe("live");
    expect(created.quote.occupancyUnit).toBe("seconds");
    expect(created.quote.settlement.chargedHere).toBe(false);

    const ended = await client.end({ leaseId: created.id });
    expect(ended.occupancySeconds).toBe(12);
    expect(ended.billedSeconds).toBe(60);
    expect(ended.occupancyUnit).toBe("seconds");
    expect(ended.settlement.chargedHere).toBe(false);

    expect(seen).toEqual([
      {
        url: `http://127.0.0.1:7432${BERTHOS_LEASES_PATH}`,
        method: "POST",
        auth: "Bearer lease-token",
        body: { os: "linux" },
      },
      {
        url: `http://127.0.0.1:7432${BERTHOS_LEASES_PATH}/l_testlease01`,
        method: "DELETE",
        auth: "Bearer lease-token",
        body: undefined,
      },
    ]);
  });

  it("pairs when only a pairing code is configured", async () => {
    const seen: string[] = [];
    const client = new HttpBerthosLeaseClient({
      berthosUrl: "http://127.0.0.1:7432",
      pairCode: "ABCD-EFGH",
      fetchImpl: async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        seen.push(`${init?.method ?? "GET"} ${url}`);
        if (url.endsWith(BERTHOS_PAIR_PATH)) {
          return jsonResponse({ token: "paired-token", capabilities: ["operator", "lease"] });
        }
        return jsonResponse(berthosLeaseBody(), 201);
      },
    });
    await client.create({ os: "linux" });
    expect(seen).toEqual([
      `POST http://127.0.0.1:7432${BERTHOS_PAIR_PATH}`,
      `POST http://127.0.0.1:7432${BERTHOS_LEASES_PATH}`,
    ]);
  });

  it("fails closed on 409 already-leased", async () => {
    const client = new HttpBerthosLeaseClient({
      berthosUrl: "http://127.0.0.1:7432",
      leaseToken: "tok",
      fetchImpl: async () => jsonResponse({ error: "a lease is already live" }, 409),
    });
    await expect(client.create({ os: "linux" })).rejects.toMatchObject({
      code: "already_leased",
      status: 409,
    });
  });

  it("fails closed when the node is unreachable", async () => {
    const client = new HttpBerthosLeaseClient({
      berthosUrl: "http://127.0.0.1:7432",
      leaseToken: "tok",
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    await expect(client.create({ os: "linux" })).rejects.toMatchObject({
      code: "node_unreachable",
      status: 400,
    });
  });
});
