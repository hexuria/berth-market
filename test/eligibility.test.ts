import { describe, expect, it } from "vitest";
import { MemoryEligibilityClient } from "../src/adapters/memory-eligibility.js";
import { HttpBerthosEligibilityClient } from "../src/adapters/http-eligibility.js";
import { bootMarket, desktopListing, requestJson } from "./helpers.js";

const PAY_TO = "0x2222222222222222222222222222222222222222";

describe("eligibility", () => {
  it("MemoryEligibilityClient fails closed without an attestation", async () => {
    const client = new MemoryEligibilityClient();
    const decision = await client.verify(undefined);
    expect(decision.ok).toBe(false);
    expect(decision.reason).toBe("missing_attestation");
  });

  it("MemoryEligibilityClient rejects laptop class even if ok=true", async () => {
    const client = new MemoryEligibilityClient();
    const decision = await client.verify({
      source: "berthos.doctor",
      ok: true,
      class: "laptop",
      attestedAt: "2026-08-23T07:00:00.000Z",
    });
    expect(decision.ok).toBe(false);
    expect(decision.reason).toContain("forbidden_class");
  });

  it("HttpBerthosEligibilityClient fails closed when the doctor is unreachable", async () => {
    const client = new HttpBerthosEligibilityClient("https://berthos.example", "/doctor", async () => {
      throw new Error("ECONNREFUSED");
    });
    const decision = await client.verify({
      source: "berthos.doctor",
      ok: true,
      class: "vm",
      attestedAt: "2026-08-23T07:00:00.000Z",
      berthosUrl: "https://berthos.example",
    });
    expect(decision.ok).toBe(false);
    expect(decision.reason).toMatch(/doctor_unreachable/);
  });

  it("rejects a desktop listing when the injected doctor says no", async () => {
    const { app, deps } = await bootMarket();
    deps.eligibility.verify = async () => ({ ok: false, reason: "doctor_not_ok" });

    const res = await requestJson(app, "POST", "/listings", desktopListing(PAY_TO));
    expect(res.status).toBe(400);
    expect((res.json.error as { code: string }).code).toBe("eligibility_failed");
  });
});
