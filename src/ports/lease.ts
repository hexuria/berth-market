import type { CreateLeaseInput, EndLeaseInput, LeaseRecord, OccupancyReceipt } from "../domain/lease.js";

/**
 * Berthos lease port. This repo never starts Docker or a hypervisor; it
 * asks a node to `POST /v1/leases` (isolated Linux guest) and
 * `DELETE /v1/leases/{id}` (destroy + occupancy receipt).
 *
 * Fail-closed: unreachable node, ineligible doctor, `class=laptop`,
 * missing token, or a second live lease (409) must not settle payment.
 *
 * Tests use `MemoryLeaseClient`. `HttpBerthosLeaseClient` is selected
 * when `BERTHOS_URL` is set (same pattern as eligibility).
 */
export interface LeaseClient {
  create(input: CreateLeaseInput): Promise<LeaseRecord>;
  end(input: EndLeaseInput): Promise<OccupancyReceipt>;
}
