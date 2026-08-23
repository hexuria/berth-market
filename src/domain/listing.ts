import { z } from "zod";
import { isEvmAddress, parseAtomic } from "./money.js";
import type { EligibilityAttestation } from "./eligibility.js";
import { eligibilityAttestationSchema, FORBIDDEN_CLASSES } from "./eligibility.js";

export const LISTING_KINDS = ["http", "mcp", "desktop.linux"] as const;
export type ListingKind = (typeof LISTING_KINDS)[number];

/** Never accepted as a listing kind or fulfillment class. */
export const FORBIDDEN_KINDS = [
  "laptop",
  "host-desktop",
  "host_desktop",
  "hostdesktop",
  "desktop.laptop",
  "desktop.host",
  "desktop.host-desktop",
] as const;

export const DESKTOP_KINDS = ["desktop.linux", "desktop.w365"] as const;

export function isDesktopKind(kind: string): boolean {
  return kind.startsWith("desktop.");
}

export function isForbiddenKind(kind: string): boolean {
  return (FORBIDDEN_KINDS as readonly string[]).includes(kind) || FORBIDDEN_CLASSES.has(kind);
}

const evmAddress = z
  .string()
  .refine(isEvmAddress, "payTo must be a 0x-prefixed 20-byte EVM address");

const priceSchema = z.object({
  amount: z.string().regex(/^\d+$/, "price.amount must be atomic USDC (integer string)"),
  asset: z.literal("USDC").default("USDC"),
  network: z.literal("eip155:8453").default("eip155:8453"),
});

const policySchema = z
  .object({
    maxInvocationsPerDay: z.number().int().positive().optional(),
    notes: z.string().max(500).optional(),
  })
  .strict()
  .optional();

const endpointSchema = z
  .object({
    url: z.string().url(),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
    tool: z.string().min(1).optional(),
  })
  .strict()
  .optional();

const fulfillmentSchema = z
  .object({
    berthosUrl: z.string().url().optional(),
    sku: z.string().min(1).optional(),
    nodeId: z.string().min(1).optional(),
  })
  .strict()
  .optional();

export const createListingSchema = z
  .object({
    kind: z.string().min(1),
    title: z.string().min(1).max(120),
    description: z.string().max(2000).optional(),
    price: priceSchema,
    payTo: evmAddress,
    policy: policySchema,
    endpoint: endpointSchema,
    fulfillment: fulfillmentSchema,
    class: z.string().min(1).optional(),
    eligibility: eligibilityAttestationSchema.optional(),
  })
  .strict();

export type CreateListingInput = z.infer<typeof createListingSchema>;

export interface Listing {
  id: string;
  kind: ListingKind;
  title: string;
  description?: string;
  price: {
    amount: string;
    asset: "USDC";
    network: "eip155:8453";
  };
  payTo: string;
  policy?: {
    maxInvocationsPerDay?: number;
    notes?: string;
  };
  endpoint?: {
    url: string;
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    tool?: string;
  };
  fulfillment?: {
    berthosUrl?: string;
    sku?: string;
    nodeId?: string;
  };
  class?: string;
  eligibility?: EligibilityAttestation;
  createdAt: string;
}

export class ListingValidationError extends Error {
  readonly status = 400;
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ListingValidationError";
    this.code = code;
  }
}

export function assertListingKind(kind: string): asserts kind is ListingKind {
  if (isForbiddenKind(kind)) {
    throw new ListingValidationError(
      "forbidden_class",
      `listings that claim kind=${kind} are rejected — only VM/server guests, never a laptop or host desktop`,
    );
  }
  if (!(LISTING_KINDS as readonly string[]).includes(kind)) {
    throw new ListingValidationError(
      "unsupported_kind",
      `unsupported listing kind "${kind}". v1 kinds: ${LISTING_KINDS.join(", ")}`,
    );
  }
}

export function assertAllowedClass(value: string | undefined, field: string): void {
  if (!value) return;
  if (FORBIDDEN_CLASSES.has(value)) {
    throw new ListingValidationError(
      "forbidden_class",
      `${field}=${value} is forbidden. Hard rule: only VM/server guests, never a laptop or host desktop`,
    );
  }
}

export function requireDesktopEligibility(input: CreateListingInput): EligibilityAttestation {
  if (!input.eligibility) {
    throw new ListingValidationError(
      "eligibility_required",
      "desktop listings fail closed without a Berthos doctor attestation",
    );
  }
  if (!input.eligibility.ok) {
    throw new ListingValidationError(
      "eligibility_failed",
      "desktop listings fail closed when the stored doctor attestation is not ok",
    );
  }
  assertAllowedClass(input.eligibility.class, "eligibility.class");
  return input.eligibility;
}

export function parseCreateListing(body: unknown): CreateListingInput {
  const parsed = createListingSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ListingValidationError(
      "invalid_listing",
      issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "invalid listing",
    );
  }
  parseAtomic(parsed.data.price.amount);
  if (parsed.data.price.amount === "0") {
    throw new ListingValidationError("invalid_price", "price.amount must be greater than 0");
  }
  return parsed.data;
}
