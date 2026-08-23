import { describe, expect, it } from "vitest";
import {
  BASE_CAIP2,
  BASE_SEPOLIA_CAIP2,
  USDC_BASE_ADDRESS,
  USDC_BASE_SEPOLIA_ADDRESS,
} from "../src/domain/money.js";
import { bootMarket, desktopListing, httpListing, requestJson } from "./helpers.js";

const PAY_TO = "0x1111111111111111111111111111111111111111";

describe("listings", () => {
  it("lands a listing with no network field on eip155:84532 and Sepolia USDC", async () => {
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
    expect(created.price.network).toBe(BASE_SEPOLIA_CAIP2);

    const quote = await requestJson(app, "GET", `/listings/${created.id}/invoke`);
    expect(quote.status).toBe(402);
    const accepted = (quote.json.quote as { accepts: { network: string; asset: string }[] }).accepts[0];
    expect(accepted?.network).toBe(BASE_SEPOLIA_CAIP2);
    expect(accepted?.asset).toBe(USDC_BASE_SEPOLIA_ADDRESS);
    expect(accepted?.asset).not.toBe(USDC_BASE_ADDRESS);
    expect(JSON.stringify(quote.json)).not.toContain(`"${BASE_CAIP2}"`);
    expect(JSON.stringify(quote.json)).not.toContain(USDC_BASE_ADDRESS);
  });

  it("keeps an explicit eip155:8453 listing and quote on mainnet USDC", async () => {
    const { app } = await bootMarket();
    const mainnet = await requestJson(app, "POST", "/listings", httpListing(PAY_TO));
    expect(mainnet.status).toBe(201);
    const stored = mainnet.json.listing as { id: string; price: { network: string } };
    expect(stored.price.network).toBe(BASE_CAIP2);
    const mainnetQuote = await requestJson(app, "GET", `/listings/${stored.id}/invoke`);
    expect(mainnetQuote.status).toBe(402);
    const mainnetAccepted = (mainnetQuote.json.quote as { accepts: { network: string; asset: string }[] })
      .accepts[0];
    expect(mainnetAccepted?.network).toBe(BASE_CAIP2);
    expect(mainnetAccepted?.asset).toBe(USDC_BASE_ADDRESS);
    expect(JSON.stringify(mainnetQuote.json)).not.toContain(BASE_SEPOLIA_CAIP2);
  });

  it("uses NETWORK=eip155:8453 as the catalog default only when the operator sets it", async () => {
    const { app } = await bootMarket({ env: { NETWORK: BASE_CAIP2 } });
    const created = await requestJson(app, "POST", "/listings", {
      kind: "http",
      title: "weather.mainnet",
      price: { amount: "1000", asset: "USDC" },
      payTo: PAY_TO,
      endpoint: { url: "https://api.example.com/weather", method: "GET" },
    });
    expect(created.status).toBe(201);
    const listing = created.json.listing as { id: string; price: { network: string } };
    expect(listing.price.network).toBe(BASE_CAIP2);

    const quote = await requestJson(app, "GET", `/listings/${listing.id}/invoke`);
    expect(quote.status).toBe(402);
    const accepted = (quote.json.quote as { accepts: { network: string; asset: string }[] }).accepts[0];
    expect(accepted?.network).toBe(BASE_CAIP2);
    expect(accepted?.asset).toBe(USDC_BASE_ADDRESS);
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
