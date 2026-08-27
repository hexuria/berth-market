import { WalletError } from "../domain/wallet.js";
import type {
  FacilitatorSettleRequest,
  FacilitatorVerifyRequest,
  PaymentPayload,
  PaymentRequirements,
  SettlementResponse,
  VerifyResponse,
} from "../domain/x402.js";
import { X402_VERSION } from "../domain/x402.js";
import type { FacilitatorPort } from "../ports/facilitator.js";
import type { MarketStore } from "../ports/store.js";
import { newTxHash } from "./ids.js";

/**
 * In-process x402 facilitator for tests and `npm run earn-loop`.
 *
 * Accepts signatures of the form `test:<walletId>` (or any `test:` prefix)
 * when the payload amount/asset/payTo match the quote. Replay is blocked
 * via store nonces. Does not talk to a chain. Live Sepolia settle uses
 * `LiveFacilitator` + `npm run sepolia-loop`, not this adapter.
 */
export class TestFacilitator implements FacilitatorPort {
  readonly kind = "test" as const;

  constructor(private readonly store: MarketStore) {}

  async verify(request: FacilitatorVerifyRequest): Promise<VerifyResponse> {
    const reason = await this.invalidReason(request.paymentPayload, request.paymentRequirements);
    if (reason) {
      return { isValid: false, invalidReason: reason };
    }
    return {
      isValid: true,
      payer: request.paymentPayload.payload.authorization.from,
      extra: { walletId: walletIdFromSignature(request.paymentPayload.payload.signature) },
    };
  }

  async settle(request: FacilitatorSettleRequest): Promise<SettlementResponse> {
    const verified = await this.verify(request);
    if (!verified.isValid) {
      return {
        success: false,
        errorReason: verified.invalidReason,
        transaction: "",
        network: request.paymentRequirements.network,
      };
    }
    const consumed = await this.store.consumeNonce(request.paymentPayload.payload.authorization.nonce);
    if (!consumed) {
      return {
        success: false,
        errorReason: "replayed_nonce",
        transaction: "",
        network: request.paymentRequirements.network,
        payer: verified.payer,
      };
    }
    return {
      success: true,
      transaction: newTxHash(),
      network: request.paymentRequirements.network,
      payer: verified.payer,
      amount: request.paymentRequirements.amount,
    };
  }

  private async invalidReason(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<string | undefined> {
    if (payload.x402Version !== X402_VERSION) return "unsupported_x402_version";
    if (payload.accepted.scheme !== requirements.scheme) return "scheme_mismatch";
    if (payload.accepted.network !== requirements.network) return "network_mismatch";
    if (payload.accepted.amount !== requirements.amount) return "amount_mismatch";
    if (payload.accepted.asset.toLowerCase() !== requirements.asset.toLowerCase()) {
      return "asset_mismatch";
    }
    if (payload.accepted.payTo.toLowerCase() !== requirements.payTo.toLowerCase()) {
      return "pay_to_mismatch";
    }
    const auth = payload.payload.authorization;
    if (auth.to.toLowerCase() !== requirements.payTo.toLowerCase()) return "authorization_to_mismatch";
    if (auth.value !== requirements.amount) return "authorization_value_mismatch";
    if (!payload.payload.signature.startsWith("test:")) {
      return "unsupported_signature";
    }
    const walletId = walletIdFromSignature(payload.payload.signature);
    if (!walletId) return "missing_wallet_id";
    const wallet = await this.store.getWallet(walletId);
    if (!wallet) return "unknown_wallet";
    if (wallet.address.toLowerCase() !== auth.from.toLowerCase()) {
      return "authorization_from_mismatch";
    }
    const now = Math.floor(Date.now() / 1000);
    if (BigInt(auth.validAfter) > BigInt(now)) return "authorization_not_yet_valid";
    if (BigInt(auth.validBefore) < BigInt(now)) return "authorization_expired";
    return undefined;
  }
}

export function walletIdFromSignature(signature: string): string | undefined {
  const match = /^test:([A-Za-z0-9_:-]+)$/.exec(signature);
  return match?.[1];
}

export function testPaymentSignature(walletId: string): string {
  if (!walletId) throw new WalletError("invalid_wallet", "wallet id required for test signature");
  return `test:${walletId}`;
}
