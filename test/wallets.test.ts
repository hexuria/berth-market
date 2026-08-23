import { describe, expect, it } from "vitest";
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
});
