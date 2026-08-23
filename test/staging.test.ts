import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getAddress, verifyTypedData } from "viem";
import { LiveFacilitator, joinFacilitatorPath } from "../src/adapters/live-facilitator.js";
import { createApp } from "../src/app.js";
import {
  BASE_CAIP2,
  BASE_SEPOLIA_CAIP2,
  USDC_BASE_ADDRESS,
  USDC_BASE_SEPOLIA_ADDRESS,
  chainIdFor,
  parseListingNetwork,
} from "../src/domain/money.js";
import {
  PAYMENT_SIGNATURE_HEADER,
  X402_VERSION,
  encodeX402Header,
  type PaymentRequired,
} from "../src/domain/x402.js";
import { PUBLIC_X402_FACILITATOR_URL, STAGING_AMOUNT_ATOMIC, resolveStagingLoopEnv } from "../src/staging/env.js";
import { runSepoliaLoop } from "../src/staging/loop.js";
import { signExactEvmPayment } from "../src/staging/signer.js";
import { bootMarket, httpListing, requestJson } from "./helpers.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockFacilitatorFetch(calls: { url: string; body: Record<string, unknown> }[], tx = "0xsepoliatx") {
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ url, body });
    const payload = body.paymentPayload as { payload?: { authorization?: { from?: string } } };
    const from = payload?.payload?.authorization?.from ?? "0x2222222222222222222222222222222222222222";
    if (url.endsWith("/verify")) {
      return jsonResponse({ isValid: true, payer: from });
    }
    if (url.endsWith("/settle")) {
      return jsonResponse({
        success: true,
        transaction: tx,
        network: BASE_SEPOLIA_CAIP2,
        payer: from,
      });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  return fetchImpl;
}

describe("Base Sepolia staging network", () => {
  it("normalizes base-sepolia to eip155:84532 and keeps 8453 as mainnet", () => {
    expect(parseListingNetwork("base-sepolia")).toBe(BASE_SEPOLIA_CAIP2);
    expect(parseListingNetwork("eip155:84532")).toBe(BASE_SEPOLIA_CAIP2);
    expect(parseListingNetwork("eip155:8453")).toBe(BASE_CAIP2);
    expect(() => parseListingNetwork("eip155:1")).toThrow(/unsupported network/);
  });

  it("stores a base-sepolia listing as eip155:84532 and quotes Sepolia USDC, not 8453", async () => {
    const { app } = await bootMarket();
    const created = await requestJson(app, "POST", "/listings", {
      ...httpListing("0x1111111111111111111111111111111111111111"),
      price: { amount: "1000", asset: "USDC", network: "base-sepolia" },
    });
    expect(created.status).toBe(201);
    const listing = created.json.listing as { id: string; price: { network: string; amount: string } };
    expect(listing.price.network).toBe(BASE_SEPOLIA_CAIP2);

    const unpaid = await requestJson(app, "GET", `/listings/${listing.id}/invoke`);
    expect(unpaid.status).toBe(402);
    const quote = unpaid.json.quote as { accepts: { network: string; asset: string; extra?: { name?: string } }[] };
    expect(quote.accepts[0]?.network).toBe(BASE_SEPOLIA_CAIP2);
    expect(quote.accepts[0]?.asset).toBe(USDC_BASE_SEPOLIA_ADDRESS);
    expect(quote.accepts[0]?.asset).not.toBe(USDC_BASE_ADDRESS);
    expect(quote.accepts[0]?.extra?.name).toBe("USDC");
    expect(JSON.stringify(unpaid.json)).not.toContain(`"${BASE_CAIP2}"`);
  });

  it("rejects an unknown listing network", async () => {
    const { app } = await bootMarket();
    const res = await requestJson(app, "POST", "/listings", {
      ...httpListing("0x1111111111111111111111111111111111111111"),
      price: { amount: "1000", asset: "USDC", network: "eip155:1" },
    });
    expect(res.status).toBe(400);
    expect((res.json.error as { code: string }).code).toBe("invalid_listing");
  });
});

describe("facilitator-authoritative Sepolia settle", () => {
  it("settles an eip155:84532 listing via mocked LiveFacilitator and does not mint MemoryWallet USDC", async () => {
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const { app, deps } = await createApp({
      env: { FACILITATOR_URL: PUBLIC_X402_FACILITATOR_URL },
      fetchImpl: mockFacilitatorFetch(calls),
    });
    expect(deps.facilitator).toBeInstanceOf(LiveFacilitator);

    const listed = await requestJson(app, "POST", "/listings", {
      kind: "http",
      title: "sepolia.staging.ping",
      price: { amount: STAGING_AMOUNT_ATOMIC, asset: "USDC", network: BASE_SEPOLIA_CAIP2 },
      payTo: "0x1111111111111111111111111111111111111111",
      endpoint: { url: "https://example.com/sepolia-ping", method: "GET" },
    });
    expect(listed.status).toBe(201);
    const listing = listed.json.listing as { id: string };

    const unpaid = await requestJson(app, "GET", `/listings/${listing.id}/invoke`);
    const quote = unpaid.json.quote as PaymentRequired;
    const { payload } = await signExactEvmPayment({ privateKey, quote });

    const paid = await requestJson(app, "GET", `/listings/${listing.id}/invoke`, undefined, {
      [PAYMENT_SIGNATURE_HEADER]: encodeX402Header(payload),
    });
    expect(paid.status).toBe(200);
    const receipt = paid.json.receipt as {
      transaction: string;
      network: string;
      sellerAtomic: string;
      protocolAtomic: string;
      amountAtomic: string;
      payerAddress: string;
      payerWalletId: string;
      onChainSettlement?: string;
    };
    expect(receipt.network).toBe(BASE_SEPOLIA_CAIP2);
    expect(receipt.transaction).toBe("0xsepoliatx");
    expect(receipt.amountAtomic).toBe("1000");
    expect(receipt.sellerAtomic).toBe("900");
    expect(receipt.protocolAtomic).toBe("100");
    expect(receipt.payerAddress).toBe(account.address.toLowerCase());
    expect(receipt.payerWalletId).toBe(`eoa:${account.address.toLowerCase()}`);
    expect(receipt.onChainSettlement).toBe("payTo_100");

    const protocolAfter = await requestJson(app, "GET", `/wallets/${deps.protocolTreasury.id}`);
    expect((protocolAfter.json.wallet as { balanceAtomic: string }).balanceAtomic).toBe("0");

    expect(calls.map((c) => c.url)).toEqual([
      `${PUBLIC_X402_FACILITATOR_URL}/verify`,
      `${PUBLIC_X402_FACILITATOR_URL}/settle`,
    ]);
    for (const call of calls) {
      const serialized = JSON.stringify(call.body);
      expect(serialized).not.toContain(`"${BASE_CAIP2}"`);
      expect(serialized).not.toContain(USDC_BASE_ADDRESS);
      expect(call.body.x402Version).toBe(X402_VERSION);
      expect(call.body.paymentPayload).toBeTruthy();
      expect(call.body.paymentRequirements).toBeTruthy();
      const requirements = call.body.paymentRequirements as { network: string; asset: string };
      expect(requirements.network).toBe(BASE_SEPOLIA_CAIP2);
      expect(requirements.asset).toBe(USDC_BASE_SEPOLIA_ADDRESS);
    }
  });

  it("joins FACILITATOR_URL paths so https://x402.org/facilitator/verify is used", () => {
    expect(joinFacilitatorPath("https://x402.org/facilitator", "/verify")).toBe(
      "https://x402.org/facilitator/verify",
    );
    expect(joinFacilitatorPath("https://api.cdp.coinbase.com/platform/v2/x402/", "settle")).toBe(
      "https://api.cdp.coinbase.com/platform/v2/x402/settle",
    );
  });
});

describe("sepolia-loop", () => {
  it("exits as a skip when the payer key and STAGING_PAY_TO are unset", async () => {
    const lines: string[] = [];
    let fetched = false;
    const result = await runSepoliaLoop({
      env: {},
      fetchImpl: async () => {
        fetched = true;
        throw new Error("sepolia-loop skip path must not fetch");
      },
      log: (line) => lines.push(line),
    });
    expect(result.skipped).toBe(true);
    if (result.skipped) {
      expect(result.reason).toMatch(/skipped/);
      expect(result.reason).toMatch(/STAGING_PAYER_PRIVATE_KEY/);
    }
    expect(lines.join("\n")).toMatch(/skipped/);
    expect(fetched).toBe(false);
  });

  it("refuses NETWORK=eip155:8453 so staging traffic cannot hit mainnet", () => {
    expect(() =>
      resolveStagingLoopEnv({
        NETWORK: "eip155:8453",
        STAGING_PAYER_PRIVATE_KEY: `0x${"11".repeat(32)}`,
        STAGING_PAY_TO: "0x1111111111111111111111111111111111111111",
      }),
    ).toThrow(/refuses mainnet/);
    expect(() => resolveStagingLoopEnv({ NETWORK: "base" })).toThrow(/refuses mainnet/);
  });

  it("defaults FACILITATOR_URL to the public x402.org facilitator and never quotes 8453", async () => {
    const privateKey = generatePrivateKey();
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const result = await runSepoliaLoop({
      env: {
        STAGING_PAYER_PRIVATE_KEY: privateKey,
        STAGING_PAY_TO: "0x1111111111111111111111111111111111111111",
        NETWORK: "base-sepolia",
      },
      fetchImpl: mockFacilitatorFetch(calls, "0xlooptx"),
    });
    expect(result.skipped).toBe(false);
    if (result.skipped) throw new Error("expected a live (mocked) settle");
    expect(result.facilitatorUrl).toBe(PUBLIC_X402_FACILITATOR_URL);
    expect(result.receipt.network).toBe(BASE_SEPOLIA_CAIP2);
    expect(result.receipt.transaction).toBe("0xlooptx");
    expect(result.receipt.sellerAtomic).toBe("900");
    expect(result.receipt.protocolAtomic).toBe("100");
    expect(result.receipt.onChainSettlement).toBe("payTo_100");
    expect(JSON.stringify(calls)).not.toContain(`"${BASE_CAIP2}"`);
    expect(calls.every((c) => c.url.startsWith(`${PUBLIC_X402_FACILITATOR_URL}/`))).toBe(true);
  });

  it("is honest: public facilitator settle is 100% to payTo; 90/10 is receipt-only", async () => {
    const privateKey = generatePrivateKey();
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const payTo = "0x1111111111111111111111111111111111111111";
    const { app, deps } = await createApp({
      env: { FACILITATOR_URL: PUBLIC_X402_FACILITATOR_URL },
      fetchImpl: mockFacilitatorFetch(calls),
    });

    const listed = await requestJson(app, "POST", "/listings", {
      kind: "http",
      title: "sepolia.honesty.ping",
      price: { amount: STAGING_AMOUNT_ATOMIC, asset: "USDC", network: BASE_SEPOLIA_CAIP2 },
      payTo,
      endpoint: { url: "https://example.com/sepolia-ping", method: "GET" },
    });
    const listing = listed.json.listing as { id: string };
    const unpaid = await requestJson(app, "GET", `/listings/${listing.id}/invoke`);
    const quote = unpaid.json.quote as PaymentRequired;
    const { payload } = await signExactEvmPayment({ privateKey, quote });
    const paid = await requestJson(app, "GET", `/listings/${listing.id}/invoke`, undefined, {
      [PAYMENT_SIGNATURE_HEADER]: encodeX402Header(payload),
    });
    expect(paid.status).toBe(200);

    const settle = calls.find((c) => c.url.endsWith("/settle"));
    expect(settle).toBeTruthy();
    const requirements = settle?.body.paymentRequirements as {
      amount: string;
      payTo: string;
      network: string;
    };
    // One payTo, full amount — not 90% + a second protocol settle.
    expect(calls.filter((c) => c.url.endsWith("/settle"))).toHaveLength(1);
    expect(requirements.amount).toBe(STAGING_AMOUNT_ATOMIC);
    expect(requirements.payTo.toLowerCase()).toBe(payTo);
    expect(requirements.network).toBe(BASE_SEPOLIA_CAIP2);

    const receipt = paid.json.receipt as {
      amountAtomic: string;
      sellerAtomic: string;
      protocolAtomic: string;
      sellerAddress: string;
      onChainSettlement?: string;
    };
    expect(receipt.amountAtomic).toBe("1000");
    expect(receipt.sellerAtomic).toBe("900");
    expect(receipt.protocolAtomic).toBe("100");
    expect(BigInt(receipt.sellerAtomic) + BigInt(receipt.protocolAtomic)).toBe(
      BigInt(receipt.amountAtomic),
    );
    expect(receipt.sellerAddress).toBe(payTo);
    expect(receipt.onChainSettlement).toBe("payTo_100");

    const protocolAfter = await requestJson(app, "GET", `/wallets/${deps.protocolTreasury.id}`);
    expect((protocolAfter.json.wallet as { balanceAtomic: string }).balanceAtomic).toBe("0");
  });

  it("signs a recoverable EIP-3009 TransferWithAuthorization for Base Sepolia USDC", async () => {
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    const quote: PaymentRequired = {
      x402Version: 2,
      resource: { url: "http://127.0.0.1/listings/lst_1/invoke", serviceName: "berth-market" },
      accepts: [
        {
          scheme: "exact",
          network: BASE_SEPOLIA_CAIP2,
          amount: "1000",
          asset: USDC_BASE_SEPOLIA_ADDRESS,
          payTo: "0x1111111111111111111111111111111111111111",
          maxTimeoutSeconds: 60,
          extra: { name: "USDC", version: "2", assetTransferMethod: "eip3009" },
        },
      ],
    };
    const { payload, from } = await signExactEvmPayment({ privateKey, quote });
    expect(from).toBe(account.address);
    expect(payload.accepted.network).toBe(BASE_SEPOLIA_CAIP2);
    const auth = payload.payload.authorization;
    const valid = await verifyTypedData({
      address: account.address,
      domain: {
        name: "USDC",
        version: "2",
        chainId: chainIdFor(BASE_SEPOLIA_CAIP2),
        verifyingContract: getAddress(USDC_BASE_SEPOLIA_ADDRESS),
      },
      types: {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "TransferWithAuthorization",
      message: {
        from: auth.from as `0x${string}`,
        to: auth.to as `0x${string}`,
        value: BigInt(auth.value),
        validAfter: BigInt(auth.validAfter),
        validBefore: BigInt(auth.validBefore),
        nonce: auth.nonce as `0x${string}`,
      },
      signature: payload.payload.signature as `0x${string}`,
    });
    expect(valid).toBe(true);
  });
});
