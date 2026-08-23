import { X402_VERSION, type SettlementResponse, type VerifyResponse } from "../domain/x402.js";
import type { FacilitatorPort } from "../ports/facilitator.js";
import type { FacilitatorSettleRequest, FacilitatorVerifyRequest } from "../domain/x402.js";

/**
 * HTTP client for a live x402 facilitator (`POST /verify`, `POST /settle`).
 * Not used in CI. Prefer wrapping `@x402/core/server` `HTTPFacilitatorClient`
 * once listings grow a static route table or a Worker binding.
 */
export class HttpFacilitator implements FacilitatorPort {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async verify(request: FacilitatorVerifyRequest): Promise<VerifyResponse> {
    return this.post<VerifyResponse>("/verify", request);
  }

  async settle(request: FacilitatorSettleRequest): Promise<SettlementResponse> {
    return this.post<SettlementResponse>("/settle", request);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const url = new URL(path, this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`);
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ x402Version: X402_VERSION, ...(body as object) }),
    });
    if (!response.ok) {
      throw new Error(`facilitator ${path} returned HTTP ${response.status}`);
    }
    return (await response.json()) as T;
  }
}
