import { z } from "zod";

/**
 * Classes a Berthos doctor may attest. Laptop and host-desktop are never eligible.
 * This market stores the attestation; it does not run isolation itself.
 */
export const ELIGIBLE_CLASSES = ["vm", "server", "guest"] as const;
export type EligibleClass = (typeof ELIGIBLE_CLASSES)[number];

export const FORBIDDEN_CLASSES = new Set([
  "laptop",
  "host-desktop",
  "host_desktop",
  "hostdesktop",
]);

export const eligibilityAttestationSchema = z
  .object({
    source: z.literal("berthos.doctor").default("berthos.doctor"),
    ok: z.boolean(),
    class: z.string().min(1),
    nodeId: z.string().min(1).optional(),
    attestedAt: z.string().min(1),
    digest: z.string().min(1).optional(),
    berthosUrl: z.string().url().optional(),
  })
  .strict();

export type EligibilityAttestation = z.infer<typeof eligibilityAttestationSchema>;

export interface EligibilityDecision {
  ok: boolean;
  reason?: string;
  attestation?: EligibilityAttestation;
}

export function isForbiddenClass(value: string | undefined): boolean {
  if (!value) return false;
  return FORBIDDEN_CLASSES.has(value);
}

export function isEligibleClass(value: string): value is EligibleClass {
  return (ELIGIBLE_CLASSES as readonly string[]).includes(value);
}
