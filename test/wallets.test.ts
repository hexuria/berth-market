import { describe, expect, it } from "vitest";
import { CdpWalletAdapter, createWalletPort, shouldUseCdpWallet } from "../src/adapters/cdp-wallet.js";
import { MemoryStore } from "../src/adapters/memory-store.js";
import { MemoryWalletAdapter } from "../src/adapters/memory-wallet.js";
import { createApp } from "../src/app.js";
import { bootMarket, requestJson } from "./helpers.js";

describe("wallets", () => {
  it("creates a capped agent and funds it with test USDC", async () => {
    const { app } = await bootMarket();

    const created = await requestJson(app, "POST", "/wallets/agent", {
      spendCap: "5000000",
      label: "research-agent",
    });
    expect(created.status).toBe(201);
    const wallet = created.json.wallet as {
      id: string;
      kind: string;
      spendCapAtomic: string;
      parentId?: string;
    };
    expect(wallet.kind).toBe("agent");
    expect(wallet.spendCapAtomic).toBe("5000000");
    expect(wallet.parentId).toBeTruthy();

    const funded = await requestJson(app, "POST", `/wallets/${wallet.id}/fund`, { amount: "2500000" });
    expect(funded.status).toBe(200);
    expect((funded.json.wallet as { balanceAtomic: string }).balanceAtomic).toBe("2500000");
  });

  it("rejects a zero spend cap", async () => {
    const { app } = await bootMarket();
    const created = await requestJson(app, "POST", "/wallets/agent", { spendCap: "0" });
    expect(created.status).toBe(400);
    expect((created.json.error as { code: string }).code).toBe("invalid_cap");
  });

  it("defaults to MemoryWalletAdapter and never constructs CDP without the env flag", async () => {
    expect(shouldUseCdpWallet({})).toBe(false);
    expect(createWalletPort(new MemoryStore(), {})).toBeInstanceOf(MemoryWalletAdapter);

    const { deps } = await createApp({ env: {} });
    expect(deps.wallets).toBeInstanceOf(MemoryWalletAdapter);

    expect(() => new CdpWalletAdapter({})).toThrow(/CDP_API_KEY_ID/);
    await expect(
      createApp({ env: { WALLET_ADAPTER: "cdp" } }),
    ).rejects.toThrow(/CdpWalletAdapter requires/);
  });
});
