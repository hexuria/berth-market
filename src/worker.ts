/**
 * Cloudflare Workers entry. Same Hono app as the Node adapter.
 * Bindings / D1 persistence are a later adapter — v1 boots in-memory.
 */
import { createApp } from "./app.js";

const boot = createApp();

export default {
  async fetch(request: Request): Promise<Response> {
    const { app } = await boot;
    return app.fetch(request);
  },
};
