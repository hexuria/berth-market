import { describe, expect, it } from "vitest";
import { LiveFacilitator, createFacilitator, joinFacilitatorPath } from "../src/adapters/live-facilitator.js";
import { MemoryStore } from "../src/adapters/memory-store.js";
import { TestFacilitator } from "../src/adapters/test-facilitator.js";
import { createApp } from "../src/app.js";
import { X402_VERSION, type PaymentPayload, type PaymentRequirements } from "../src/domain/x402.js";

const requirements: PaymentRequirements = {
  scheme: "exact",
  network: "eip155:8453",
  amount: "100000",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  payTo: "0x1111111111111111111111111111111111111111",
  maxTimeoutSeconds: 60,
};

const payload: PaymentPayload = {
  x402Version: X402_VERSION,
  accepted: requirements,
  payload: {
    signature: "0xdead",
    authorization: {
      from: "0x2222222222222222222222222222222222222222",
      to: requirements.payTo,
      value: requirements.amount,
      validAfter: "0",
      validBefore: "9999999999",
      nonce: "0xabc",
    },
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("facilitator adapters", () => {
  it("keeps TestFacilitator as the default when FACILITATOR_URL is unset", async () => {
    const { deps } = await createApp({ env: {} });
    expect(deps.facilitator).toBeInstanceOf(TestFacilitator);
    expect(createFacilitator(new MemoryStore(), {})).toBeInstanceOf(TestFacilitator);
  });

  it("LiveFacilitator POSTs /verify and /settle only through the injected fetch", async () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method: init?.method ?? "GET", body });
      if (url.endsWith("/verify")) {
        return jsonResponse({ isValid: true, payer: payload.payload.authorization.from });
      }
      if (url.endsWith("/settle")) {
        return jsonResponse({
          success: true,
          transaction: "0xabc",
          network: requirements.network,
          payer: payload.payload.authorization.from,
        });
      }
      throw new Error(`unexpected URL ${url}`);
    };

    const facilitator = new LiveFacilitator("https://facilitator.example", fetchImpl);
    const verify = await facilitator.verify({
      x402Version: X402_VERSION,
      paymentPayload: payload,
      paymentRequirements: requirements,
    });
    const settle = await facilitator.settle({
      x402Version: X402_VERSION,
      paymentPayload: payload,
      paymentRequirements: requirements,
    });

    expect(verify.isValid).toBe(true);
    expect(settle.success).toBe(true);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST https://facilitator.example/verify",
      "POST https://facilitator.example/settle",
    ]);
    expect(calls[0]?.body).toMatchObject({
      x402Version: X402_VERSION,
      paymentPayload: payload,
      paymentRequirements: requirements,
    });
  });

  it("keeps the /facilitator prefix when joining verify/settle paths", () => {
    expect(joinFacilitatorPath("https://x402.org/facilitator", "/verify")).toBe(
      "https://x402.org/facilitator/verify",
    );
  });

  it("createApp uses LiveFacilitator only when FACILITATOR_URL is set (mocked fetch)", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error("live facilitator must not be called during boot");
    };
    const { deps } = await createApp({
      env: { FACILITATOR_URL: "https://facilitator.example" },
      fetchImpl,
    });
    expect(deps.facilitator).toBeInstanceOf(LiveFacilitator);
  });
});
