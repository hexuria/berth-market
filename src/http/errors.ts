import { LeaseError } from "../domain/lease.js";
import { ListingValidationError } from "../domain/listing.js";
import { MoneyError } from "../domain/money.js";
import { WalletError } from "../domain/wallet.js";

export interface ErrorBody {
  error: {
    code: string;
    message: string;
  };
}

export function toErrorResponse(error: unknown): { status: number; body: ErrorBody } {
  if (
    error instanceof ListingValidationError ||
    error instanceof WalletError ||
    error instanceof LeaseError
  ) {
    return {
      status: error.status,
      body: { error: { code: error.code, message: error.message } },
    };
  }
  if (error instanceof MoneyError) {
    return {
      status: 400,
      body: { error: { code: "invalid_amount", message: error.message } },
    };
  }
  const message = error instanceof Error ? error.message : "internal_error";
  return {
    status: 500,
    body: { error: { code: "internal_error", message } },
  };
}
