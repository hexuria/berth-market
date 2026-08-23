import {
  decideEligibility,
  type EligibilityAttestation,
  type EligibilityDecision,
} from "../domain/eligibility.js";
import type { EligibilityClient } from "../ports/eligibility.js";

/**
 * In-memory / test EligibilityClient.
 *
 * Fail-closed: missing attestation, stale `attestedAt`, ok=false, or a
 * forbidden class (laptop / host-desktop) → reject. Does not invent a
 * doctor pass when the caller omitted eligibility. Does not require
 * live image labels — those are checked by `HttpBerthosEligibilityClient`.
 */
export class MemoryEligibilityClient implements EligibilityClient {
  constructor(
    private readonly options: { nowMs?: number; maxAgeMs?: number } = {},
  ) {}

  async verify(attestation: EligibilityAttestation | undefined): Promise<EligibilityDecision> {
    return decideEligibility(attestation, {
      nowMs: this.options.nowMs,
      maxAgeMs: this.options.maxAgeMs,
      requireImageLabels: false,
    });
  }
}
