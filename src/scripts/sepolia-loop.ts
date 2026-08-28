/**
 * Opt-in Base Sepolia (eip155:84532) x402 settle for HTTP, MCP, and desktop.linux.
 * Desktop is in-process MemoryEligibility/MemoryLease (no BERTHOS_URL).
 * Skips with exit 0 when STAGING_PAYER_PRIVATE_KEY + STAGING_PAY_TO are unset.
 * Never talks to Base mainnet. Run: `npm run sepolia-loop`
 */
import { runSepoliaLoop } from "../staging/loop.js";

const result = await runSepoliaLoop();
if (result.skipped) {
  process.exit(0);
}
