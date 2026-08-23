import { describe, expect, it } from "vitest";
import {
  CdpWalletAdapter,
  createWalletPort,
  resolveCdpNetwork,
  shouldUseCdpWallet,
} from "../src/adapters/cdp-wallet.js";
import { MemoryStore } from "../src/adapters/memory-store.js";
import { MemoryWalletAdapter } from "../src/adapters/memory-wallet.js";
import { createApp } from "../src/app.js";
import { BASE_SEPOLIA_CAIP2 } from "../src/domain/money.js";
import { bootMarket, mockCdpClient, requestJson, TEST_CDP_ENV } from "./helpers.js";

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

describe("wallet adapter factory", () => {
  it("defaults to MemoryWalletAdapter and never constructs CDP without the env flag", async () => {
    expect(shouldUseCdpWallet({})).toBe(false);
    expect(shouldUseCdpWallet({ WALLET_ADAPTER: "memory" })).toBe(false);
    expect(createWalletPort(new MemoryStore(), {})).toBeInstanceOf(MemoryWalletAdapter);
    expect(
      createWalletPort(new MemoryStore(), {
        CDP_API_KEY_ID: "x",
        CDP_API_KEY_SECRET: "y",
        CDP_WALLET_SECRET: "z",
      }),
    ).toBeInstanceOf(MemoryWalletAdapter);

    const { deps } = await createApp({ env: {} });
    expect(deps.wallets).toBeInstanceOf(MemoryWalletAdapter);

    expect(() => new CdpWalletAdapter({})).toThrow(/CDP_API_KEY_ID/);
    await expect(createApp({ env: { WALLET_ADAPTER: "cdp" } })).rejects.toThrow(
      /CdpWalletAdapter requires/,
    );
  });

  it("does not construct the live adapter when the flag is set but a key is missing", () => {
    const store = new MemoryStore();
    expect(() =>
      createWalletPort(store, {
        WALLET_ADAPTER: "cdp",
        CDP_API_KEY_ID: "x",
        CDP_API_KEY_SECRET: "y",
      }),
    ).toThrow(/CDP_WALLET_SECRET/);
    expect(() =>
      createWalletPort(store, {
        WALLET_ADAPTER: "cdp",
        CDP_API_KEY_ID: "x",
        CDP_WALLET_SECRET: "z",
      }),
    ).toThrow(/CDP_API_KEY_SECRET/);
  });

  it("constructs CdpWalletAdapter only when the flag and all three keys are present", async () => {
    const { client, calls } = mockCdpClient();
    const store = new MemoryStore();
    const port = createWalletPort(store, { ...TEST_CDP_ENV }, { client });
    expect(port).toBeInstanceOf(CdpWalletAdapter);
    expect((port as CdpWalletAdapter).network).toBe("base-sepolia");

    const { deps } = await createApp({
      env: { ...TEST_CDP_ENV },
      cdp: client,
    });
    expect(deps.wallets).toBeInstanceOf(CdpWalletAdapter);
    expect(calls.some((row) => row.op === "createSmartAccount")).toBe(true);
    expect(calls.some((row) => row.enableSpendPermissions === true)).toBe(true);
    expect(JSON.stringify(calls)).not.toContain('"base"');
  });
});

describe("CDP network (Sepolia default, no mainnet default)", () => {
  it("defaults live CDP to base-sepolia even when catalog NETWORK is unset", () => {
    expect(resolveCdpNetwork({})).toBe("base-sepolia");
    expect(resolveCdpNetwork({ NETWORK: "base-sepolia" })).toBe("base-sepolia");
    expect(resolveCdpNetwork({ NETWORK: BASE_SEPOLIA_CAIP2 })).toBe("base-sepolia");
    expect(resolveCdpNetwork({ CDP_NETWORK: "base-sepolia", NETWORK: "eip155:8453" })).toBe(
      "base-sepolia",
    );
  });

  it("selects mainnet only when NETWORK or CDP_NETWORK is explicitly base", () => {
    expect(resolveCdpNetwork({ NETWORK: "eip155:8453" })).toBe("base");
    expect(resolveCdpNetwork({ NETWORK: "base" })).toBe("base");
    expect(resolveCdpNetwork({ CDP_NETWORK: "base" })).toBe("base");
  });

  it("CdpWalletAdapter.network is base-sepolia unless explicitly base", () => {
    const sepolia = new CdpWalletAdapter({ ...TEST_CDP_ENV }, { client: mockCdpClient().client });
    expect(sepolia.network).toBe("base-sepolia");
    const base = new CdpWalletAdapter(
      { ...TEST_CDP_ENV, NETWORK: "base" },
      { client: mockCdpClient().client },
    );
    expect(base.network).toBe("base");
  });
});

describe("CdpWalletAdapter (mocked SDK, no live Coinbase)", () => {
  it("creates a treasury smart account, a capped agent, and faucets on Sepolia", async () => {
    const { client, calls } = mockCdpClient();
    const wallets = new CdpWalletAdapter({ ...TEST_CDP_ENV }, { store: new MemoryStore(), client });

    const treasury = await wallets.createTreasury({ label: "seller" });
    expect(treasury.kind).toBe("treasury");
    expect(treasury.cdp?.ownerAddress).toMatch(/^0x/);

    const agent = await wallets.createAgent({
      treasuryId: treasury.id,
      spendCapAtomic: 5_000_000n,
      label: "research-agent",
    });
    expect(agent.kind).toBe("agent");
    expect(agent.cdp?.spendPermission?.allowance).toBe("5000000");

    const funded = await wallets.fund(agent.id, 2_000_000n);
    expect(funded.balanceAtomic).toBe("2000000");

    expect(calls.filter((row) => row.op === "createAccount").length).toBeGreaterThanOrEqual(2);
    expect(calls.some((row) => row.op === "createSmartAccount" && row.enableSpendPermissions)).toBe(
      true,
    );
    expect(calls.some((row) => row.op === "createSpendPermission" && row.network === "base-sepolia")).toBe(
      true,
    );
    expect(calls.some((row) => row.op === "requestFaucet" && row.network === "base-sepolia")).toBe(
      true,
    );
    expect(calls.some((row) => row.op === "requestFaucet" && row.token === "usdc")).toBe(true);
    expect(calls.every((row) => row.network !== "base")).toBe(true);
  });

  it("settles 90/10 as two USDC transfers after useSpendPermission", async () => {
    const { client, calls } = mockCdpClient();
    const wallets = new CdpWalletAdapter({ ...TEST_CDP_ENV }, { store: new MemoryStore(), client });
    const treasury = await wallets.createTreasury({ label: "seller" });
    const protocol = await wallets.createTreasury({
      label: "protocol",
      address: "0x3333333333333333333333333333333333333333",
    });
    const agent = await wallets.createAgent({
      treasuryId: treasury.id,
      spendCapAtomic: 5_000_000n,
    });
    await wallets.fund(agent.id, 2_000_000n);

    const payout = await wallets.settleListingPayment({
      payerId: agent.id,
      sellerAddress: treasury.address,
      protocolAddress: protocol.address,
      amountAtomic: 100_000n,
    });

    expect(payout.sellerAtomic).toBe(90_000n);
    expect(payout.protocolAtomic).toBe(10_000n);
    expect(payout.onChainSettlement).toBe("cdp_split_90_10");
    expect(payout.sellerTxHash).toMatch(/^0x/);
    expect(payout.protocolTxHash).toMatch(/^0x/);

    const spend = calls.find((row) => row.op === "useSpendPermission");
    expect(spend?.value).toBe("100000");
    expect(spend?.network).toBe("base-sepolia");

    const transfers = calls.filter((row) => row.op === "transfer");
    expect(transfers).toHaveLength(2);
    expect(transfers[0]).toMatchObject({
      to: treasury.address,
      amount: "90000",
      token: "usdc",
      network: "base-sepolia",
    });
    expect(transfers[1]).toMatchObject({
      to: protocol.address,
      amount: "10000",
      token: "usdc",
      network: "base-sepolia",
    });

    const sellerAfter = await wallets.get(treasury.id);
    const protocolAfter = await wallets.get(protocol.id);
    const agentAfter = await wallets.get(agent.id);
    expect(sellerAfter?.balanceAtomic).toBe("90000");
    expect(protocolAfter?.balanceAtomic).toBe("10000");
    expect(agentAfter?.spentAtomic).toBe("100000");
    expect(agentAfter?.balanceAtomic).toBe("1900000");
  });

  it("refuses fund() on explicit mainnet (no invented faucet)", async () => {
    const { client } = mockCdpClient();
    const wallets = new CdpWalletAdapter(
      { ...TEST_CDP_ENV, NETWORK: "eip155:8453" },
      { store: new MemoryStore(), client },
    );
    const treasury = await wallets.createTreasury();
    await expect(wallets.fund(treasury.id, 1000n)).rejects.toMatchObject({
      code: "faucet_unavailable",
    });
  });
});
