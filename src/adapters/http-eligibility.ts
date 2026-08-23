import {
  decideEligibility,
  isStaleAttestation,
  type BerthosEligibilityReport,
  type DoctorCheck,
  type EligibilityAttestation,
  type EligibilityDecision,
  type GuestImage,
} from "../domain/eligibility.js";
import type { EligibilityClient } from "../ports/eligibility.js";

export const BERTHOS_ELIGIBILITY_PATH = "/v1/eligibility";

export interface HttpBerthosEligibilityClientOptions {
  /** Default node URL. Overridden per listing by `attestation.berthosUrl`. */
  berthosUrl?: string;
  /** Berthos path. Always `GET /v1/eligibility` unless overridden in tests. */
  eligibilityPath?: string;
  fetchImpl?: typeof fetch;
  maxAgeMs?: number;
  now?: () => number;
}

/**
 * Calls a Berthos node `GET /v1/eligibility`.
 *
 * Fail-closed when the node is unreachable, `ok`/`eligible` is false,
 * `class` is laptop / host-desktop, the stored attestation is stale or
 * missing, a required doctor check failed, or guest image labels are
 * stale / missing.
 *
 * Expected live body (Berthos `DoctorReport`, plus optional market fields):
 * `{ "ok"|"eligible", "class", "checks": [...], "guest_image"|"labels" }`.
 */
export class HttpBerthosEligibilityClient implements EligibilityClient {
  private readonly berthosUrl?: string;
  private readonly eligibilityPath: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxAgeMs?: number;
  private readonly now: () => number;

  constructor(
    berthosUrl?: string | HttpBerthosEligibilityClientOptions,
    eligibilityPath = BERTHOS_ELIGIBILITY_PATH,
    fetchImpl: typeof fetch = fetch,
  ) {
    if (typeof berthosUrl === "object" && berthosUrl !== null) {
      this.berthosUrl = berthosUrl.berthosUrl;
      this.eligibilityPath = berthosUrl.eligibilityPath ?? BERTHOS_ELIGIBILITY_PATH;
      this.fetchImpl = berthosUrl.fetchImpl ?? fetch;
      this.maxAgeMs = berthosUrl.maxAgeMs;
      this.now = berthosUrl.now ?? Date.now;
      return;
    }
    this.berthosUrl = berthosUrl;
    this.eligibilityPath = eligibilityPath;
    this.fetchImpl = fetchImpl;
    this.now = Date.now;
  }

  async verify(attestation: EligibilityAttestation | undefined): Promise<EligibilityDecision> {
    if (!attestation) {
      return { ok: false, reason: "missing_attestation" };
    }
    if (isStaleAttestation(attestation.attestedAt, this.now(), this.maxAgeMs)) {
      return { ok: false, reason: "stale_attestation", attestation };
    }
    if (attestation.ok === false) {
      return { ok: false, reason: "doctor_not_ok", attestation };
    }

    const base = attestation.berthosUrl ?? this.berthosUrl;
    if (!base) {
      return { ok: false, reason: "missing_berthos_url" };
    }

    const url = new URL(this.eligibilityPath, base.endsWith("/") ? base : `${base}/`);
    let response: Response;
    try {
      response = await this.fetchImpl(url, { method: "GET" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "network_error";
      return { ok: false, reason: `node_unreachable:${message}`, attestation };
    }
    if (!response.ok) {
      return { ok: false, reason: `eligibility_http_${response.status}`, attestation };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { ok: false, reason: "eligibility_invalid_json", attestation };
    }

    const report = parseEligibilityReport(body);
    if (!report) {
      return { ok: false, reason: "eligibility_invalid_body", attestation };
    }

    const decision = decideEligibility(
      {
        ...report,
        attestedAt: report.attestedAt ?? new Date(this.now()).toISOString(),
        berthosUrl: base,
        nodeId: report.nodeId ?? attestation.nodeId,
      },
      { nowMs: this.now(), maxAgeMs: this.maxAgeMs, requireImageLabels: true },
    );
    if (decision.attestation) {
      decision.attestation.berthosUrl = base;
      if (attestation.nodeId && !decision.attestation.nodeId) {
        decision.attestation.nodeId = attestation.nodeId;
      }
      if (attestation.digest && !decision.attestation.digest) {
        decision.attestation.digest = attestation.digest;
      }
    }
    return decision;
  }
}

function parseEligibilityReport(body: unknown): BerthosEligibilityReport | undefined {
  if (!body || typeof body !== "object") return undefined;
  const raw = body as Record<string, unknown>;
  const checks = parseChecks(raw.checks);
  const guestImage = parseGuestImage(raw.guest_image) ?? parseGuestImage(raw.image);
  const labels =
    raw.labels && typeof raw.labels === "object" && !Array.isArray(raw.labels)
      ? (raw.labels as Record<string, string>)
      : undefined;
  return {
    protocol: asString(raw.protocol),
    intent: asString(raw.intent),
    eligible: asBoolean(raw.eligible),
    ok: asBoolean(raw.ok),
    class: asString(raw.class),
    checks,
    guest_image: guestImage,
    image: parseGuestImage(raw.image),
    labels,
    attestedAt: asString(raw.attestedAt),
    nodeId: asString(raw.nodeId),
  };
}

function parseChecks(value: unknown): DoctorCheck[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const checks: DoctorCheck[] = [];
  for (const row of value) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    const id = asString(rec.id);
    const status = asString(rec.status);
    if (!id || (status !== "pass" && status !== "fail" && status !== "warn")) continue;
    checks.push({ id, status, detail: asString(rec.detail) ?? "" });
  }
  return checks;
}

function parseGuestImage(value: unknown): GuestImage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const rec = value as Record<string, unknown>;
  const labels =
    rec.labels && typeof rec.labels === "object" && !Array.isArray(rec.labels)
      ? (rec.labels as Record<string, string>)
      : undefined;
  return {
    name: asString(rec.name),
    version_label: asString(rec.version_label),
    desktop_label: asString(rec.desktop_label),
    egress_label: asString(rec.egress_label),
    labels,
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
