import {
  FORBIDDEN_CLASSES,
  isEligibleClass,
  type EligibilityAttestation,
  type EligibilityDecision,
} from "../domain/eligibility.js";
import type { EligibilityClient } from "../ports/eligibility.js";

/**
 * In-memory / test EligibilityClient.
 * Fail-closed: missing attestation, ok=false, or forbidden class → reject.
 * Does not invent a doctor pass when the caller omitted eligibility.
 */
export class MemoryEligibilityClient implements EligibilityClient {
  async verify(attestation: EligibilityAttestation | undefined): Promise<EligibilityDecision> {
    if (!attestation) {
      return { ok: false, reason: "missing_attestation" };
    }
    if (!attestation.ok) {
      return { ok: false, reason: "doctor_not_ok", attestation };
    }
    if (FORBIDDEN_CLASSES.has(attestation.class)) {
      return { ok: false, reason: `forbidden_class:${attestation.class}`, attestation };
    }
    if (!isEligibleClass(attestation.class)) {
      return { ok: false, reason: `unknown_class:${attestation.class}`, attestation };
    }
    return { ok: true, attestation };
  }
}
