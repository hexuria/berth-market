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

On **Base Sepolia** there are two honest money paths:

| Path | On-chain USDC | Receipt 90/10 |
| ---- | ------------- | ------------- |
| Public x402.org facilitator (`FACILITATOR_URL`, `sepolia-loop`) | **100%** to `listing.payTo` (one `payTo`, one settle) | Stored as `sellerAtomic` / `protocolAtomic`. `onChainSettlement=payTo_100`. |
| `CdpWalletAdapter` (`WALLET_ADAPTER=cdp` + three keys) | **90%** `payTo` + **10%** protocol via `useSpendPermission` then two USDC transfers | Same numbers. `onChainSettlement=cdp_split_90_10`. |

CI `MemoryWallet` + `TestFacilitator` receipts also store `onChainSettlement=payTo_100` (no chain hop).

The public facilitator does not take two `payTo`s. Do not fake a second on-chain hop after that settle. Do not pair live facilitator settle with a CDP re-split.

## WalletPort

Routes never talk to Coinbase directly. They call `WalletPort`.

### `MemoryWalletAdapter` (v1 default)

In-process balances. No keys. Used by tests and `npm run earn-loop`. **Not on-chain.** CI always uses this adapter.

### Base Sepolia staging (facilitator-authoritative)

`npm run sepolia-loop` lists HTTP, MCP, and desktop.linux, signs a real EIP-3009 `PaymentPayload` with `STAGING_PAYER_PRIVATE_KEY` (or `X402_PAYER_PRIVATE_KEY`), and settles through `FACILITATOR_URL` (default `https://x402.org/facilitator` when `NETWORK=base-sepolia`). Desktop is in-process MemoryEligibility/MemoryLease (no `BERTHOS_URL`). The public facilitator needs no API key and supports `eip155:84532` only — not Base mainnet.

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

Amount is 1000 atomic USDC ($0.001) per kind (HTTP, MCP, desktop.linux). This is **testnet**, not mainnet. Do not set these vars in CI.

The settle path is `sepolia-loop` → Hono 402 → EIP-3009 sign → `LiveFacilitator` `POST /settle` (once per kind). It is **not** `cast send` and not a payer-submitted `transfer()`. On Basescan the tx `from` is the facilitator relayer, `to` is Sepolia USDC, method is `transferWithAuthorization`, and each ERC-20 Transfer is 1000 atomic to `STAGING_PAY_TO` (100% on-chain; 90/10 is receipt-only). How to tick those fields, plus two proven hashes created by `src/staging/loop.ts`: [DEMO.md — How we know this is our repo](DEMO.md#how-we-know-this-is-our-repo). Host vs buyer walkthrough: [DEMO.md](DEMO.md).

Optional later: CDP facilitator `https://api.cdp.coinbase.com/platform/v2/x402` (needs CDP auth). Not required for the first staging loop.

### `CdpWalletAdapter` (env-flagged)

Production target: [Coinbase Developer Platform](https://docs.cdp.coinbase.com/) / Agentic Wallet via `@coinbase/cdp-sdk`.

Selected only when **`WALLET_ADAPTER=cdp` and** `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, and `CDP_WALLET_SECRET` are set. If the flag is set without keys, boot **throws** — the live adapter is not constructed. Default boot and every CI test use `MemoryWalletAdapter`. Tests inject a mock `CdpClient`; they never call Coinbase.

`GET /health` reports the wired identity: `walletAdapter` (`memory` | `cdp`), `facilitator` (`test` | `live`), and `facilitatorUrl` when `FACILITATOR_URL` is set. The body is secret-free — no CDP keys, wallet secrets, or spend-permission material.

Live CDP network is **Base Sepolia** (`base-sepolia` / `eip155:84532`) unless `NETWORK` or `CDP_NETWORK` is **explicitly** `base` / `eip155:8453`. Unset `NETWORK` does **not** mean mainnet for this adapter. Catalog `loadConfig` also defaults **new** listings that omit `price.network` to `eip155:84532`. Listings that already set `eip155:8453` are stored and quoted as mainnet — they are not rewritten.

Mapping — wrap CDP, do not invent a second ledger:

| Market concept | CDP primitive                                                                 |
| -------------- | ----------------------------------------------------------------------------- |
| Treasury       | EVM smart account with `enableSpendPermissions: true`                         |
| Agent          | Spender EOA + `cdp.evm.createSpendPermission({ token: "usdc", … })`           |
| Spend cap      | Spend-permission `allowance` (365-day period)                                 |
| Fund           | `requestFaucet` on `base-sepolia` only. The drip size is Coinbase's; `amount` is the market spend-cap credit. No mainnet faucet. |
| Listing payout | `useSpendPermission` then two USDC transfers: 90% `payTo`, 10% protocol       |

Keep `WALLET_ADAPTER=memory` for `sepolia-loop` (the script forces it). Facilitator settle and CDP spend-permissions are different ledgers — do not run both on one payment.

See [Spend Permissions](https://docs.cdp.coinbase.com/wallets/using-wallets/spend-permissions). CI needs no secrets.
