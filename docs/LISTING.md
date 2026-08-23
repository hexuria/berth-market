# Listing schema

A listing is something an agent can buy with USDC on Base. v1 kinds:

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
- `kind` starts with `desktop.` and there is no doctor attestation.
- `kind` starts with `desktop.` and `eligibility.ok` is not `true`.
- `kind` starts with `desktop.` and `EligibilityClient.verify` fails (fail-closed).

Eligible doctor classes: `vm`, `server`, `guest`. This repo stores that result. It does not run `doctor`.

## POST /listings

```json
{
  "kind": "http",
  "title": "weather.now",
  "description": "Current conditions",
  "price": {
    "amount": "100000",
    "asset": "USDC",
    "network": "eip155:8453"
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

`price.amount` is **atomic USDC** (6 decimals). `"100000"` is $0.10.

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
  "class": "vm",
  "fulfillment": {
    "berthosUrl": "https://node.example:8443",
    "sku": "linux-gpu-1",
    "nodeId": "node_01"
  },
  "eligibility": {
    "source": "berthos.doctor",
    "ok": true,
    "class": "vm",
    "nodeId": "node_01",
    "attestedAt": "2026-08-23T07:00:00.000Z",
    "digest": "sha256:…",
    "berthosUrl": "https://node.example:8443"
  }
}
```

Omit `eligibility` on a desktop listing and the market returns `400` with `eligibility_required`. That is fail-closed, not a retry.

## Fields

| Field          | Required                         | Notes                                                                 |
| -------------- | -------------------------------- | --------------------------------------------------------------------- |
| `kind`         | yes                              | `http` \| `mcp` \| `desktop.linux`                                    |
| `title`        | yes                              | Catalog name                                                          |
| `description`  | no                               | Shown on the x402 resource block                                      |
| `price`        | yes                              | USDC on Base only                                                     |
| `payTo`        | yes                              | Seller treasury address (0x, 20 bytes)                                |
| `policy`       | no                               | Seller-defined limits; stored, not enforced beyond documentation      |
| `endpoint`     | http / mcp                       | Where the buyer calls after paying                                    |
| `fulfillment`  | desktop                          | Berthos URL + SKU                                                     |
| `class`        | no                               | Rejected if `laptop` / `host-desktop`                                 |
| `eligibility`  | desktop **required**             | Stored Berthos doctor attestation                                     |

## Invoke

`GET /listings/:id/invoke`

- No `PAYMENT-SIGNATURE` → `402` + `PAYMENT-REQUIRED` (quote).
- Valid paid retry → `200` + `PAYMENT-RESPONSE` + receipt. Protocol cut 10%, seller 90%.
