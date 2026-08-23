# Berth Market

Agent spend/earn layer. Lists HTTP APIs, MCP tools, and desktop SKUs; prices them in **USDC on Base** (`eip155:8453`) or **Base Sepolia staging** (`eip155:84532`); settles via **x402 v2**.

This repo is not a computer. Isolation, Docker, and hypervisors live in **[Berthos](https://github.com/hexuria/berthos)**. The market talks to a node over HTTP (`GET /v1/eligibility`, `POST /v1/leases`, `DELETE /v1/leases/{id}`) and rejects anything that claims `class=laptop` or `host-desktop`.

No Berth chain. No meme token. Email / AgentMail is out of v1.

## Spend / earn story

1. A human funds a **treasury** with USDC on Base (or a Sepolia EOA for staging).
2. An **agent wallet** is a capped child of that treasury. It can **spend** (x402) up to its cap.
3. A seller lists an HTTP endpoint, an MCP tool, or a `desktop.linux` SKU fulfilled by a Berthos node (later W365).
4. The agent calls `GET /listings/:id/invoke` unpaid → **HTTP 402** + `PAYMENT-REQUIRED` quote.
5. The agent retries with `PAYMENT-SIGNATURE`. The test facilitator (or a live x402 facilitator) verifies.
6. For `desktop.linux`, the market **creates a Berthos lease first**, then settles. Unreachable / laptop / 409 → 4xx, no charge.
7. The market returns **200 + receipt** (and a `leaseId` for desktop). The seller treasury **earns 90%**. The protocol treasury takes **10%**.
8. `POST /receipts/:id/end` destroys the guest and stores occupancy seconds. That is a receipt, not a second payment.

```
treasury (human) ──cap──► agent ──402 / pay──► listing ──90%──► seller payTo
                                                      └──10%──► protocol
```

## Quick start

```bash
npm install
npm test
npm run earn-loop      # one fake USDC 402 → pay → earn cycle
npm run sepolia-loop   # opt-in Base Sepolia settle; skips (exit 0) without keys
npm start              # http://127.0.0.1:8787
```

CI needs no secrets. The default adapters are in-memory + a test x402 facilitator. `BERTHOS_URL`, `BERTHOS_LEASE_TOKEN`, `FACILITATOR_URL`, and `WALLET_ADAPTER=cdp` are opt-in and unused in CI. `npm run sepolia-loop` is also opt-in: without `STAGING_PAYER_PRIVATE_KEY` and `STAGING_PAY_TO` it prints a skip and exits 0. No live Coinbase keys, no mainnet USDC.

## List an HTTP endpoint

```bash
curl -s http://127.0.0.1:8787/wallets/treasury -X POST \
  -H 'content-type: application/json' \
  -d '{"label":"seller"}'

curl -s http://127.0.0.1:8787/listings -X POST \
  -H 'content-type: application/json' \
  -d '{
    "kind": "http",
    "title": "weather.now",
    "description": "Current conditions",
    "price": { "amount": "1000", "asset": "USDC", "network": "eip155:84532" },
    "payTo": "0x1111111111111111111111111111111111111111",
    "endpoint": { "url": "https://api.example.com/weather", "method": "GET" }
  }'
```

`price.amount` is atomic USDC (6 decimals). Staging default `"1000"` is $0.001. Mainnet listings still accept `eip155:8453`.

MCP uses `kind: "mcp"` and `endpoint.tool`. Desktop uses `kind: "desktop.linux"` after a green Berthos doctor — see below and [docs/LISTING.md](docs/LISTING.md).

## How an agent pays

```bash
# Capped child
curl -s http://127.0.0.1:8787/wallets/agent -X POST \
  -H 'content-type: application/json' \
  -d '{"spendCap":"5000000","label":"research-agent"}'

# Test USDC (not mainnet)
curl -s http://127.0.0.1:8787/wallets/WALLET_ID/fund -X POST \
  -H 'content-type: application/json' \
  -d '{"amount":"2000000"}'

# Unpaid invoke → 402
curl -i http://127.0.0.1:8787/listings/LISTING_ID/invoke
```

The 402 carries a base64 `PAYMENT-REQUIRED` header (x402 v2). Retry the same URL with `PAYMENT-SIGNATURE`. In tests the signature is `test:<walletId>` inside a v2 `PaymentPayload`. Live agents should use `@x402/fetch` + an EVM scheme against a real facilitator.

On success: `200`, `PAYMENT-RESPONSE`, and a receipt that splits 90/10.

## Base Sepolia staging (real testnet USDC)

This is **Base Sepolia** (`eip155:84532`), not Base mainnet (`eip155:8453`). Do not send staging traffic to 8453.

`MemoryWallet` + `TestFacilitator` stay the CI default. A funded Sepolia EOA can settle a real x402 payment through the public facilitator. The receipt stores the settle / tx hash. On-chain USDC goes to `STAGING_PAY_TO`; the 90/10 split is receipt accounting (no second ledger, no CDP spend-permissions in this slice).

1. Get a throwaway EOA. Never commit the key. This process never logs it.
2. Fund **Base Sepolia USDC** from the [Circle faucet](https://faucet.circle.com) or the [Coinbase CDP faucet](https://portal.cdp.coinbase.com/products/faucet). Sepolia ETH (same CDP faucet, or Base's public list) is only needed if you move funds yourself — x402 exact / EIP-3009 is facilitator-sponsored gas.
3. Set env (see [`.env.example`](.env.example) and [docs/WALLET.md](docs/WALLET.md)):

```bash
export NETWORK=base-sepolia
export FACILITATOR_URL=https://x402.org/facilitator   # public testnet facilitator, no API key
export STAGING_PAYER_PRIVATE_KEY=0xYOUR_SEPOLIA_EOA_KEY
export STAGING_PAY_TO=0xSELLER_RECEIVER
npm run sepolia-loop
```

The loop lists a tiny HTTP SKU (1000 atomic = $0.001), quotes 402, signs EIP-3009, and settles. It refuses `NETWORK=eip155:8453`. Desktop is not used here unless you run the main server with `BERTHOS_URL`. Optional later: CDP facilitator `https://api.cdp.coinbase.com/platform/v2/x402` (needs CDP auth) — not required for this loop.

If the key or `STAGING_PAY_TO` is unset, the script prints a skip and exits 0 so CI stays green without secrets.

## How this talks to Berthos

[Berthos](https://github.com/hexuria/berthos) is the VM/server computer-session node. Isolated guests only. This market **does not** run Docker or a hypervisor.

Set **`BERTHOS_URL`** to the node's loopback HTTP (default `http://127.0.0.1:7432`) and **`BERTHOS_LEASE_TOKEN`** to a pairing bearer with the `lease` capability. When `BERTHOS_URL` is set, desktop listings use `HttpBerthosEligibilityClient` (`GET /v1/eligibility`) and paid invokes use `HttpBerthosLeaseClient` (`POST /v1/leases`). Leave both unset in CI — tests use `MemoryEligibilityClient` + `MemoryLeaseClient`.

The live body is the Berthos doctor report: `ok` / `eligible`, `class`, `checks[]`, and guest image labels (`berthos.guest.version=v1`, `berthos.desktop=xvfb-openbox-chromium`, `berthos.egress.policy=default-deny`). Desktop listings **fail closed** when the client cannot reach the node, `ok` is false, `class` is `laptop` (or `host-desktop`), or the attestation / image labels are stale or missing.

### Desktop listing after `berth doctor`

On the node host (not in this repo):

```bash
docker build -t berthos-linux-desktop:v1 images/linux-desktop   # labeled guest
berth doctor --json                                             # must be eligible
berth node up                                                   # http://127.0.0.1:7432
```

Then point the market at that node and list a SKU. The market GETs `/v1/eligibility` again; a red doctor or an unreachable node is a `400`, not a retry.

```bash
export BERTHOS_URL=http://127.0.0.1:7432
export BERTHOS_LEASE_TOKEN=PASTE_FROM_POST_V1_PAIR

# Optional: inspect the same shape the market will store
curl -s "$BERTHOS_URL/v1/eligibility"

curl -s http://127.0.0.1:8787/wallets/treasury -X POST \
  -H 'content-type: application/json' \
  -d '{"label":"gpu-seller"}'

curl -s http://127.0.0.1:8787/listings -X POST \
  -H 'content-type: application/json' \
  -d '{
    "kind": "desktop.linux",
    "title": "gpu-box.session",
    "price": { "amount": "5000000", "asset": "USDC", "network": "eip155:8453" },
    "payTo": "0x1111111111111111111111111111111111111111",
    "class": "vm-guest",
    "fulfillment": {
      "berthosUrl": "http://127.0.0.1:7432",
      "sku": "linux-gpu-1",
      "nodeId": "node_01"
    },
    "eligibility": {
      "source": "berthos.doctor",
      "ok": true,
      "class": "vm-guest",
      "nodeId": "node_01",
      "attestedAt": "2026-08-23T07:00:00.000Z",
      "berthosUrl": "http://127.0.0.1:7432"
    }
  }'
```

Paid invoke then `POST`s `/v1/leases` (`os=linux` only) before settling. See the live loop below. `kind` / `class` of `laptop` or `host-desktop` is rejected even when the rest of the payload is well-formed.

### Live loop: fund, list, pay, see a lease, end, occupancy

This uses **test USDC** in the in-memory wallet. You do not need Coinbase keys, mainnet USDC, or `FACILITATOR_URL`. You do need a local Berthos node for a real guest — build / doctor / `node up` live in [hexuria/berthos](https://github.com/hexuria/berthos), not here.

On the node host:

```bash
docker build -t berthos-linux-desktop:v1 images/linux-desktop
berth doctor --json
berth node up
# pairing code printed, or:
curl -s http://127.0.0.1:7432/v1/pairing
curl -s http://127.0.0.1:7432/v1/pair \
  -H 'content-type: application/json' \
  -d '{"code":"ABCD-EFGH"}'
# → { "token": "…", "capabilities": ["operator", "lease"] }
```

In this repo (still the test facilitator + faucet):

```bash
export BERTHOS_URL=http://127.0.0.1:7432
export BERTHOS_LEASE_TOKEN=PASTE_TOKEN
npm start
```

Then fund a test wallet, list `desktop.linux` (payload above), pay, and end:

```bash
# treasury + capped agent + test USDC (not mainnet)
curl -s http://127.0.0.1:8787/wallets/treasury -X POST \
  -H 'content-type: application/json' -d '{"label":"seller"}'
curl -s http://127.0.0.1:8787/wallets/agent -X POST \
  -H 'content-type: application/json' \
  -d '{"spendCap":"5000000","label":"research-agent"}'
curl -s http://127.0.0.1:8787/wallets/WALLET_ID/fund -X POST \
  -H 'content-type: application/json' -d '{"amount":"2000000"}'

# unpaid → 402; retry with PAYMENT-SIGNATURE (tests use test:<walletId>)
curl -i http://127.0.0.1:8787/listings/LISTING_ID/invoke
# 200 body includes fulfillment.leaseId and receipt.id

curl -s http://127.0.0.1:8787/receipts/RECEIPT_ID/end -X POST
# receipt.occupancySeconds / billedSeconds (seconds, min 60s billed). Not a second charge.
```

If the node is down, ineligible, `class=laptop`, or already leased, invoke is 4xx and the agent is not debited.

## API

| Method | Path                       | Purpose                                      |
| ------ | -------------------------- | -------------------------------------------- |
| POST   | `/listings`                | Create listing (validates kind + eligibility)|
| GET    | `/listings`                | Catalog                                      |
| GET    | `/listings/:id/invoke`     | 402 quote or paid fulfillment + receipt      |
| GET    | `/receipts/:id`            | Payment receipt (lease id + occupancy)       |
| POST   | `/receipts/:id/end`        | Destroy Berthos guest; store occupancy seconds |
| POST   | `/wallets/treasury`        | Human / seller treasury                      |
| POST   | `/wallets/agent`           | Capped child                                 |
| POST   | `/wallets/:id/fund`       | Test USDC                                    |
| GET    | `/wallets/:id`             | Balance, cap, spent                          |
| GET    | `/health`                  | Liveness                                     |

## Docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — ports/adapters, x402, money
- [docs/LISTING.md](docs/LISTING.md) — schema: kind, price, payTo, policy, eligibility
- [docs/WALLET.md](docs/WALLET.md) — treasury vs agent, caps, env-flagged CDP adapter

## Design

Ports (`WalletPort`, `FacilitatorPort`, `EligibilityClient`, `LeaseClient`) keep Coinbase CDP and Berthos behind adapters. The Hono app can run under Node (vitest / `npm start`) and export as a Worker later (`src/worker.ts`).
