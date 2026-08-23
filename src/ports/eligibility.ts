import type { EligibilityAttestation, EligibilityDecision } from "../domain/eligibility.js";

/**
 * Berthos eligibility client. This repo never runs isolation; it only stores
 * (and optionally re-checks) `GET /v1/eligibility`.
 *
 * Fail-closed: missing, stale, `ok=false`, `class=laptop`, unreachable node,
 * or stale/missing guest image labels → ineligible.
 */
export interface EligibilityClient {
  verify(attestation: EligibilityAttestation | undefined): Promise<EligibilityDecision>;
}
