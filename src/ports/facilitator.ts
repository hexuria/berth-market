import type {
  FacilitatorSettleRequest,
  FacilitatorVerifyRequest,
  SettlementResponse,
  VerifyResponse,
} from "../domain/x402.js";

/**
 * x402 facilitator: POST /verify (read-only) then POST /settle.
 * Tests use `TestFacilitator`. Production should wrap a live x402 facilitator
 * (Coinbase / x402.org) — see adapters/http-facilitator.ts.
 */
export interface FacilitatorPort {
  verify(request: FacilitatorVerifyRequest): Promise<VerifyResponse>;
  settle(request: FacilitatorSettleRequest): Promise<SettlementResponse>;
}
