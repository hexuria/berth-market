import { describe, expect, it } from "vitest";
import { bootMarket, desktopListing, httpListing, requestJson } from "./helpers.js";

const PAY_TO = "0x1111111111111111111111111111111111111111";

describe("listings", () => {
  it("defaults omitted price.network to eip155:84532 and keeps explicit mainnet", async () => {
    const { app } = await bootMarket();

    const omitted = await requestJson(app, "POST", "/listings", {
      kind: "http",
      title: "weather.now",
      price: { amount: "1000", asset: "USDC" },
      payTo: PAY_TO,
      endpoint: { url: "https://api.example.com/weather", method: "GET" },
    });
    expect(omitted.status).toBe(201);
    const created = omitted.json.listing as { id: string; price: { network: string } };
    expect(created.price.network).toBe("eip155:84532");

    const quote = await requestJson(app, "GET", `/listings/${created.id}/invoke`);
    expect(quote.status).toBe(402);
    const accepted = (quote.json.quote as { accepts: { network: string }[] }).accepts[0];
    expect(accepted?.network).toBe("eip155:84532");

    const mainnet = await requestJson(app, "POST", "/listings", httpListing(PAY_TO));
    expect(mainnet.status).toBe(201);
    const stored = mainnet.json.listing as { id: string; price: { network: string } };
    expect(stored.price.network).toBe("eip155:8453");
    const mainnetQuote = await requestJson(app, "GET", `/listings/${stored.id}/invoke`);
    expect(mainnetQuote.status).toBe(402);
    const mainnetAccepted = (mainnetQuote.json.quote as { accepts: { network: string }[] }).accepts[0];
    expect(mainnetAccepted?.network).toBe("eip155:8453");
    expect(JSON.stringify(mainnetQuote.json)).not.toContain("eip155:84532");
  });

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

  it("rejects host-desktop listings", async () => {
    const { app } = await bootMarket();
    const res = await requestJson(app, "POST", "/listings", {
      ...httpListing(PAY_TO),
      kind: "host-desktop",
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
          attestedAt: new Date().toISOString(),
        },
      }),
    );
    expect(res.status).toBe(400);
    expect((res.json.error as { code: string }).code).toBe("forbidden_class");
  });
});
