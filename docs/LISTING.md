# Listing schema

A listing is something an agent can buy with USDC on Base (`eip155:8453`) or Base Sepolia staging (`eip155:84532` / `base-sepolia`). v1 kinds:

| `kind`          | What it is                                      | Eligibility                         |
| --------------- | ----------------------------------------------- | ----------------------------------- |
| `http`          | Paid HTTP API                                   | Optional                            |
| `mcp`           | Paid MCP tool                                   | Optional                            |
| `desktop.linux` | Desktop SKU fulfilled by a Berthos node         | **Required** (Berthos doctor)       |

Later: `desktop.w365` (same eligibility rules). Never a laptop. Never the host desktop.

## Hard rejects

The market **must** reject a listing when any of these is true:

- `kind` is `laptop`, `host-desktop`, `desktop.laptop`, or any alias of those.
- Top-level `class` is `laptop` or `host-desktop`.
- `eligibility.class` is `laptop` or `host-desktop`.
- `kind` starts with `desktop.` and there is no stored attestation.
- `kind` starts with `desktop.` and `eligibility.ok` is not `true`.
- `kind` starts with `desktop.` and the attestation is stale (older than 24h by default).
- `kind` starts with `desktop.` and `EligibilityClient.verify` fails (fail-closed): node unreachable, `GET /v1/eligibility` says `ok`/`eligible` is false, class is laptop, or guest image labels are stale/missing.

Eligible doctor classes: `vm-guest`, `dedicated-server` (Berthos), plus market aliases `vm`, `server`, `guest`. This repo stores that result. It does not run `doctor` or Docker.

## POST /listings

```json
{
  "kind": "http",
  "title": "weather.now",
  "description": "Current conditions",
  "price": {
    "amount": "1000",
    "asset": "USDC",
    "network": "eip155:84532"
  },
  "payTo": "0x1111111111111111111111111111111111111111",
  "policy": {
    "maxInvocationsPerDay": 1000,
    "notes": "fair-use"
  },
  "endpoint": {
    "url": "https://api.example.com/weather",
    "method": "GET"
  }
}
```

`price.amount` is **atomic USDC** (6 decimals). `"100000"` is $0.10. Staging examples use `eip155:84532` (or alias `base-sepolia`). Mainnet listings still accept `eip155:8453`. Do not send a Sepolia payer at a 8453 quote.

### MCP

```json
{
  "kind": "mcp",
  "title": "search.web",
  "price": { "amount": "250000", "asset": "USDC", "network": "eip155:8453" },
  "payTo": "0x1111111111111111111111111111111111111111",
  "endpoint": {
    "url": "https://mcp.example.com/sse",
    "method": "POST",
    "tool": "search"
  }
}
```

### Desktop (Berthos)

```json
{
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
}
```

Create the listing **after** `berth doctor` is green and `berth node up` is listening. Set `BERTHOS_URL` (and `fulfillment.berthosUrl` / `eligibility.berthosUrl`) to that node. The market GETs `/v1/eligibility` and stores `{ ok, class, checks, image labels }`.

Omit `eligibility` on a desktop listing and the market returns `400` with `eligibility_required`. That is fail-closed, not a retry.

## Fields

| Field          | Required                         | Notes                                                                 |
| -------------- | -------------------------------- | --------------------------------------------------------------------- |
| `kind`         | yes                              | `http` \| `mcp` \| `desktop.linux`                                    |
| `title`        | yes                              | Catalog name                                                          |
| `description`  | no                               | Shown on the x402 resource block                                      |
| `price`        | yes                              | USDC; `network` is `eip155:8453` or `eip155:84532` / `base-sepolia`   |
| `payTo`        | yes                              | Seller treasury address (0x, 20 bytes)                                |
| `policy`       | no                               | Seller-defined limits; stored, not enforced beyond documentation      |
| `endpoint`     | http / mcp                       | Where the buyer calls after paying                                    |
| `fulfillment`  | desktop                          | Berthos URL + SKU; optional `leaseToken` (never echoed)               |
| `class`        | no                               | Rejected if `laptop` / `host-desktop`                                 |
| `eligibility`  | desktop **required**             | Stored Berthos `GET /v1/eligibility` attestation                      |

## Invoke

`GET /listings/:id/invoke`

- No `PAYMENT-SIGNATURE` → `402` + `PAYMENT-REQUIRED` (quote).
- Valid paid retry → `200` + `PAYMENT-RESPONSE` + receipt. Protocol cut 10%, seller 90%.
- A replayed nonce is `402` **before** a second debit or a second lease.

### `desktop.linux` (pay then occupy)

Settlement waits until the Berthos node accepts a lease. Order:

1. Verify the x402 payload (read-only).
2. Reject if the payment nonce was already settled (no silent double charge).
3. Re-check `EligibilityClient` (fail-closed: unreachable, `ok=false`, `class=laptop` / host-desktop, stale attestation).
4. `POST /v1/leases` `{ "os": "linux" }` with the pairing bearer (`BERTHOS_LEASE_TOKEN` or `fulfillment.leaseToken`).
5. Only then `FacilitatorPort.settle` and the 90/10 wallet debit.
6. Persist `receipt.leaseId` + `berthosUrl`. The 200 `fulfillment` block includes `leaseId` so the buyer knows the guest exists.

If the node is unreachable, ineligible, `class=laptop`, or create returns 409 (already leased), invoke is **4xx and does not charge**. If settle fails after create, the market `DELETE`s the lease (abort) and still does not debit.

Berthos quotes occupancy seconds with `charged_here: false`. That is **not** a second x402. End the session:

```bash
curl -s http://127.0.0.1:8787/receipts/RECEIPT_ID/end -X POST
```

`DELETE $BERTHOS_URL/v1/leases/{id}` runs on the node. The receipt stores `occupancySeconds` / `billedSeconds` (minimum 60s billed on the node). Repeating end is idempotent and does not charge again.

`kind` / `class` of `laptop` or `host-desktop` is still rejected at list time and again at invoke.
