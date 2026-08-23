import { describe, expect, it } from "vitest";
import { MemoryEligibilityClient } from "../src/adapters/memory-eligibility.js";
import {
  BERTHOS_ELIGIBILITY_PATH,
  HttpBerthosEligibilityClient,
} from "../src/adapters/http-eligibility.js";
import { createApp } from "../src/app.js";
import type { BerthosEligibilityReport, DoctorCheck } from "../src/domain/eligibility.js";
import { bootMarket, desktopListing, requestJson } from "./helpers.js";

const PAY_TO = "0x2222222222222222222222222222222222222222";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requiredChecks(overrides: Partial<Record<string, DoctorCheck>> = {}): DoctorCheck[] {
  const base: DoctorCheck[] = [
    { id: "class", status: "pass", detail: "class=vm-guest (isolated guest, not the host desktop)" },
    { id: "bind", status: "pass", detail: "loopback bind only (127.0.0.1:7432)" },
    { id: "runtime", status: "pass", detail: "Docker (or equivalent) is running" },
    {
      id: "guest_image",
      status: "pass",
      detail: "berthos-linux-desktop:v1 labels ok (v1, xvfb-openbox-chromium, default-deny)",
    },
    { id: "egress", status: "pass", detail: "default-deny egress" },
    { id: "capacity", status: "pass", detail: "2 vCPU and 4 GiB free" },
    { id: "guest_os", status: "pass", detail: "guest OS is Linux (v1 SKU)" },
    { id: "chassis", status: "pass", detail: "chassis is a dedicated host" },
    { id: "availability", status: "pass", detail: "private loopback does not require wired/always-on" },
    { id: "tunnel", status: "warn", detail: "no tunnel configured" },
  ];
  return base.map((row) => overrides[row.id] ?? row);
}

/** Native Berthos GET /v1/eligibility DoctorReport, plus optional market fields. */
export function berthosEligibleReport(
  overrides: Partial<BerthosEligibilityReport> = {},
): BerthosEligibilityReport {
  return {
    protocol: "v1",
    intent: "private",
    eligible: true,
    ok: true,
    class: "vm-guest",
    checks: requiredChecks(),
    guest_image: {
      name: "berthos-linux-desktop:v1",
      version_label: "v1",
      desktop_label: "xvfb-openbox-chromium",
      egress_label: "default-deny",
    },
    labels: {
      "berthos.guest.version": "v1",
      "berthos.desktop": "xvfb-openbox-chromium",
      "berthos.egress.policy": "default-deny",
    },
    ...overrides,
  };
}

function freshAttestation() {
  return {
    source: "berthos.doctor" as const,
    ok: true,
    class: "vm",
    attestedAt: new Date().toISOString(),
    berthosUrl: "https://berthos.example",
    nodeId: "node_01",
  };
}

function mockEligibilityFetch(handler: (url: string) => Response | Promise<Response>): typeof fetch {
  return async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return handler(url);
  };
}

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
      attestedAt: new Date().toISOString(),
    });
    expect(decision.ok).toBe(false);
    expect(decision.reason).toContain("forbidden_class");
  });

  it("MemoryEligibilityClient rejects a stale attestation", async () => {
    const client = new MemoryEligibilityClient();
    const decision = await client.verify({
      source: "berthos.doctor",
      ok: true,
      class: "vm",
      attestedAt: "2020-01-01T00:00:00.000Z",
    });
    expect(decision.ok).toBe(false);
    expect(decision.reason).toBe("stale_attestation");
  });

  it("HttpBerthosEligibilityClient GETs /v1/eligibility and accepts the doctor shape", async () => {
    const seen: string[] = [];
    const client = new HttpBerthosEligibilityClient({
      berthosUrl: "https://berthos.example",
      fetchImpl: mockEligibilityFetch((url) => {
        seen.push(url);
        return jsonResponse(berthosEligibleReport());
      }),
    });
    const decision = await client.verify(freshAttestation());
    expect(seen).toEqual(["https://berthos.example/v1/eligibility"]);
    expect(decision.ok).toBe(true);
    expect(decision.attestation?.class).toBe("vm-guest");
    expect(decision.attestation?.ok).toBe(true);
    expect(decision.attestation?.checks?.some((c) => c.id === "guest_image" && c.status === "pass")).toBe(
      true,
    );
    expect(decision.attestation?.labels?.["berthos.desktop"]).toBe("xvfb-openbox-chromium");
  });

  it("HttpBerthosEligibilityClient accepts a native DoctorReport without market `ok`/`class`", async () => {
    const client = new HttpBerthosEligibilityClient(
      "https://berthos.example",
      BERTHOS_ELIGIBILITY_PATH,
      async () =>
        jsonResponse({
          protocol: "v1",
          intent: "private",
          eligible: true,
          checks: requiredChecks(),
        }),
    );
    const decision = await client.verify(freshAttestation());
    expect(decision.ok).toBe(true);
    expect(decision.attestation?.class).toBe("vm-guest");
  });

  it("HttpBerthosEligibilityClient fails closed when the node is unreachable", async () => {
    const client = new HttpBerthosEligibilityClient("https://berthos.example", "/v1/eligibility", async () => {
      throw new Error("ECONNREFUSED");
    });
    const decision = await client.verify(freshAttestation());
    expect(decision.ok).toBe(false);
    expect(decision.reason).toMatch(/node_unreachable/);
  });

  it("HttpBerthosEligibilityClient fails closed when ok/eligible is false", async () => {
    const client = new HttpBerthosEligibilityClient({
      berthosUrl: "https://berthos.example",
      fetchImpl: async () => jsonResponse(berthosEligibleReport({ eligible: false, ok: false })),
    });
    const decision = await client.verify(freshAttestation());
    expect(decision.ok).toBe(false);
    expect(decision.reason).toBe("doctor_not_ok");
  });

  it("HttpBerthosEligibilityClient fails closed when the live class is laptop", async () => {
    const client = new HttpBerthosEligibilityClient({
      berthosUrl: "https://berthos.example",
      fetchImpl: async () =>
        jsonResponse(
          berthosEligibleReport({
            class: "laptop",
            eligible: false,
            ok: false,
            checks: requiredChecks({
              class: {
                id: "class",
                status: "fail",
                detail: "class=laptop is rejected; only a VM guest or a dedicated server guest may be leased",
              },
            }),
          }),
        ),
    });
    const decision = await client.verify(freshAttestation());
    expect(decision.ok).toBe(false);
    expect(decision.reason).toMatch(/forbidden_class:laptop|check_failed:class|doctor_not_ok/);
  });

  it("HttpBerthosEligibilityClient fails closed when image labels are stale or missing", async () => {
    const missing = new HttpBerthosEligibilityClient({
      berthosUrl: "https://berthos.example",
      fetchImpl: async () =>
        jsonResponse({
          ok: true,
          eligible: true,
          class: "vm-guest",
          checks: requiredChecks().filter((c) => c.id !== "guest_image"),
        }),
    });
    expect((await missing.verify(freshAttestation())).reason).toBe("missing_image_labels");

    const stale = new HttpBerthosEligibilityClient({
      berthosUrl: "https://berthos.example",
      fetchImpl: async () =>
        jsonResponse(
          berthosEligibleReport({
            labels: {
              "berthos.guest.version": "v0",
              "berthos.desktop": "old-desktop",
              "berthos.egress.policy": "default-allow",
            },
            guest_image: {
              name: "old-desktop:dev",
              version_label: "v0",
              desktop_label: "old-desktop",
              egress_label: "default-allow",
            },
          }),
        ),
    });
    expect((await stale.verify(freshAttestation())).ok).toBe(false);
    expect((await stale.verify(freshAttestation())).reason).toMatch(/stale_image_labels/);
  });

  it("HttpBerthosEligibilityClient fails closed when the stored attestation is stale", async () => {
    let fetched = false;
    const client = new HttpBerthosEligibilityClient({
      berthosUrl: "https://berthos.example",
      fetchImpl: async () => {
        fetched = true;
        return jsonResponse(berthosEligibleReport());
      },
    });
    const decision = await client.verify({
      ...freshAttestation(),
      attestedAt: "2020-01-01T00:00:00.000Z",
    });
    expect(decision.ok).toBe(false);
    expect(decision.reason).toBe("stale_attestation");
    expect(fetched).toBe(false);
  });

  it("HttpBerthosEligibilityClient fails closed when the attestation is missing", async () => {
    const client = new HttpBerthosEligibilityClient({
      berthosUrl: "https://berthos.example",
      fetchImpl: async () => {
        throw new Error("should not fetch");
      },
    });
    const decision = await client.verify(undefined);
    expect(decision.ok).toBe(false);
    expect(decision.reason).toBe("missing_attestation");
  });

  it("rejects a desktop listing when the injected doctor says no", async () => {
    const { app, deps } = await bootMarket();
    deps.eligibility.verify = async () => ({ ok: false, reason: "doctor_not_ok" });

    const res = await requestJson(app, "POST", "/listings", desktopListing(PAY_TO));
    expect(res.status).toBe(400);
    expect((res.json.error as { code: string }).code).toBe("eligibility_failed");
  });

  it("desktop listing fails closed when the mocked Berthos node is unreachable", async () => {
    const { app } = await createApp({
      eligibility: new HttpBerthosEligibilityClient({
        berthosUrl: "https://berthos.example",
        fetchImpl: async () => {
          throw new Error("ECONNREFUSED");
        },
      }),
    });
    const res = await requestJson(app, "POST", "/listings", desktopListing(PAY_TO));
    expect(res.status).toBe(400);
    expect((res.json.error as { code: string }).code).toBe("eligibility_failed");
    expect((res.json.error as { message: string }).message).toMatch(/node_unreachable/);
  });

  it("accepts a desktop listing when mocked GET /v1/eligibility is eligible", async () => {
    const { app } = await createApp({
      eligibility: new HttpBerthosEligibilityClient({
        berthosUrl: "https://berthos.example",
        fetchImpl: async () => jsonResponse(berthosEligibleReport()),
      }),
    });
    const res = await requestJson(app, "POST", "/listings", desktopListing(PAY_TO));
    expect(res.status).toBe(201);
    const listing = res.json.listing as { eligibility?: { ok: boolean; class: string } };
    expect(listing.eligibility?.ok).toBe(true);
    expect(listing.eligibility?.class).toBe("vm-guest");
  });
});
