import { z } from "zod";

/**
 * Classes a Berthos doctor may attest.
 *
 * Berthos wire values are `vm-guest` and `dedicated-server`.
 * `vm` / `server` / `guest` are market aliases accepted on stored listings.
 * Laptop and host-desktop are never eligible.
 */
export const ELIGIBLE_CLASSES = [
  "vm-guest",
  "dedicated-server",
  "vm",
  "server",
  "guest",
] as const;
export type EligibleClass = (typeof ELIGIBLE_CLASSES)[number];

export const FORBIDDEN_CLASSES = new Set([
  "laptop",
  "host-desktop",
  "host_desktop",
  "hostdesktop",
]);

/** Guest image labels the Berthos doctor requires (`berthos-linux-desktop:v1`). */
export const REQUIRED_GUEST_IMAGE = "berthos-linux-desktop:v1";
export const REQUIRED_GUEST_VERSION = "v1";
export const REQUIRED_DESKTOP_LABEL = "xvfb-openbox-chromium";
export const REQUIRED_EGRESS_POLICY = "default-deny";
export const REQUIRED_IMAGE_LABELS = {
  "berthos.guest.version": REQUIRED_GUEST_VERSION,
  "berthos.desktop": REQUIRED_DESKTOP_LABEL,
  "berthos.egress.policy": REQUIRED_EGRESS_POLICY,
} as const;

/** Stored doctor reports older than this are stale. Default 24h. */
export const DEFAULT_ATTESTATION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export const doctorCheckSchema = z
  .object({
    id: z.string().min(1),
    status: z.enum(["pass", "fail", "warn"]),
    detail: z.string(),
  })
  .strict();

export type DoctorCheck = z.infer<typeof doctorCheckSchema>;

export const guestImageSchema = z
  .object({
    name: z.string().min(1).optional(),
    version_label: z.string().optional(),
    desktop_label: z.string().optional(),
    egress_label: z.string().optional(),
    labels: z.record(z.string()).optional(),
  })
  .strict();

export type GuestImage = z.infer<typeof guestImageSchema>;

export const eligibilityAttestationSchema = z
  .object({
    source: z.literal("berthos.doctor").default("berthos.doctor"),
    ok: z.boolean(),
    class: z.string().min(1),
    nodeId: z.string().min(1).optional(),
    attestedAt: z.string().min(1),
    digest: z.string().min(1).optional(),
    berthosUrl: z.string().url().optional(),
    protocol: z.string().min(1).optional(),
    intent: z.string().min(1).optional(),
    checks: z.array(doctorCheckSchema).optional(),
    guest_image: guestImageSchema.optional(),
    image: guestImageSchema.optional(),
    labels: z.record(z.string()).optional(),
  })
  .strict();

export type EligibilityAttestation = z.infer<typeof eligibilityAttestationSchema>;

export interface EligibilityDecision {
  ok: boolean;
  reason?: string;
  attestation?: EligibilityAttestation;
}

/**
 * Live `GET /v1/eligibility` body from a Berthos node (`DoctorReport`),
 * plus optional market fields (`ok`, `class`, image labels).
 */
export interface BerthosEligibilityReport {
  protocol?: string;
  intent?: string;
  eligible?: boolean;
  ok?: boolean;
  class?: string;
  checks?: DoctorCheck[];
  guest_image?: GuestImage;
  image?: GuestImage;
  labels?: Record<string, string>;
  attestedAt?: string;
  nodeId?: string;
  berthosUrl?: string;
  digest?: string;
}

export function isForbiddenClass(value: string | undefined): boolean {
  if (!value) return false;
  return FORBIDDEN_CLASSES.has(value);
}

export function isEligibleClass(value: string): value is EligibleClass {
  return (ELIGIBLE_CLASSES as readonly string[]).includes(value);
}

export function isStaleAttestation(
  attestedAt: string | undefined,
  nowMs = Date.now(),
  maxAgeMs = DEFAULT_ATTESTATION_MAX_AGE_MS,
): boolean {
  if (!attestedAt) return true;
  const parsed = Date.parse(attestedAt);
  if (Number.isNaN(parsed)) return true;
  if (parsed > nowMs + 60_000) return true;
  return nowMs - parsed > maxAgeMs;
}

export function reportIsOk(report: BerthosEligibilityReport): boolean {
  if (typeof report.ok === "boolean") return report.ok;
  if (typeof report.eligible === "boolean") return report.eligible;
  return false;
}

export function classFromReport(report: BerthosEligibilityReport): string | undefined {
  if (report.class) return report.class;
  const row = report.checks?.find((check) => check.id === "class");
  const match = row?.detail.match(/class=([A-Za-z0-9_-]+)/);
  return match?.[1];
}

export function collectImageLabels(report: BerthosEligibilityReport): Record<string, string> | undefined {
  if (report.labels && Object.keys(report.labels).length > 0) {
    return report.labels;
  }
  const image = report.guest_image ?? report.image;
  if (!image) return undefined;
  const fromFields: Record<string, string> = {};
  if (image.version_label) fromFields["berthos.guest.version"] = image.version_label;
  if (image.desktop_label) fromFields["berthos.desktop"] = image.desktop_label;
  if (image.egress_label) fromFields["berthos.egress.policy"] = image.egress_label;
  if (image.labels) Object.assign(fromFields, image.labels);
  return Object.keys(fromFields).length > 0 ? fromFields : undefined;
}

export function imageLabelsMissingOrStale(report: BerthosEligibilityReport): string | undefined {
  const labels = collectImageLabels(report);
  if (labels) {
    for (const [key, expected] of Object.entries(REQUIRED_IMAGE_LABELS)) {
      if (labels[key] !== expected) {
        return `stale_image_labels:${key}`;
      }
    }
    return undefined;
  }
  const guestCheck = report.checks?.find((check) => check.id === "guest_image");
  if (!guestCheck) return "missing_image_labels";
  if (guestCheck.status === "fail") return "stale_image_labels:guest_image";
  if (guestCheck.status === "pass") return undefined;
  return "missing_image_labels";
}

export function failedRequiredCheck(report: BerthosEligibilityReport): string | undefined {
  const failed = report.checks?.find((check) => check.status === "fail");
  return failed ? `check_failed:${failed.id}` : undefined;
}

/**
 * Fail-closed decision from a stored attestation or a live Berthos report.
 * Does not invent a pass when `ok`/`eligible`, class, checks, or labels are missing.
 */
export function decideEligibility(
  input: EligibilityAttestation | BerthosEligibilityReport | undefined,
  options: { nowMs?: number; maxAgeMs?: number; requireImageLabels?: boolean } = {},
): EligibilityDecision {
  if (!input) {
    return { ok: false, reason: "missing_attestation" };
  }
  const requireImageLabels = options.requireImageLabels ?? false;
  const ok = "ok" in input && typeof input.ok === "boolean" ? input.ok : reportIsOk(input);
  const cls = "class" in input && typeof input.class === "string" ? input.class : classFromReport(input);
  const attestedAt = "attestedAt" in input ? input.attestedAt : undefined;

  if (isStaleAttestation(attestedAt, options.nowMs, options.maxAgeMs)) {
    return { ok: false, reason: "stale_attestation", attestation: asStored(input, ok, cls) };
  }
  if (!ok) {
    return { ok: false, reason: "doctor_not_ok", attestation: asStored(input, false, cls) };
  }
  if (!cls) {
    return { ok: false, reason: "missing_class", attestation: asStored(input, ok, cls) };
  }
  if (isForbiddenClass(cls)) {
    return { ok: false, reason: `forbidden_class:${cls}`, attestation: asStored(input, ok, cls) };
  }
  if (!isEligibleClass(cls)) {
    return { ok: false, reason: `unknown_class:${cls}`, attestation: asStored(input, ok, cls) };
  }
  const failed = failedRequiredCheck(input);
  if (failed) {
    return { ok: false, reason: failed, attestation: asStored(input, false, cls) };
  }
  if (requireImageLabels) {
    const labelsReason = imageLabelsMissingOrStale(input);
    if (labelsReason) {
      return { ok: false, reason: labelsReason, attestation: asStored(input, false, cls) };
    }
  }

  const attestation = asStored(input, true, cls);
  return attestation ? { ok: true, attestation } : { ok: false, reason: "missing_attestation" };
}

function asStored(
  input: EligibilityAttestation | BerthosEligibilityReport,
  ok: boolean,
  cls: string | undefined,
): EligibilityAttestation | undefined {
  if (!cls) return undefined;
  const attestedAt =
    ("attestedAt" in input && input.attestedAt) ||
    (ok ? new Date().toISOString() : undefined);
  if (!attestedAt) return undefined;
  const stored: EligibilityAttestation = {
    source: "berthos.doctor",
    ok,
    class: cls,
    attestedAt,
  };
  if ("nodeId" in input && input.nodeId) stored.nodeId = input.nodeId;
  if ("digest" in input && input.digest) stored.digest = input.digest;
  if ("berthosUrl" in input && input.berthosUrl) stored.berthosUrl = input.berthosUrl;
  if (input.protocol) stored.protocol = input.protocol;
  if (input.intent) stored.intent = input.intent;
  if (input.checks) stored.checks = input.checks;
  if (input.guest_image) stored.guest_image = input.guest_image;
  if (input.image) stored.image = input.image;
  if (input.labels) stored.labels = input.labels;
  return stored;
}
