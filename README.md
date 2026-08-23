# Berth Market

Agent spend/earn layer. Lists HTTP APIs, MCP tools, and desktop SKUs; prices them in **USDC on Base**; settles via **x402 v2**.

This repo is not a computer. Isolation, Docker, and hypervisors live in **[Berthos](https://github.com/hexuria/berthos)**. The market talks to a node over HTTP (`GET /v1/eligibility`) and rejects anything that claims `class=laptop` or `host-desktop`.

No Berth chain. No meme token. Email / AgentMail is out of v1.

## Spend / earn story

1. A human funds a **treasury** with USDC on Base.
2. An **agent wallet** is a capped child of that treasury. It can **spend** (x402) up to its cap.
3. A seller lists an HTTP endpoint, an MCP tool, or a `desktop.linux` SKU fulfilled by a Berthos node (later W365).
4. The agent calls `GET /listings/:id/invoke` unpaid → **HTTP 402** + `PAYMENT-REQUIRED` quote.
5. The agent retries with `PAYMENT-SIGNATURE`. The test facilitator (or a live x402 facilitator) verifies and settles.
6. The market returns **200 + receipt**. The seller treasury **earns 90%**. The protocol treasury takes **10%**.

```
treasury (human) ──cap──► agent ──402 / pay──► listing ──90%──► seller payTo
                                                      └──10%──► protocol
```

## Quick start

```bash
npm install
npm test
npm run earn-loop    # one fake USDC 402 → pay → earn cycle
npm start            # http://127.0.0.1:8787
```

CI needs no secrets. The default adapters are in-memory + a test x402 facilitator. `BERTHOS_URL`, `FACILITATOR_URL`, and `WALLET_ADAPTER=cdp` are opt-in and unused in CI.

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
    "price": { "amount": "100000", "asset": "USDC", "network": "eip155:8453" },
    "payTo": "0x1111111111111111111111111111111111111111",
    "endpoint": { "url": "https://api.example.com/weather", "method": "GET" }
  }'
```

`price.amount` is atomic USDC (6 decimals). `"100000"` is $0.10.

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

## How this talks to Berthos

[Berthos](https://github.com/hexuria/berthos) is the VM/server computer-session node. Isolated guests only. This market **does not** run Docker or a hypervisor.

Set **`BERTHOS_URL`** to the node's loopback HTTP (default `http://127.0.0.1:7432`). When it is set, desktop listings are re-checked with `HttpBerthosEligibilityClient` against `GET $BERTHOS_URL/v1/eligibility`. Leave it unset in CI — tests use `MemoryEligibilityClient`.

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

`kind` / `class` of `laptop` or `host-desktop` is rejected even when the rest of the payload is well-formed.

## API

| Method | Path                       | Purpose                                      |
| ------ | -------------------------- | -------------------------------------------- |
| POST   | `/listings`                | Create listing (validates kind + eligibility)|
| GET    | `/listings`                | Catalog                                      |
| GET    | `/listings/:id/invoke`     | 402 quote or paid fulfillment + receipt      |
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

Ports (`WalletPort`, `FacilitatorPort`, `EligibilityClient`) keep Coinbase CDP and Berthos behind adapters. The Hono app can run under Node (vitest / `npm start`) and export as a Worker later (`src/worker.ts`).
