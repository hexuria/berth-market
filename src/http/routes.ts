import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  assertAllowedClass,
  assertListingKind,
  isDesktopKind,
  parseCreateListing,
  requireDesktopEligibility,
  type Listing,
} from "../domain/listing.js";
import { normalizeAddress, parseAtomic } from "../domain/money.js";
import { WalletError } from "../domain/wallet.js";
import {
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  X402_VERSION,
  decodeX402Header,
  defaultUsdcRequirements,
  encodeX402Header,
  readHeader,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequirements,
} from "../domain/x402.js";
import { nowIso, newId } from "../adapters/ids.js";
import { walletIdFromSignature } from "../adapters/test-facilitator.js";
import type { MarketDependencies } from "../deps.js";
import { toErrorResponse } from "./errors.js";

const createAgentSchema = z.object({
  treasuryId: z.string().min(1).optional(),
  spendCap: z.string().regex(/^\d+$/, "spendCap must be atomic USDC"),
  label: z.string().max(80).optional(),
  treasuryLabel: z.string().max(80).optional(),
});

const fundSchema = z.object({
  amount: z.string().regex(/^\d+$/, "amount must be atomic USDC"),
});

export function createRouter(deps: MarketDependencies): Hono {
  const app = new Hono();

  app.onError((error, c) => {
    const mapped = toErrorResponse(error);
    return c.json(mapped.body, mapped.status as 400);
  });

  app.get("/health", (c) =>
    c.json({
      ok: true,
      service: "berth-market",
      asset: "USDC",
      network: "eip155:8453",
      protocolCutBps: 1000,
    }),
  );

  app.post("/listings", async (c) => {
    const input = parseCreateListing(await c.req.json());
    assertListingKind(input.kind);
    assertAllowedClass(input.class, "class");
    assertAllowedClass(input.eligibility?.class, "eligibility.class");

    let eligibility = input.eligibility;
    if (isDesktopKind(input.kind)) {
      const submitted = requireDesktopEligibility(input);
      const decision = await deps.eligibility.verify(submitted);
      if (!decision.ok || !decision.attestation) {
        return c.json(
          {
            error: {
              code: "eligibility_failed",
              message: decision.reason ?? "desktop listing failed Berthos doctor attestation",
            },
          },
          400,
        );
      }
      eligibility = decision.attestation;
    }

    const listing: Listing = {
      id: newId("lst"),
      kind: input.kind,
      title: input.title,
      description: input.description,
      price: {
        amount: input.price.amount,
        asset: "USDC",
        network: "eip155:8453",
      },
      payTo: normalizeAddress(input.payTo),
      policy: input.policy,
      endpoint: input.endpoint,
      fulfillment: input.fulfillment,
      class: input.class,
      eligibility,
      createdAt: nowIso(),
    };
    await deps.store.putListing(listing);
    return c.json({ listing }, 201);
  });

  app.get("/listings", async (c) => {
    const listings = await deps.store.listListings();
    return c.json({ listings });
  });

  app.get("/listings/:id", async (c) => {
    const listing = await deps.store.getListing(c.req.param("id"));
    if (!listing) {
      return c.json({ error: { code: "not_found", message: "listing not found" } }, 404);
    }
    return c.json({ listing });
  });

  app.get("/listings/:id/invoke", async (c) => {
    const listing = await deps.store.getListing(c.req.param("id"));
    if (!listing) {
      return c.json({ error: { code: "not_found", message: "listing not found" } }, 404);
    }

    const requirements = quoteFor(listing);
    const signatureHeader = readHeader(c.req.raw.headers, PAYMENT_SIGNATURE_HEADER);

    if (!signatureHeader) {
      return paymentRequired(c, listing, requirements, "PAYMENT-SIGNATURE header is required");
    }

    let payload: PaymentPayload;
    try {
      payload = decodeX402Header<PaymentPayload>(signatureHeader);
    } catch {
      return paymentRequired(c, listing, requirements, "PAYMENT-SIGNATURE is not valid base64 JSON");
    }

    const verify = await deps.facilitator.verify({
      x402Version: X402_VERSION,
      paymentPayload: payload,
      paymentRequirements: requirements,
    });
    if (!verify.isValid) {
      return paymentRequired(
        c,
        listing,
        requirements,
        verify.invalidReason ?? "payment verification failed",
      );
    }

    const payerId = walletIdFromSignature(payload.payload.signature);
    if (!payerId) {
      return paymentRequired(c, listing, requirements, "test facilitator requires test:<walletId>");
    }

    const payout = await deps.wallets.settleListingPayment({
      payerId,
      sellerAddress: listing.payTo,
      protocolAddress: deps.protocolTreasury.address,
      amountAtomic: parseAtomic(listing.price.amount),
    });

    const settlement = await deps.facilitator.settle({
      x402Version: X402_VERSION,
      paymentPayload: payload,
      paymentRequirements: requirements,
    });
    if (!settlement.success) {
      return paymentRequired(
        c,
        listing,
        requirements,
        settlement.errorReason ?? "payment settlement failed",
      );
    }

    const receipt = {
      id: newId("rct"),
      listingId: listing.id,
      payerWalletId: payout.payer.id,
      payerAddress: payout.payer.address,
      sellerAddress: listing.payTo,
      protocolAddress: deps.protocolTreasury.address,
      amountAtomic: listing.price.amount,
      sellerAtomic: payout.sellerAtomic.toString(),
      protocolAtomic: payout.protocolAtomic.toString(),
      transaction: settlement.transaction || payout.txHash,
      network: listing.price.network,
      createdAt: nowIso(),
    };
    await deps.store.putReceipt(receipt);

    const paymentResponse = encodeX402Header({
      success: true,
      transaction: receipt.transaction,
      network: receipt.network,
      payer: receipt.payerAddress,
      amount: receipt.amountAtomic,
    });

    c.header(PAYMENT_RESPONSE_HEADER, paymentResponse);
    return c.json({
      ok: true,
      listing: { id: listing.id, kind: listing.kind, title: listing.title },
      fulfillment: {
        status: "accepted",
        note:
          listing.kind === "desktop.linux"
            ? "Desktop SKU is priced here; a Berthos node fulfills the guest session."
            : "HTTP/MCP invoke is priced here; v1 does not proxy the upstream call.",
        endpoint: listing.endpoint,
        fulfillment: listing.fulfillment,
      },
      receipt,
    });
  });

  app.post("/wallets/treasury", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { label?: string };
    const wallet = await deps.wallets.createTreasury({ label: body.label });
    return c.json({ wallet }, 201);
  });

  app.post("/wallets/agent", async (c) => {
    const parsed = createAgentSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new WalletError(
        "invalid_agent",
        issue ? `${issue.path.join(".")}: ${issue.message}` : "invalid agent wallet",
      );
    }
    let treasuryId = parsed.data.treasuryId;
    if (!treasuryId) {
      const treasury = await deps.wallets.createTreasury({
        label: parsed.data.treasuryLabel ?? "agent-parent",
      });
      treasuryId = treasury.id;
    }
    const wallet = await deps.wallets.createAgent({
      treasuryId,
      spendCapAtomic: parseAtomic(parsed.data.spendCap),
      label: parsed.data.label,
    });
    return c.json({ wallet }, 201);
  });

  app.post("/wallets/:id/fund", async (c) => {
    const parsed = fundSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      throw new WalletError("invalid_amount", "amount must be atomic USDC");
    }
    const wallet = await deps.wallets.fund(c.req.param("id"), parseAtomic(parsed.data.amount));
    return c.json({ wallet });
  });

  app.get("/wallets/:id", async (c) => {
    const wallet = await deps.wallets.get(c.req.param("id"));
    if (!wallet) {
      return c.json({ error: { code: "not_found", message: "wallet not found" } }, 404);
    }
    return c.json({ wallet });
  });

  app.get("/receipts", async (c) => {
    const listingId = c.req.query("listingId");
    const receipts = await deps.store.listReceipts(listingId);
    return c.json({ receipts });
  });

  return app;
}

function quoteFor(listing: Listing): PaymentRequirements {
  return defaultUsdcRequirements({
    amountAtomic: listing.price.amount,
    payTo: listing.payTo,
    listingId: listing.id,
  });
}

function paymentRequired(
  c: Context,
  listing: Listing,
  requirements: PaymentRequirements,
  error: string,
) {
  const required: PaymentRequired = {
    x402Version: X402_VERSION,
    error,
    resource: {
      url: c.req.url,
      description: listing.description ?? listing.title,
      mimeType: "application/json",
      serviceName: "berth-market",
    },
    accepts: [requirements],
    extensions: {},
  };
  c.header(PAYMENT_REQUIRED_HEADER, encodeX402Header(required));
  return c.json(
    {
      error: { code: "payment_required", message: error },
      quote: required,
    },
    402,
  );
}
