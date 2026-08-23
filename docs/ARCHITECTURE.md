# Architecture

Berth Market lists things, prices them, and moves USDC. It is not a computer.

Isolation, Docker, and hypervisors live in [Berthos](https://github.com/hexuria/berthos). This process talks to a Berthos node only as an `EligibilityClient` (`GET /v1/eligibility`) and as a fulfillment URL on `kind=desktop.linux` listings.

```
  human USDC
       │
       ▼
  treasury wallet ───────────┐
       │                     │ earn 90%
  spend cap                  │
       ▼                     │
  agent wallet ──x402──► listing ──► seller payTo
       │                     │
       │                     └──► protocol treasury (10%)
       │
       └── 402 PAYMENT-REQUIRED
           retry + PAYMENT-SIGNATURE
           200 + PAYMENT-RESPONSE + receipt
```

## What this repo is

| In                             | Out                                      |
| ------------------------------ | ---------------------------------------- |
| Catalog of SKUs                | Guest VMs, Docker, hypervisor            |
| x402 quotes and receipts       | A Berth chain or meme token              |
| USDC on Base (`eip155:8453`)   | Email / AgentMail                        |
| Stored Berthos doctor result   | Proving isolation itself                 |
| Capped child agent wallets     | Host-desktop or laptop fulfillment       |

## Stack

A small [Hono](https://hono.dev) app. `src/index.ts` serves it with `@hono/node-server`. `src/worker.ts` is the same `app.fetch` for a Cloudflare Worker later. Tests call `app.request` — no secrets, no Postgres, no live CDP.

Persistence in v1 is an in-memory `MarketStore`. Swap the adapter for SQLite or Postgres without changing routes.

## Ports and adapters

Core use-cases depend on ports, not vendors.

| Port                 | Test adapter              | Production adapter                                      |
| -------------------- | ------------------------- | ------------------------------------------------------- |
| `WalletPort`         | `MemoryWalletAdapter`     | `CdpWalletAdapter` (`WALLET_ADAPTER=cdp` — see [WALLET.md](WALLET.md)) |
| `FacilitatorPort`    | `TestFacilitator` (default) | `LiveFacilitator` (`FACILITATOR_URL`) → `POST /verify` + `/settle` |
| `EligibilityClient`  | `MemoryEligibilityClient` | `HttpBerthosEligibilityClient` (`BERTHOS_URL`) → `GET /v1/eligibility` |
| `MarketStore`        | `MemoryStore`             | SQLite / D1 / Postgres later                            |

Fail-closed rules live in the domain, not in HTTP handlers:

- Forbidden `class` / `kind` values (`laptop`, `host-desktop`, …) never become listings.
- `desktop.*` kinds require a stored Berthos attestation. Missing, stale, `ok: false`, `class=laptop`, unreachable `GET /v1/eligibility`, or stale/missing image labels is a reject.

## x402 v2

Official `@x402/hono` middleware wants a static route table. Listings here are dynamic (each SKU has its own `price` and `payTo`), so the market speaks the v2 **header shape** from the [x402 spec](https://github.com/x402-foundation/x402/blob/main/specs/transports-v2/http.md) and keeps a `FacilitatorPort` that matches `POST /verify` and `POST /settle`.

| Header              | Direction        | Body (base64 JSON)      |
| ------------------- | ---------------- | ----------------------- |
| `PAYMENT-REQUIRED`  | server → client  | `PaymentRequired`       |
| `PAYMENT-SIGNATURE` | client → server  | `PaymentPayload`        |
| `PAYMENT-RESPONSE`  | server → client  | `SettlementResponse`    |

Scheme: `exact`. Asset: native USDC on Base (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`). Network: `eip155:8453`.

`TestFacilitator` is the default. It accepts `test:<walletId>` signatures so CI and `npm run earn-loop` complete a spend/earn loop without a chain. Set `FACILITATOR_URL` to swap in `LiveFacilitator` (or `@x402/core/server` `HTTPFacilitatorClient`). Tests never call that URL unless `fetch` is mocked.

## Money

Amounts are atomic USDC (6 decimals) stored as decimal strings. On a successful invoke the market:

1. Debits the paying agent (balance **and** remaining spend cap).
2. Credits `listing.payTo` with 90%.
3. Credits the protocol treasury with 10%.
4. Writes a receipt.

There is no Berth token. There is no L1 of our own.

## Fulfillment boundary

A paid `GET /listings/:id/invoke` returns `200` and a receipt. It does **not** boot a VM and does **not** proxy an arbitrary HTTP URL (that would be SSRF). HTTP/MCP SKUs are priced here; the buyer calls the published endpoint. Desktop SKUs are priced here; a Berthos node fulfills the guest session.
