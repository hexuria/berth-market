/**
 * One fake USDC earn loop against the in-process market.
 * HTTP + MCP + desktop.linux. No CDP keys, no chain, no Berthos URL.
 * Run: `npm run earn-loop`
 */
import { runEarnLoop } from "../earn/loop.js";

await runEarnLoop();
