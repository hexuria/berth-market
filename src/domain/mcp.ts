import type { Listing } from "./listing.js";

/**
 * In-process MCP fulfill. Records the paid tool name and returns a small JSON
 * result. Does not open a socket, call an MCP server, or proxy `endpoint.url`
 * (that would be SSRF). Docker / hypervisor stay in Berthos.
 */
export interface McpInvokeResult {
  ok: true;
  tool: string;
  proxied: false;
}

export interface McpFulfillment {
  status: "accepted";
  kind: "mcp";
  tool: string;
  result: McpInvokeResult;
  endpoint: NonNullable<Listing["endpoint"]>;
  note: string;
}

export function prepareMcpFulfillment(
  listing: Listing,
):
  | { ok: true; fulfillment: McpFulfillment }
  | { ok: false; code: string; message: string; status: number } {
  const endpoint = listing.endpoint;
  const tool = endpoint?.tool?.trim();
  if (!endpoint?.url || !tool) {
    return {
      ok: false,
      status: 400,
      code: "endpoint_required",
      message:
        "mcp invoke needs endpoint.url and endpoint.tool; v1 does not call an upstream MCP server",
    };
  }
  return {
    ok: true,
    fulfillment: {
      status: "accepted",
      kind: "mcp",
      tool,
      result: { ok: true, tool, proxied: false },
      endpoint: { ...endpoint, tool },
      note: "MCP invoke is priced here; v1 does not call or proxy the upstream MCP server.",
    },
  };
}
