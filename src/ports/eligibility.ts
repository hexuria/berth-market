import type { EligibilityAttestation, EligibilityDecision } from "../domain/eligibility.js";

/**
 * Berthos doctor client. This repo never runs isolation; it only stores
 * (and optionally re-checks) the attestation result.
 *
 * Fail-closed: missing, expired, or unreachable doctor → ineligible.
 */
export interface EligibilityClient {
  verify(attestation: EligibilityAttestation | undefined): Promise<EligibilityDecision>;
}
