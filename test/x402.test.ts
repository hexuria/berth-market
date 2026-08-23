import { describe, expect, it } from "vitest";
import {
  decodeX402Header,
  encodeX402Header,
  PAYMENT_REQUIRED_HEADER,
  type PaymentRequired,
} from "../src/domain/x402.js";
import { formatUsdc, parseUsdc, splitProceeds } from "../src/domain/money.js";
import { CdpWalletAdapter } from "../src/adapters/cdp-wallet.js";

describe("x402 headers and money", () => {
  it("round-trips a v2 PAYMENT-REQUIRED object", () => {
    const required: PaymentRequired = {
      x402Version: 2,
      error: "PAYMENT-SIGNATURE header is required",
      resource: { url: "http://127.0.0.1/listings/lst_1/invoke", serviceName: "berth-market" },
      accepts: [
        {
          scheme: "exact",
          network: "eip155:8453",
          amount: "100000",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          payTo: "0x1111111111111111111111111111111111111111",
          maxTimeoutSeconds: 60,
        },
      ],
    };
    const encoded = encodeX402Header(required);
    expect(encoded).not.toContain("{");
    expect(decodeX402Header<PaymentRequired>(encoded)).toEqual(required);
    expect(PAYMENT_REQUIRED_HEADER).toBe("PAYMENT-REQUIRED");
  });

  it("splits a 10% protocol cut without floats", () => {
    expect(splitProceeds(100000n)).toEqual({ sellerAtomic: 90000n, protocolAtomic: 10000n });
    expect(parseUsdc("1.50")).toBe(1_500_000n);
    expect(formatUsdc(1_500_000n)).toBe("1.5");
  });

  it("does not construct a live CDP adapter without keys", () => {
    expect(() => new CdpWalletAdapter({})).toThrow(/CdpWalletAdapter requires/);
  });
});
