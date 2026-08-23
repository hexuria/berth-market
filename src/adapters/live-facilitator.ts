import { X402_VERSION, type SettlementResponse, type VerifyResponse } from "../domain/x402.js";
import type { FacilitatorPort } from "../ports/facilitator.js";
import type { FacilitatorSettleRequest, FacilitatorVerifyRequest } from "../domain/x402.js";
import type { MarketStore } from "../ports/store.js";
import { TestFacilitator } from "./test-facilitator.js";

export const FACILITATOR_URL_ENV = "FACILITATOR_URL";

/**
 * Live x402 facilitator (`POST /verify`, `POST /settle`).
 *
 * Selected only when `FACILITATOR_URL` is set. Tests must inject `fetchImpl`
 * — the default `fetch` is never used in CI. Prefer wrapping
 * `@x402/core/server` `HTTPFacilitatorClient` once listings grow a static
 * route table or a Worker binding.
 */
export class LiveFacilitator implements FacilitatorPort {
  readonly kind = "live" as const;

  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (!baseUrl) {
      throw new Error("LiveFacilitator requires FACILITATOR_URL");
    }
  }

  async verify(request: FacilitatorVerifyRequest): Promise<VerifyResponse> {
    return this.post<VerifyResponse>("/verify", request);
  }

  async settle(request: FacilitatorSettleRequest): Promise<SettlementResponse> {
    return this.post<SettlementResponse>("/settle", request);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const url = joinFacilitatorPath(this.baseUrl, path);
    const payload = body as FacilitatorVerifyRequest | FacilitatorSettleRequest;
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        x402Version: payload.x402Version ?? X402_VERSION,
        paymentPayload: payload.paymentPayload,
        paymentRequirements: payload.paymentRequirements,
      }),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      throw new Error(
        `facilitator ${path} returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
      );
    }
    return (await response.json()) as T;
  }
}

/**
 * Join FACILITATOR_URL + /verify|/settle without dropping a path prefix.
 * `new URL("/verify", "https://x402.org/facilitator")` is `https://x402.org/verify`.
 */
export function joinFacilitatorPath(baseUrl: string, path: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  const suffix = path.replace(/^\/+/, "");
  return `${trimmed}/${suffix}`;
}

/** @deprecated Use `LiveFacilitator`. Kept so existing imports keep compiling. */
export { LiveFacilitator as HttpFacilitator };

export function shouldUseLiveFacilitator(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env[FACILITATOR_URL_ENV]);
}

/**
 * Default factory: in-process `TestFacilitator` unless `FACILITATOR_URL` is set.
 * Pass `fetchImpl` from tests so a live URL cannot hit the network.
 */
export function createFacilitator(
  store: MarketStore,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: typeof fetch,
): FacilitatorPort {
  const url = env[FACILITATOR_URL_ENV];
  if (!url) {
    return new TestFacilitator(store);
  }
  return new LiveFacilitator(url, fetchImpl ?? globalThis.fetch);
}
