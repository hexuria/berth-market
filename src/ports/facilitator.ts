import type {
  FacilitatorSettleRequest,
  FacilitatorVerifyRequest,
  SettlementResponse,
  VerifyResponse,
} from "../domain/x402.js";

/**
 * x402 facilitator: POST /verify (read-only) then POST /settle.
 * Tests use `TestFacilitator` (default). A live facilitator is
 * `LiveFacilitator` behind `FACILITATOR_URL` — tests must mock fetch.
 */
export interface FacilitatorPort {
  verify(request: FacilitatorVerifyRequest): Promise<VerifyResponse>;
  settle(request: FacilitatorSettleRequest): Promise<SettlementResponse>;
}
