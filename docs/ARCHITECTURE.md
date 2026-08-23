# Architecture

Berth Market lists things, prices them, and moves USDC. It is not a computer.

Isolation, Docker, and hypervisors live in [Berthos](https://github.com/hexuria/berthos). This process talks to a Berthos node as an `EligibilityClient` (`GET /v1/eligibility`) and a `LeaseClient` (`POST /v1/leases`, `DELETE /v1/leases/{id}`). Money never leaves this repo.

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
| USDC on Base (`eip155:8453`) or Base Sepolia (`eip155:84532`) | Email / AgentMail          |
| Stored Berthos doctor result   | Proving isolation itself                 |
| Capped child agent wallets     | Host-desktop or laptop fulfillment       |

## Stack

A small [Hono](https://hono.dev) app. `src/index.ts` serves it with `@hono/node-server`. `src/worker.ts` is the same `app.fetch` for a Cloudflare Worker later. Tests call `app.request` — no secrets, no Postgres, no live CDP.

Browser callers ([berth-web](https://github.com/hexuria/berth-web) on Vite `:5173` / `:5174`) need CORS. The Hono app answers `OPTIONS` and allows `CORS_ORIGIN` (comma list). The default is those loopback Vite origins, not `*`. See the README browser section. A Vite proxy is documented there as an alternative (and as the workaround for Berthos `:7432`, which this repo does not serve).

Persistence in v1 is an in-memory `MarketStore`. Swap the adapter for SQLite or Postgres without changing routes.

## Ports and adapters

Core use-cases depend on ports, not vendors.

| Port                 | Test adapter              | Production adapter                                      |
| -------------------- | ------------------------- | ------------------------------------------------------- |
| `WalletPort`         | `MemoryWalletAdapter`     | `CdpWalletAdapter` (`WALLET_ADAPTER=cdp` — see [WALLET.md](WALLET.md)) |
| `FacilitatorPort`    | `TestFacilitator` (default) | `LiveFacilitator` (`FACILITATOR_URL`) → `POST /verify` + `/settle` |
| `EligibilityClient`  | `MemoryEligibilityClient` | `HttpBerthosEligibilityClient` (`BERTHOS_URL`) → `GET /v1/eligibility` |
| `LeaseClient`        | `MemoryLeaseClient`       | `HttpBerthosLeaseClient` (`BERTHOS_URL` + `BERTHOS_LEASE_TOKEN`) → `POST/DELETE /v1/leases` |
| `MarketStore`        | `MemoryStore`             | SQLite / D1 / Postgres later                            |

Fail-closed rules live in the domain, not in HTTP handlers:

- Forbidden `class` / `kind` values (`laptop`, `host-desktop`, …) never become listings.
- `desktop.*` kinds require a stored Berthos attestation. Missing, stale, `ok: false`, `class=laptop`, unreachable `GET /v1/eligibility`, or stale/missing image labels is a reject.
- Paid `desktop.linux` invoke **re-checks eligibility**, then `POST /v1/leases` **before** x402 settle / wallet debit. Unreachable node, laptop class, ineligible doctor, or 409 already-leased is 4xx with no charge. A settle failure after create **aborts** the guest (`DELETE`). A replayed nonce is rejected before a second lease.

## x402 v2

Official `@x402/hono` middleware wants a static route table. Listings here are dynamic (each SKU has its own `price` and `payTo`), so the market speaks the v2 **header shape** from the [x402 spec](https://github.com/x402-foundation/x402/blob/main/specs/transports-v2/http.md) and keeps a `FacilitatorPort` that matches `POST /verify` and `POST /settle`.

| Header              | Direction        | Body (base64 JSON)      |
| ------------------- | ---------------- | ----------------------- |
| `PAYMENT-REQUIRED`  | server → client  | `PaymentRequired`       |
| `PAYMENT-SIGNATURE` | client → server  | `PaymentPayload`        |
| `PAYMENT-RESPONSE`  | server → client  | `SettlementResponse`    |

Scheme: `exact` / EIP-3009. Listings choose a network:

| Network        | CAIP-2         | USDC                                         | Facilitator default                         |
| -------------- | -------------- | -------------------------------------------- | ------------------------------------------- |
| Base           | `eip155:8453`  | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | production facilitator (not in CI)          |
| Base Sepolia   | `eip155:84532` | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | `https://x402.org/facilitator` (no API key) |

Alias `base-sepolia` is accepted on `price.network` / `NETWORK=` and stored as `eip155:84532`. New listings that omit `price.network` default to `eip155:84532`. A listing that already set `eip155:8453` is quoted on 8453 — it is not rewritten to Sepolia. Staging traffic must not use `8453`.

`TestFacilitator` is the default. It accepts `test:<walletId>` signatures so CI and `npm run earn-loop` complete a spend/earn loop without a chain. Set `FACILITATOR_URL` to swap in `LiveFacilitator` (`POST /verify` + `POST /settle` with the v2 `{ x402Version, paymentPayload, paymentRequirements }` body). Tests never call that URL unless `fetch` is mocked.

A live Sepolia payment through the public facilitator does **not** debit `MemoryWallet`. The receipt stores the facilitator settle tx hash. On-chain USDC is **100%** to `payTo` (`onChainSettlement=payTo_100`); 90/10 is receipt accounting. The public facilitator has one `payTo` — we do not invent a second settle.

`CdpWalletAdapter` (`WALLET_ADAPTER=cdp` + three keys) is the other ledger: `@coinbase/cdp-sdk` on **Base Sepolia** by default, `useSpendPermission` then two USDC transfers (90/10). CI never constructs it and never calls Coinbase.

## Money

Amounts are atomic USDC (6 decimals) stored as decimal strings. On a successful invoke the market:

1. Debits the paying agent (balance **and** remaining spend cap).
2. Credits `listing.payTo` with 90%.
3. Credits the protocol treasury with 10%.
4. Writes a receipt.

There is no Berth token. There is no L1 of our own.

v1 desktop billing is **pay-then-occupy**: the listing price settles at invoke. Berthos quotes occupancy seconds with `charged_here: false`. `POST /receipts/:id/end` stores those seconds on the receipt. It does not mint a second x402.

## Fulfillment boundary

A paid `GET /listings/:id/invoke` returns `200` and a receipt. It does **not** boot a VM in this process and does **not** proxy an arbitrary HTTP URL (that would be SSRF). HTTP/MCP SKUs are priced here; the buyer calls the published endpoint.

`kind=desktop.linux` is priced here, then this process asks the listing's Berthos node to start one isolated Linux guest. The 200 includes `fulfillment.leaseId` + `berthosUrl`. `POST /receipts/:id/end` destroys the guest and writes occupancy seconds. Docker / hypervisor code stays in [hexuria/berthos](https://github.com/hexuria/berthos).
