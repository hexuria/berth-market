import { serve } from "@hono/node-server";
import { createApp } from "./app.js";

const { app, config, deps } = await createApp();

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`berth-market listening on http://127.0.0.1:${info.port}`);
  console.log(`protocol treasury ${deps.protocolTreasury.id} ${deps.protocolTreasury.address}`);
  console.log(
    `USDC default ${config.network} (new listings that omit price.network). Explicit eip155:8453 is kept. No chain of our own. Email/AgentMail is out of v1.`,
  );
  console.log(`CORS origins: ${config.corsOrigins.join(", ")}`);
});
