import type { EligibilityAttestation, EligibilityDecision } from "../domain/eligibility.js";
import { FORBIDDEN_CLASSES, isEligibleClass } from "../domain/eligibility.js";
import type { EligibilityClient } from "../ports/eligibility.js";

/**
 * Calls a Berthos node doctor. Fail-closed on network errors, non-OK HTTP,
 * missing body, or a class the market refuses (laptop / host-desktop).
 *
 * Expected doctor response (this market only stores the result):
 * `{ "ok": true, "class": "vm", "nodeId": "...", "attestedAt": "...", "digest": "..." }`
 */
export class HttpBerthosEligibilityClient implements EligibilityClient {
  constructor(
    private readonly berthosUrl: string,
    private readonly doctorPath = "/doctor",
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async verify(attestation: EligibilityAttestation | undefined): Promise<EligibilityDecision> {
    if (!attestation) {
      return { ok: false, reason: "missing_attestation" };
    }
    const base = attestation.berthosUrl ?? this.berthosUrl;
    if (!base) {
      return { ok: false, reason: "missing_berthos_url" };
    }
    const url = new URL(this.doctorPath, base.endsWith("/") ? base : `${base}/`);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(attestation),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "network_error";
      return { ok: false, reason: `doctor_unreachable:${message}` };
    }
    if (!response.ok) {
      return { ok: false, reason: `doctor_http_${response.status}` };
    }
    let body: Partial<EligibilityAttestation>;
    try {
      body = (await response.json()) as Partial<EligibilityAttestation>;
    } catch {
      return { ok: false, reason: "doctor_invalid_json" };
    }
    if (body.ok !== true) {
      return { ok: false, reason: "doctor_not_ok" };
    }
    if (!body.class || FORBIDDEN_CLASSES.has(body.class)) {
      return { ok: false, reason: `forbidden_class:${body.class ?? "missing"}` };
    }
    if (!isEligibleClass(body.class)) {
      return { ok: false, reason: `unknown_class:${body.class}` };
    }
    return {
      ok: true,
      attestation: {
        source: "berthos.doctor",
        ok: true,
        class: body.class,
        nodeId: body.nodeId ?? attestation.nodeId,
        attestedAt: body.attestedAt ?? new Date().toISOString(),
        digest: body.digest ?? attestation.digest,
        berthosUrl: base,
      },
    };
  }
}
