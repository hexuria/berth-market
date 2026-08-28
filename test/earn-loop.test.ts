import { describe, expect, it } from "vitest";
import { earnLoopSmokeEnv, runEarnLoop } from "../src/earn/loop.js";

describe("earn-loop MemoryWallet smoke", () => {
  it("pays HTTP, MCP, and desktop.linux then stores occupancy (not a second charge)", async () => {
    const lines: string[] = [];
    const result = await runEarnLoop({
      env: {
        WALLET_ADAPTER: "cdp",
        FACILITATOR_URL: "https://x402.org/facilitator",
        BERTHOS_URL: "http://127.0.0.1:7432",
        BERTHOS_LEASE_TOKEN: "must-not-be-used",
        CDP_API_KEY_ID: "must-not-be-used",
        CDP_API_KEY_SECRET: "must-not-be-used",
        CDP_WALLET_SECRET: "must-not-be-used",
      },
      log: (line) => lines.push(line),
    });

    expect(result.http.kind).toBe("http");
    expect(result.http.receipt.amountAtomic).toBe("100000");
    expect(result.http.receipt.sellerAtomic).toBe("90000");
    expect(result.http.receipt.protocolAtomic).toBe("10000");
    expect(result.http.receipt.onChainSettlement).toBe("payTo_100");
    expect(result.http.receipt.onChainSettlement).not.toBe("cdp_split_90_10");
    expect(result.http.receipt.leaseId).toBeUndefined();

    expect(result.mcp.kind).toBe("mcp");
    expect(result.mcp.receipt.amountAtomic).toBe("100000");
    expect(result.mcp.receipt.sellerAtomic).toBe("90000");
    expect(result.mcp.receipt.protocolAtomic).toBe("10000");
    expect(result.mcp.receipt.onChainSettlement).toBe("payTo_100");
    expect(result.mcp.receipt.leaseId).toBeUndefined();
    const mcpFulfillment = result.mcp.fulfillment as {
      kind: string;
      tool: string;
      result: { proxied: boolean };
    };
    expect(mcpFulfillment.kind).toBe("mcp");
    expect(mcpFulfillment.tool).toBe("search");
    expect(mcpFulfillment.result.proxied).toBe(false);

    expect(result.desktop.kind).toBe("desktop.linux");
    expect(result.desktop.receipt.amountAtomic).toBe("1000000");
    expect(result.desktop.receipt.sellerAtomic).toBe("900000");
    expect(result.desktop.receipt.protocolAtomic).toBe("100000");
    expect(result.desktop.receipt.onChainSettlement).toBe("payTo_100");
    expect(result.desktop.receipt.leaseId).toMatch(/^l_/);
    expect(result.desktop.occupancy.chargedHere).toBe(false);
    expect(result.desktop.occupancy.seconds).toBe(12);
    expect(result.desktop.occupancy.billedSeconds).toBe(60);

    expect(result.refused.laptop).toBe(true);
    expect(result.refused.hostDesktop).toBe(true);

    const log = lines.join("\n");
    expect(log).toMatch(/HTTP \+ MCP \+ desktop\.linux/);
    expect(log).toMatch(/http\s+lst_/);
    expect(log).toMatch(/mcp\s+lst_/);
    expect(log).toMatch(/desktop\.linux\s+lst_/);
    expect(log).toMatch(/proxied=false/);
    expect(log).toMatch(/no leaseId/);
    expect(log).toMatch(/leaseId=l_/);
    expect(log).toMatch(/end-lease\s+occupancy=12s billed=60s chargedHere=false/);
    expect(log).toMatch(/refused\s+laptop \/ host-desktop/);
    expect(log).toMatch(/onChainSettlement=payTo_100/);
    expect(log).not.toMatch(/cdp_split_90_10/);
  });

  it("strips live wallet / facilitator / Berthos env so CI stays MemoryWallet", () => {
    const env = earnLoopSmokeEnv({
      WALLET_ADAPTER: "cdp",
      FACILITATOR_URL: "https://x402.org/facilitator",
      BERTHOS_URL: "http://127.0.0.1:7432",
      BERTHOS_LEASE_TOKEN: "tok",
      CDP_API_KEY_ID: "id",
    });
    expect(env.WALLET_ADAPTER).toBe("memory");
    expect(env.FACILITATOR_URL).toBeUndefined();
    expect(env.BERTHOS_URL).toBeUndefined();
    expect(env.BERTHOS_LEASE_TOKEN).toBeUndefined();
    expect(env.CDP_API_KEY_ID).toBeUndefined();
  });
});
