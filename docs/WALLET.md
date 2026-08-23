# Wallets

v1 money is USDC on Base (`eip155:8453`) or Base Sepolia staging (`eip155:84532`). No Berth token. No chain of our own.

## Two wallets

```
human ──funds──► treasury (parent)
                     │
                     │ spend permission / cap
                     ▼
                 agent (child) ──spends──► listings
                     ▲
                     └── earns land on the treasury (payTo), not the child
```

| Kind         | Who                         | What it can do                                              |
| ------------ | --------------------------- | ----------------------------------------------------------- |
| `treasury`   | Human (or protocol)         | Hold USDC, receive listing payouts, parent an agent         |
| `agent`      | Capped child                | Spend up to `spendCap` via x402; cannot exceed remaining cap |

An agent is created with `POST /wallets/agent`. If you omit `treasuryId`, the market creates a parent treasury first.

```json
{
  "treasuryId": "wal_…",
  "spendCap": "5000000",
  "label": "research-agent"
}
```

`spendCap` is atomic USDC. `"5000000"` is $5.00. Every successful invoke adds the listing price to `spentAtomic`. `spentAtomic + nextPayment > spendCap` → `402 spend_cap_exceeded`.

## Test faucet

`POST /wallets/:id/fund` mints test USDC into the in-memory ledger.

```json
{ "amount": "2000000" }
```

This is how CI and `npm run earn-loop` fund a buyer. It is **not** on-chain and not a mainnet faucet. `MemoryWalletAdapter` must not be treated as a Base or Sepolia balance.

## Earn path

On a paid invoke:

1. Agent balance decreases by `price.amount`.
2. Agent `spentAtomic` increases by `price.amount`.
3. `listing.payTo` (seller treasury) is credited **90%**.
4. Protocol treasury is credited **10%**.

The protocol treasury is created at boot (`PROTOCOL_TREASURY_ADDRESS` or a generated test address).

On **Base Sepolia** the live settle is facilitator-authoritative: the facilitator submits `transferWithAuthorization` and the receipt stores that tx hash. The market still records a 90/10 split on the receipt. The on-chain transfer is 100% to `listing.payTo` — this slice does not invent a second ledger or wire CDP spend-permissions to move the 10% on-chain.

## WalletPort

Routes never talk to Coinbase directly. They call `WalletPort`.

### `MemoryWalletAdapter` (v1 default)

In-process balances. No keys. Used by tests and `npm run earn-loop`. **Not on-chain.** CI always uses this adapter.

### Base Sepolia staging (facilitator-authoritative)

`npm run sepolia-loop` signs a real EIP-3009 `PaymentPayload` with `STAGING_PAYER_PRIVATE_KEY` (or `X402_PAYER_PRIVATE_KEY`) and settles through `FACILITATOR_URL` (default `https://x402.org/facilitator` when `NETWORK=base-sepolia`). The public facilitator needs no API key and supports `eip155:84532` only — not Base mainnet.

This path does **not** debit `MemoryWallet`. The receipt's `transaction` is the facilitator settle / tx hash. Skip (exit 0) when the key or `STAGING_PAY_TO` is unset so CI stays secret-free.

Fund the payer EOA on **Base Sepolia** (testnet):

1. Create or export a throwaway EOA. Never commit the key. Never paste it into logs.
2. Sepolia ETH for the payer is optional for x402 exact/EIP-3009 (the facilitator sponsors gas). You still need **testnet USDC**.
3. USDC (Base Sepolia): [Circle faucet](https://faucet.circle.com) or the [Coinbase CDP faucet](https://portal.cdp.coinbase.com/products/faucet). Documented only — do not scrape keys.
4. Sepolia ETH (if you want to move funds yourself): [Coinbase CDP faucet](https://portal.cdp.coinbase.com/products/faucet) or Base's public faucet list.

Then:

```bash
export NETWORK=base-sepolia
export FACILITATOR_URL=https://x402.org/facilitator
export STAGING_PAYER_PRIVATE_KEY=0xYOUR_SEPOLIA_EOA_KEY
export STAGING_PAY_TO=0xSELLER_RECEIVER
npm run sepolia-loop
```

Amount is 1000 atomic USDC ($0.001). This is **testnet**, not mainnet. Do not set these vars in CI.

Optional later: CDP facilitator `https://api.cdp.coinbase.com/platform/v2/x402` (needs CDP auth). Not required for the first staging loop.

### `CdpWalletAdapter` (env-flagged)

Production target: [Coinbase Developer Platform](https://docs.cdp.coinbase.com/) / Agentic Wallet.

The adapter **implements `WalletPort` and compiles**. It is selected only when `WALLET_ADAPTER=cdp` **and** `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, and `CDP_WALLET_SECRET` are set. Default boot and every CI test use `MemoryWalletAdapter`. Do **not** add `@coinbase/cdp-sdk` as a runtime dependency in this slice — live CDP calls are not made without that SDK, so a flagged adapter without it returns `cdp_not_live` rather than inventing a second ledger.

Intended mapping — wrap CDP, do not invent a second ledger:

| Market concept | CDP primitive                                                                 |
| -------------- | ----------------------------------------------------------------------------- |
| Treasury       | EVM smart account with `enableSpendPermissions: true`                         |
| Agent          | Spender account + `cdp.evm.createSpendPermission({ token: "usdc", … })`       |
| Spend cap      | Spend-permission `allowance` / period on Base                                 |
| Fund           | USDC transfer onto the treasury or agent on `base` / `eip155:8453` (mainnet) or `base-sepolia` / `eip155:84532` (staging) |
| Listing payout | `useSpendPermission` then transfer 90% `payTo` / 10% protocol                 |

Sepolia spend-permissions via CDP are **not** wired in this slice — that would be a second live ledger beside the facilitator settle. Keep `WALLET_ADAPTER=memory` for staging; the gap is that in-memory balances do not track on-chain USDC.

See [Spend Permissions](https://docs.cdp.coinbase.com/wallets/using-wallets/spend-permissions). Tests must keep using `MemoryWalletAdapter` so CI needs no secrets.
