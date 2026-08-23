import { testPaymentSignature } from "../adapters/test-facilitator.js";
import {
  PAYMENT_SIGNATURE_HEADER,
  encodeX402Header,
  type PaymentPayload,
  type PaymentRequired,
} from "../domain/x402.js";

export function buildTestPayment(input: {
  quote: PaymentRequired;
  walletId: string;
  from: string;
}): { header: Record<string, string>; payload: PaymentPayload } {
  const accepted = input.quote.accepts[0];
  if (!accepted) throw new Error("quote has no accepts[]");
  const now = Math.floor(Date.now() / 1000);
  const payload: PaymentPayload = {
    x402Version: 2,
    resource: input.quote.resource,
    accepted,
    payload: {
      signature: testPaymentSignature(input.walletId),
      authorization: {
        from: input.from,
        to: accepted.payTo,
        value: accepted.amount,
        validAfter: String(now - 30),
        validBefore: String(now + 120),
        nonce: `0x${crypto.randomUUID().replaceAll("-", "")}`,
      },
    },
  };
  return {
    payload,
    header: { [PAYMENT_SIGNATURE_HEADER]: encodeX402Header(payload) },
  };
}
