/**
 * Compatibility re-export. The live x402 adapter is `LiveFacilitator`
 * (`FACILITATOR_URL`). Tests keep using `TestFacilitator`.
 */
export {
  FACILITATOR_URL_ENV,
  HttpFacilitator,
  LiveFacilitator,
  createFacilitator,
  shouldUseLiveFacilitator,
} from "./live-facilitator.js";
