import { getAddress, keccak256, stringToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chainIdFor, parseListingNetwork } from "../domain/money.js";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "../domain/x402.js";
import { X402_VERSION } from "../domain/x402.js";

const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/**
 * Build a v2 exact-EVM PaymentPayload from a 402 quote and a staging EOA key.
 * The private key is used only to sign EIP-712 TransferWithAuthorization and is never logged.
 */
export async function signExactEvmPayment(input: {
  privateKey: `0x${string}`;
  quote: PaymentRequired;
  accepted?: PaymentRequirements;
  nowSeconds?: number;
}): Promise<{ payload: PaymentPayload; from: string }> {
  const accepted = input.accepted ?? input.quote.accepts[0];
  if (!accepted) throw new Error("quote has no accepts[]");

  const network = parseListingNetwork(accepted.network);
  const account = privateKeyToAccount(input.privateKey);
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const nonce = keccak256(stringToBytes(crypto.randomUUID()));
  const authorization = {
    from: account.address,
    to: getAddress(accepted.payTo),
    value: accepted.amount,
    validAfter: String(now - 30),
    validBefore: String(now + accepted.maxTimeoutSeconds),
    nonce,
  };

  const signature = await account.signTypedData({
    domain: {
      name: accepted.extra?.name ?? "USDC",
      version: accepted.extra?.version ?? "2",
      chainId: chainIdFor(network),
      verifyingContract: getAddress(accepted.asset),
    },
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: authorization.from,
      to: authorization.to,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    },
  });

  return {
    from: account.address,
    payload: {
      x402Version: X402_VERSION,
      resource: input.quote.resource,
      accepted,
      payload: {
        signature,
        authorization,
      },
    },
  };
}

export function payerAddressFromKey(privateKey: `0x${string}`): string {
  return privateKeyToAccount(privateKey).address;
}
