# Wallets

v1 money is USDC on Base. No Berth token. No chain of our own.

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

This is how CI and `npm run earn-loop` fund a buyer. It is not a mainnet faucet.

## Earn path

On a paid invoke:

1. Agent balance decreases by `price.amount`.
2. Agent `spentAtomic` increases by `price.amount`.
3. `listing.payTo` (seller treasury) is credited **90%**.
4. Protocol treasury is credited **10%**.

The protocol treasury is created at boot (`PROTOCOL_TREASURY_ADDRESS` or a generated test address).

## WalletPort

Routes never talk to Coinbase directly. They call `WalletPort`.

### `MemoryWalletAdapter` (v1 default)

In-process balances. No keys. Used by tests and local loops.

### `CdpWalletAdapter` (env-flagged)

Production target: [Coinbase Developer Platform](https://docs.cdp.coinbase.com/) / Agentic Wallet.

The adapter **implements `WalletPort` and compiles**. It is selected only when `WALLET_ADAPTER=cdp` **and** `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, and `CDP_WALLET_SECRET` are set. Default boot and every CI test use `MemoryWalletAdapter`. Do **not** add `@coinbase/cdp-sdk` as a runtime dependency in this slice — live CDP calls are not made without that SDK, so a flagged adapter without it returns `cdp_not_live` rather than inventing a second ledger.

Intended mapping — wrap CDP, do not invent a second ledger:

| Market concept | CDP primitive                                                                 |
| -------------- | ----------------------------------------------------------------------------- |
| Treasury       | EVM smart account with `enableSpendPermissions: true`                         |
| Agent          | Spender account + `cdp.evm.createSpendPermission({ token: "usdc", … })`       |
| Spend cap      | Spend-permission `allowance` / period on Base                                 |
| Fund           | USDC transfer onto the treasury or agent on `base` / `eip155:8453`            |
| Listing payout | `useSpendPermission` then transfer 90% `payTo` / 10% protocol                 |

See [Spend Permissions](https://docs.cdp.coinbase.com/wallets/using-wallets/spend-permissions). Tests must keep using `MemoryWalletAdapter` so CI needs no secrets.
