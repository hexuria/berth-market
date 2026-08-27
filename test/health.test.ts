import { describe, expect, it } from "vitest";
import { CdpWalletAdapter } from "../src/adapters/cdp-wallet.js";
import { LiveFacilitator } from "../src/adapters/live-facilitator.js";
import { MemoryStore } from "../src/adapters/memory-store.js";
import { createApp } from "../src/app.js";
import { BASE_SEPOLIA_CAIP2, USDC_BASE_SEPOLIA_ADDRESS } from "../src/domain/money.js";
import { publicHealth } from "../src/http/health.js";
import { bootMarket, mockCdpClient, requestJson, TEST_CDP_ENV } from "./helpers.js";

const LIVE_FACILITATOR_URL = "https://facilitator.example";

const SECRET_ENV = {
  ...TEST_CDP_ENV,
  CDP_API_KEY_ID: "cdp-key-id-must-never-leak",
  CDP_API_KEY_SECRET: "cdp-key-secret-must-never-leak",
  CDP_WALLET_SECRET: "cdp-wallet-secret-must-never-leak",
  BERTHOS_LEASE_TOKEN: "berthos-bearer-must-never-leak",
  STAGING_PAYER_PRIVATE_KEY: "0xprivatekeymustneverleak",
} as const;

function assertNoSecrets(body: unknown) {
  const serialized = JSON.stringify(body);
  expect(serialized).not.toContain(SECRET_ENV.CDP_API_KEY_ID);
  expect(serialized).not.toContain(SECRET_ENV.CDP_API_KEY_SECRET);
  expect(serialized).not.toContain(SECRET_ENV.CDP_WALLET_SECRET);
  expect(serialized).not.toContain(SECRET_ENV.BERTHOS_LEASE_TOKEN);
  expect(serialized).not.toContain(SECRET_ENV.STAGING_PAYER_PRIVATE_KEY);
  expect(serialized).not.toMatch(/0x[0-9a-fA-F]{64}/);
  expect(serialized.toLowerCase()).not.toContain("bearer");
  expect(serialized.toLowerCase()).not.toContain("spendpermission");
  expect(serialized.toLowerCase()).not.toContain("wallet_secret");
  const record = body as Record<string, unknown>;
  expect(record).not.toHaveProperty("CDP_API_KEY_ID");
  expect(record).not.toHaveProperty("CDP_API_KEY_SECRET");
  expect(record).not.toHaveProperty("CDP_WALLET_SECRET");
  expect(record).not.toHaveProperty("BERTHOS_LEASE_TOKEN");
  expect(record).not.toHaveProperty("STAGING_PAYER_PRIVATE_KEY");
}

describe("GET /health adapter identity", () => {
  it("defaults to memory + test facilitator (CI / npm start)", async () => {
    const { app } = await bootMarket({ env: {} });
    const res = await requestJson(app, "GET", "/health");
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(res.json.service).toBe("berth-market");
    expect(res.json.walletAdapter).toBe("memory");
    expect(res.json.facilitator).toBe("test");
    expect(res.json).not.toHaveProperty("facilitatorUrl");
    expect(res.json.network).toBe(BASE_SEPOLIA_CAIP2);
    expect(res.json.usdcAsset).toBe(USDC_BASE_SEPOLIA_ADDRESS);
    expect(res.json.protocolCutBps).toBe(1000);
    assertNoSecrets(res.json);
  });

  it("reports walletAdapter=cdp when WALLET_ADAPTER=cdp and a mock CDP client is injected", async () => {
    const { client } = mockCdpClient();
    const { app, deps } = await createApp({
      env: { ...SECRET_ENV },
      cdp: client,
    });
    expect(deps.wallets).toBeInstanceOf(CdpWalletAdapter);

    const res = await requestJson(app, "GET", "/health");
    expect(res.status).toBe(200);
    expect(res.json.walletAdapter).toBe("cdp");
    expect(res.json.facilitator).toBe("test");
    expect(res.json).not.toHaveProperty("facilitatorUrl");
    assertNoSecrets(res.json);
  });

  it("reports facilitator=live and facilitatorUrl when FACILITATOR_URL is set", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error("live facilitator must not be called for GET /health");
    };
    const { app, deps } = await createApp({
      env: { FACILITATOR_URL: LIVE_FACILITATOR_URL },
      fetchImpl,
    });
    expect(deps.facilitator).toBeInstanceOf(LiveFacilitator);

    const res = await requestJson(app, "GET", "/health");
    expect(res.status).toBe(200);
    expect(res.json.walletAdapter).toBe("memory");
    expect(res.json.facilitator).toBe("live");
    expect(res.json.facilitatorUrl).toBe(LIVE_FACILITATOR_URL);
    assertNoSecrets(res.json);
  });

  it("reports identity from injected createApp deps, not only env", async () => {
    const { client } = mockCdpClient();
    const store = new MemoryStore();
    const wallets = new CdpWalletAdapter({ ...SECRET_ENV }, { store, client });
    const facilitator = new LiveFacilitator(LIVE_FACILITATOR_URL, async () => {
      throw new Error("injected live facilitator must not be called for GET /health");
    });

    const { app } = await createApp({
      env: {},
      store,
      wallets,
      facilitator,
    });

    const res = await requestJson(app, "GET", "/health");
    expect(res.status).toBe(200);
    expect(res.json.walletAdapter).toBe("cdp");
    expect(res.json.facilitator).toBe("live");
    expect(res.json).not.toHaveProperty("facilitatorUrl");
    assertNoSecrets(res.json);
  });

  it("never copies env secrets onto the public health body", async () => {
    const { client } = mockCdpClient();
    const fetchImpl: typeof fetch = async () => {
      throw new Error("live facilitator must not be called for GET /health");
    };
    const { app, deps, config } = await createApp({
      env: { ...SECRET_ENV, FACILITATOR_URL: LIVE_FACILITATOR_URL },
      cdp: client,
      fetchImpl,
    });
    const res = await requestJson(app, "GET", "/health");
    expect(res.status).toBe(200);
    expect(res.json.walletAdapter).toBe("cdp");
    expect(res.json.facilitator).toBe("live");
    expect(res.json.facilitatorUrl).toBe(LIVE_FACILITATOR_URL);
    assertNoSecrets(res.json);
    assertNoSecrets(publicHealth(deps, config));
  });
});
