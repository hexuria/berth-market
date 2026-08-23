import { describe, expect, it } from "vitest";
import { bootMarket, desktopListing, httpListing, requestJson } from "./helpers.js";

const PAY_TO = "0x1111111111111111111111111111111111111111";

describe("listings", () => {
  it("creates and lists http and mcp SKUs", async () => {
    const { app } = await bootMarket();

    const http = await requestJson(app, "POST", "/listings", httpListing(PAY_TO));
    expect(http.status).toBe(201);
    const created = http.json.listing as { id: string; kind: string; payTo: string };
    expect(created.kind).toBe("http");
    expect(created.payTo).toBe(PAY_TO);

    const mcp = await requestJson(app, "POST", "/listings", {
      kind: "mcp",
      title: "search.web",
      price: { amount: "250000", asset: "USDC", network: "eip155:8453" },
      payTo: PAY_TO,
      endpoint: { url: "https://mcp.example.com/sse", method: "POST", tool: "search" },
    });
    expect(mcp.status).toBe(201);

    const catalog = await requestJson(app, "GET", "/listings");
    expect(catalog.status).toBe(200);
    const listings = catalog.json.listings as { kind: string }[];
    expect(listings.map((l) => l.kind).sort()).toEqual(["http", "mcp"]);
  });

  it("rejects laptop listings", async () => {
    const { app } = await bootMarket();
    const res = await requestJson(app, "POST", "/listings", {
      ...httpListing(PAY_TO),
      kind: "laptop",
    });
    expect(res.status).toBe(400);
    expect((res.json.error as { code: string }).code).toBe("forbidden_class");
  });

  it("rejects host-desktop class on an otherwise valid listing", async () => {
    const { app } = await bootMarket();
    const res = await requestJson(app, "POST", "/listings", {
      ...httpListing(PAY_TO),
      class: "host-desktop",
    });
    expect(res.status).toBe(400);
    expect((res.json.error as { code: string }).code).toBe("forbidden_class");
  });

  it("rejects desktop.linux without a doctor attestation (fail-closed)", async () => {
    const { app } = await bootMarket();
    const { eligibility: _omit, ...bare } = desktopListing(PAY_TO);
    const res = await requestJson(app, "POST", "/listings", bare);
    expect(res.status).toBe(400);
    expect((res.json.error as { code: string }).code).toBe("eligibility_required");
  });

  it("accepts desktop.linux when Berthos doctor attestation is stored and eligible", async () => {
    const { app } = await bootMarket();
    const res = await requestJson(app, "POST", "/listings", desktopListing(PAY_TO));
    expect(res.status).toBe(201);
    const listing = res.json.listing as { eligibility?: { ok: boolean; class: string } };
    expect(listing.eligibility?.ok).toBe(true);
    expect(listing.eligibility?.class).toBe("vm");
  });

  it("rejects desktop listing whose attestation claims class=laptop", async () => {
    const { app } = await bootMarket();
    const res = await requestJson(
      app,
      "POST",
      "/listings",
      desktopListing(PAY_TO, {
        eligibility: {
          source: "berthos.doctor",
          ok: true,
          class: "laptop",
          attestedAt: "2026-08-23T07:00:00.000Z",
        },
      }),
    );
    expect(res.status).toBe(400);
    expect((res.json.error as { code: string }).code).toBe("forbidden_class");
  });
});
