import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { DEFAULT_CORS_ORIGINS, parseCorsOrigins } from "../src/http/cors.js";
import { PAYMENT_REQUIRED_HEADER, PAYMENT_SIGNATURE_HEADER } from "../src/domain/x402.js";
import { bootMarket, requestJson } from "./helpers.js";

const VITE_5174 = "http://127.0.0.1:5174";
const VITE_5173 = "http://127.0.0.1:5173";

describe("parseCorsOrigins", () => {
  it("defaults to Vite loopback :5173 and :5174, not *", () => {
    expect(parseCorsOrigins(undefined)).toEqual([...DEFAULT_CORS_ORIGINS]);
    expect(parseCorsOrigins("")).toEqual([...DEFAULT_CORS_ORIGINS]);
    expect(parseCorsOrigins("  ")).toEqual([...DEFAULT_CORS_ORIGINS]);
    expect(parseCorsOrigins(undefined)).not.toContain("*");
  });

  it("accepts a comma list and does not keep the defaults when set", () => {
    expect(parseCorsOrigins("https://app.example, http://127.0.0.1:4173")).toEqual([
      "https://app.example",
      "http://127.0.0.1:4173",
    ]);
  });
});

describe("loadConfig defaults", () => {
  it("defaults catalog NETWORK to eip155:84532 and keeps explicit mainnet", () => {
    const def = loadConfig({});
    expect(def.network).toBe("eip155:84532");
    expect(def.corsOrigins).toEqual([...DEFAULT_CORS_ORIGINS]);
    expect(loadConfig({ NETWORK: "eip155:8453" }).network).toBe("eip155:8453");
  });
});

describe("browser CORS", () => {
  it("answers OPTIONS /listings for the Vite origin instead of 404", async () => {
    const { app } = await bootMarket();
    const response = await app.request("/listings", {
      method: "OPTIONS",
      headers: {
        Origin: VITE_5174,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": `content-type,${PAYMENT_SIGNATURE_HEADER}`,
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(VITE_5174);
    const methods = (response.headers.get("Access-Control-Allow-Methods") ?? "").toUpperCase();
    expect(methods).toContain("POST");
    expect(methods).toContain("GET");
    expect(methods).toContain("OPTIONS");
    const allowHeaders = (response.headers.get("Access-Control-Allow-Headers") ?? "").toLowerCase();
    expect(allowHeaders).toContain("content-type");
    expect(allowHeaders).toContain(PAYMENT_SIGNATURE_HEADER.toLowerCase());
  });

  it("echoes the Vite origin on GET /listings and never *", async () => {
    const { app } = await bootMarket();
    const res = await requestJson(app, "GET", "/listings", undefined, { Origin: VITE_5173 });
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(VITE_5173);
    expect(res.headers.get("Access-Control-Allow-Origin")).not.toBe("*");
  });

  it("exposes x402 headers on a 402 quote so the browser can read them", async () => {
    const { app } = await bootMarket();
    const listed = await requestJson(app, "POST", "/listings", {
      kind: "http",
      title: "cors.quote",
      price: { amount: "1000", asset: "USDC" },
      payTo: "0x1111111111111111111111111111111111111111",
      endpoint: { url: "https://example.com/weather", method: "GET" },
    });
    expect(listed.status).toBe(201);
    const listing = listed.json.listing as { id: string };
    const unpaid = await requestJson(app, "GET", `/listings/${listing.id}/invoke`, undefined, {
      Origin: VITE_5174,
    });
    expect(unpaid.status).toBe(402);
    expect(unpaid.headers.get("Access-Control-Allow-Origin")).toBe(VITE_5174);
    const exposed = (unpaid.headers.get("Access-Control-Expose-Headers") ?? "").toLowerCase();
    expect(exposed).toContain(PAYMENT_REQUIRED_HEADER.toLowerCase());
    expect(unpaid.headers.get("payment-required") ?? unpaid.headers.get(PAYMENT_REQUIRED_HEADER)).toBeTruthy();
  });

  it("does not reflect an unknown origin and does not fall back to *", async () => {
    const { app } = await bootMarket();
    const res = await requestJson(app, "GET", "/listings", undefined, {
      Origin: "https://evil.example",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("honors CORS_ORIGIN and does not keep the Vite defaults when overridden", async () => {
    const { app } = await bootMarket({
      env: { CORS_ORIGIN: "https://app.example" },
    });
    const allowed = await requestJson(app, "GET", "/health", undefined, {
      Origin: "https://app.example",
    });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe("https://app.example");

    const blocked = await requestJson(app, "GET", "/health", undefined, { Origin: VITE_5173 });
    expect(blocked.status).toBe(200);
    expect(blocked.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});
