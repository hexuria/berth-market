import { Hono, type Context } from "hono";
import { z } from "zod";
import { LeaseError, type LeaseRecord } from "../domain/lease.js";
import {
  assertAllowedClass,
  assertListingKind,
  isDesktopKind,
  parseCreateListing,
  publicListing,
  requireDesktopEligibility,
  type Listing,
} from "../domain/listing.js";
import {
  BASE_CAIP2,
  BASE_SEPOLIA_CAIP2,
  normalizeAddress,
  parseAtomic,
  splitProceeds,
} from "../domain/money.js";
import { WalletError, type Receipt } from "../domain/wallet.js";
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
import type { MarketConfig } from "../config.js";
import type { MarketDependencies } from "../deps.js";
import { corsMiddleware } from "./cors.js";
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

export function createRouter(deps: MarketDependencies, config: MarketConfig): Hono {
  const app = new Hono();

  app.use("*", corsMiddleware(config.corsOrigins));

  app.onError((error, c) => {
    const mapped = toErrorResponse(error);
    return c.json(mapped.body, mapped.status as 400);
  });

  app.get("/health", (c) =>
    c.json({
      ok: true,
      service: "berth-market",
      asset: "USDC",
      network: config.network,
      networks: [BASE_CAIP2, BASE_SEPOLIA_CAIP2],
      stagingNetwork: BASE_SEPOLIA_CAIP2,
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
        network: input.price.network,
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
    return c.json({ listing: publicListing(listing) }, 201);
  });

  app.get("/listings", async (c) => {
    const listings = await deps.store.listListings();
    return c.json({ listings: listings.map(publicListing) });
  });

  app.get("/listings/:id", async (c) => {
    const listing = await deps.store.getListing(c.req.param("id"));
    if (!listing) {
      return c.json({ error: { code: "not_found", message: "listing not found" } }, 404);
    }
    return c.json({ listing: publicListing(listing) });
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

    const testPayerId = walletIdFromSignature(payload.payload.signature);

    if (await deps.store.hasNonce(payload.payload.authorization.nonce)) {
      return paymentRequired(
        c,
        listing,
        requirements,
        "payment already settled (replayed nonce); no second charge and no new lease",
      );
    }

    let liveLease: LeaseRecord | undefined;
    try {
      if (listing.kind === "desktop.linux") {
        const prepared = await prepareDesktopLease(deps, listing);
        if (!prepared.ok) {
          return c.json(
            { error: { code: prepared.code, message: prepared.message } },
            prepared.status as 400,
          );
        }
        liveLease = prepared.lease;
      }

      const settlement = await deps.facilitator.settle({
        x402Version: X402_VERSION,
        paymentPayload: payload,
        paymentRequirements: requirements,
      });
      if (!settlement.success) {
        await abortLease(deps, listing, liveLease);
        return paymentRequired(
          c,
          listing,
          requirements,
          settlement.errorReason ?? "payment settlement failed",
        );
      }

      await deps.store.consumeNonce(payload.payload.authorization.nonce);

      const amountAtomic = parseAtomic(listing.price.amount);
      const { sellerAtomic, protocolAtomic } = splitProceeds(amountAtomic);

      let payerWalletId: string;
      let payerAddress: string;
      let transaction = settlement.transaction;
      let onChainSettlement: Receipt["onChainSettlement"] = "payTo_100";

      if (testPayerId) {
        const payout = await deps.wallets.settleListingPayment({
          payerId: testPayerId,
          sellerAddress: listing.payTo,
          protocolAddress: deps.protocolTreasury.address,
          amountAtomic,
        });
        payerWalletId = payout.payer.id;
        payerAddress = payout.payer.address;
        transaction = settlement.transaction || payout.txHash;
        onChainSettlement = payout.onChainSettlement;
      } else {
        // Public x402 facilitator: one payTo. On-chain USDC is 100% to
        // listing.payTo. 90/10 below is receipt accounting — not a second settle.
        const from =
          settlement.payer ?? verify.payer ?? payload.payload.authorization.from;
        if (!from) {
          await abortLease(deps, listing, liveLease);
          return paymentRequired(
            c,
            listing,
            requirements,
            "facilitator settle did not identify a payer",
          );
        }
        if (!transaction) {
          await abortLease(deps, listing, liveLease);
          return paymentRequired(
            c,
            listing,
            requirements,
            "facilitator settle returned no transaction hash",
          );
        }
        payerAddress = normalizeAddress(from);
        payerWalletId = `eoa:${payerAddress}`;
      }

      const receipt: Receipt = {
        id: newId("rct"),
        listingId: listing.id,
        payerWalletId,
        payerAddress,
        sellerAddress: listing.payTo,
        protocolAddress: deps.protocolTreasury.address,
        amountAtomic: listing.price.amount,
        sellerAtomic: sellerAtomic.toString(),
        protocolAtomic: protocolAtomic.toString(),
        transaction,
        network: listing.price.network,
        createdAt: nowIso(),
        onChainSettlement,
      };
      if (liveLease) {
        receipt.leaseId = liveLease.id;
        receipt.berthosUrl = liveLease.berthosUrl;
        receipt.leaseState = "live";
        receipt.occupancyUnit = "seconds";
      }
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
        fulfillment: fulfillmentBody(listing, liveLease),
        receipt,
      });
    } catch (error) {
      await abortLease(deps, listing, liveLease);
      throw error;
    }
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

  app.get("/receipts/:id", async (c) => {
    const receipt = await deps.store.getReceipt(c.req.param("id"));
    if (!receipt) {
      return c.json({ error: { code: "not_found", message: "receipt not found" } }, 404);
    }
    return c.json({ receipt });
  });

  app.post("/receipts/:id/end", async (c) => {
    const receipt = await deps.store.getReceipt(c.req.param("id"));
    if (!receipt) {
      return c.json({ error: { code: "not_found", message: "receipt not found" } }, 404);
    }
    if (!receipt.leaseId) {
      return c.json(
        { error: { code: "no_lease", message: "receipt has no Berthos lease to end" } },
        400,
      );
    }
    if (receipt.leaseState === "ended") {
      return c.json({
        ok: true,
        receipt,
        occupancy: occupancyFromReceipt(receipt),
        note: "lease already ended; occupancy is a receipt, not a second charge",
      });
    }

    const listing = await deps.store.getListing(receipt.listingId);
    const occupancy = await deps.leases.end({
      leaseId: receipt.leaseId,
      berthosUrl: receipt.berthosUrl ?? listing?.fulfillment?.berthosUrl,
      token: listing?.fulfillment?.leaseToken,
    });

    const updated: Receipt = {
      ...receipt,
      leaseState: "ended",
      occupancySeconds: occupancy.occupancySeconds,
      billedSeconds: occupancy.billedSeconds,
      occupancyMinSeconds: occupancy.minSeconds,
      occupancyUnit: "seconds",
    };
    await deps.store.putReceipt(updated);
    return c.json({
      ok: true,
      receipt: updated,
      occupancy: {
        seconds: occupancy.occupancySeconds,
        billedSeconds: occupancy.billedSeconds,
        minSeconds: occupancy.minSeconds,
        unit: "seconds" as const,
        chargedHere: false,
        note: occupancy.settlement.note,
      },
    });
  });

  return app;
}

function quoteFor(listing: Listing): PaymentRequirements {
  return defaultUsdcRequirements({
    amountAtomic: listing.price.amount,
    payTo: listing.payTo,
    listingId: listing.id,
    network: listing.price.network,
  });
}

async function prepareDesktopLease(
  deps: MarketDependencies,
  listing: Listing,
): Promise<
  | { ok: true; lease: LeaseRecord }
  | { ok: false; code: string; message: string; status: number }
> {
  assertAllowedClass(listing.class, "class");
  assertAllowedClass(listing.eligibility?.class, "eligibility.class");
  if (isDesktopKind(listing.kind) && !listing.eligibility) {
    return {
      ok: false,
      status: 400,
      code: "eligibility_required",
      message: "desktop listings fail closed without a Berthos GET /v1/eligibility attestation",
    };
  }
  const decision = await deps.eligibility.verify(listing.eligibility);
  if (!decision.ok) {
    const forbidden = decision.reason?.includes("forbidden_class");
    return {
      ok: false,
      status: 400,
      code: forbidden ? "forbidden_class" : "eligibility_failed",
      message: decision.reason ?? "desktop invoke failed Berthos doctor attestation",
    };
  }

  try {
    const lease = await deps.leases.create({
      os: "linux",
      berthosUrl: listing.fulfillment?.berthosUrl ?? listing.eligibility?.berthosUrl,
      token: listing.fulfillment?.leaseToken,
    });
    return { ok: true, lease };
  } catch (error) {
    if (error instanceof LeaseError) {
      return { ok: false, code: error.code, message: error.message, status: error.status };
    }
    const message = error instanceof Error ? error.message : "lease create failed";
    return { ok: false, status: 400, code: "lease_create_failed", message };
  }
}

async function abortLease(
  deps: MarketDependencies,
  listing: Listing,
  lease: LeaseRecord | undefined,
): Promise<void> {
  if (!lease) return;
  try {
    await deps.leases.end({
      leaseId: lease.id,
      berthosUrl: lease.berthosUrl ?? listing.fulfillment?.berthosUrl,
      token: listing.fulfillment?.leaseToken,
    });
  } catch {
    // Best-effort compensation: do not hide the original settle/wallet error.
  }
}

function fulfillmentBody(listing: Listing, lease: LeaseRecord | undefined) {
  if (listing.kind === "desktop.linux" && lease) {
    return {
      status: "leased",
      leaseId: lease.id,
      berthosUrl: lease.berthosUrl,
      os: lease.os,
      state: lease.state,
      occupancyUnit: "seconds" as const,
      note: "Isolated Linux guest is live on the Berthos node. End the lease to store occupancy seconds; they are not a second charge.",
    };
  }
  return {
    status: "accepted",
    note:
      listing.kind === "desktop.linux"
        ? "Desktop SKU is priced here; a Berthos node fulfills the guest session."
        : "HTTP/MCP invoke is priced here; v1 does not proxy the upstream call.",
    endpoint: listing.endpoint,
    fulfillment: listing.fulfillment
      ? {
          berthosUrl: listing.fulfillment.berthosUrl,
          sku: listing.fulfillment.sku,
          nodeId: listing.fulfillment.nodeId,
        }
      : undefined,
  };
}

function occupancyFromReceipt(receipt: Receipt) {
  return {
    seconds: receipt.occupancySeconds ?? 0,
    billedSeconds: receipt.billedSeconds ?? receipt.occupancySeconds ?? 0,
    minSeconds: receipt.occupancyMinSeconds,
    unit: "seconds" as const,
    chargedHere: false,
    note: "v1 is pay-then-occupy. Occupancy seconds are a receipt, not a second x402 charge.",
  };
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
