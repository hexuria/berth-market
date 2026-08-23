# Berth Market

Agent spend/earn layer. Lists HTTP APIs, MCP tools, and desktop SKUs; prices them in **USDC on Base**; settles via **x402 v2**.

This repo is not a computer. Isolation, Docker, and hypervisors live in **[Berthos](https://github.com/hexuria/berthos)**. The market stores a Berthos doctor attestation and rejects anything that claims `class=laptop` or `host-desktop`.

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

CI needs no secrets. The default adapters are in-memory + a test x402 facilitator.

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

MCP uses `kind: "mcp"` and `endpoint.tool`. Desktop uses `kind: "desktop.linux"` plus a Berthos doctor attestation — see [docs/LISTING.md](docs/LISTING.md).

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

[Berthos](https://github.com/hexuria/berthos) is the VM/server computer-session node. Isolated guests only.

- A desktop listing includes `fulfillment.berthosUrl` (where the node lives) and `eligibility` (what `doctor` already proved).
- This market **does not** run isolation. It **stores** the attestation and **fails closed** if it is missing, `ok: false`, or the doctor is unreachable.
- `EligibilityClient` is a port. Tests use `MemoryEligibilityClient`. Production uses `HttpBerthosEligibilityClient` (`BERTHOS_URL` + `/doctor`).

If a listing claims `class=laptop` or `host-desktop`, it is rejected even when the rest of the payload is well-formed.

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
- [docs/WALLET.md](docs/WALLET.md) — treasury vs agent, caps, CDP TODO

## Design

Ports (`WalletPort`, `FacilitatorPort`, `EligibilityClient`) keep Coinbase CDP and Berthos behind adapters. The Hono app can run under Node (vitest / `npm start`) and export as a Worker later (`src/worker.ts`).
