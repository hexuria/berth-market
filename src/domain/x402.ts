/**
 * x402 v2 wire types and header encoding.
 *
 * Official packages (@x402/core, @x402/hono) target static route tables plus a
 * live facilitator. Listings here are dynamic (per-SKU price + payTo), so we
 * implement the v2 header shape from the spec and keep a FacilitatorPort that
 * matches POST /verify and POST /settle.
 *
 * @see https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md
 * @see https://github.com/x402-foundation/x402/blob/main/specs/transports-v2/http.md
 */

import {
  BASE_SEPOLIA_CAIP2,
  usdcAddressFor,
  usdcEip712For,
  type SupportedCaip2,
} from "./money.js";

export const X402_VERSION = 2 as const;

export const PAYMENT_REQUIRED_HEADER = "PAYMENT-REQUIRED";
export const PAYMENT_SIGNATURE_HEADER = "PAYMENT-SIGNATURE";
export const PAYMENT_RESPONSE_HEADER = "PAYMENT-RESPONSE";

export type X402Scheme = "exact";
export type X402Network = SupportedCaip2;

export interface ResourceInfo {
  url: string;
  description?: string;
  mimeType?: string;
  serviceName?: string;
}

export interface PaymentRequirements {
  scheme: X402Scheme;
  network: X402Network;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: {
    name?: string;
    version?: string;
    listingId?: string;
    assetTransferMethod?: string;
    paymentFlow?: "authorization" | "upfront" | "escrow";
  };
}

export interface PaymentRequired {
  x402Version: typeof X402_VERSION;
  error?: string;
  resource: ResourceInfo;
  accepts: PaymentRequirements[];
  extensions?: Record<string, unknown>;
}

export interface ExactEvmAuthorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

export interface ExactEvmPayload {
  signature: string;
  authorization: ExactEvmAuthorization;
}

export interface PaymentPayload {
  x402Version: typeof X402_VERSION;
  resource?: ResourceInfo;
  accepted: PaymentRequirements;
  payload: ExactEvmPayload;
  extensions?: Record<string, unknown>;
}

export interface VerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
  extra?: Record<string, unknown>;
}

export interface SettlementResponse {
  success: boolean;
  errorReason?: string;
  payer?: string;
  transaction: string;
  network: string;
  amount?: string;
  extensions?: Record<string, unknown>;
}

export interface FacilitatorVerifyRequest {
  x402Version: typeof X402_VERSION;
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
}

export interface FacilitatorSettleRequest {
  x402Version: typeof X402_VERSION;
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
}

export function defaultUsdcRequirements(input: {
  amountAtomic: string;
  payTo: string;
  listingId?: string;
  network?: X402Network;
}): PaymentRequirements {
  const network = input.network ?? BASE_SEPOLIA_CAIP2;
  const eip712 = usdcEip712For(network);
  return {
    scheme: "exact",
    network,
    amount: input.amountAtomic,
    asset: usdcAddressFor(network),
    payTo: input.payTo,
    maxTimeoutSeconds: 60,
    extra: {
      name: eip712.name,
      version: eip712.version,
      listingId: input.listingId,
      assetTransferMethod: "eip3009",
    },
  };
}

export function encodeX402Header(value: unknown): string {
  const json = JSON.stringify(value);
  return bytesToBase64(new TextEncoder().encode(json));
}

export function decodeX402Header<T>(header: string): T {
  const bytes = base64ToBytes(header.trim());
  const json = new TextDecoder().decode(bytes);
  return JSON.parse(json) as T;
}

export function readHeader(headers: Headers, name: string): string | undefined {
  const direct = headers.get(name) ?? headers.get(name.toLowerCase());
  if (direct) return direct;
  for (const [key, value] of headers.entries()) {
    if (key.toLowerCase() === name.toLowerCase()) return value;
  }
  return undefined;
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(value, "base64"));
  }
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}
