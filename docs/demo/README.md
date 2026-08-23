# Demo recordings (placeholder)

This directory is for **human-captured** clips of the two-role path. Nothing is recorded in CI. Do not commit large binaries (`.mp4`, `.mov`, `.webm`, screen dumps). Link an external host, or keep files local.

There are **no screenshots in this tree**. Do not add mock UI stills — the spend/earn surface is HTTP + scripts, and the host UI is another repo's CLI/console.

## Expected clips

Record each as its own short take. The product is three repos; say which window you are in.

| Clip | Where | What the viewer should see | What it is not |
| ---- | ----- | -------------------------- | -------------- |
| **1. Host parks** | [hexuria/berthos](https://github.com/hexuria/berthos) terminal | `docker build -t berthos-linux-desktop:v1 …`, green `berth doctor --json`, `berth node up` on `127.0.0.1:7432`, pairing code, `berth pair` (or `POST /v1/pair`). Node `class` is `vm-guest` or `dedicated-server`. | Renting the host desktop, Finder, or a laptop chassis as a public node. A berth-market SPA. |
| **2. Buyer pays** | this repo | Either `npm run sepolia-loop` (402 → EIP-3009 → `tx=0x…`) or `npm start` + unpaid `GET /listings/:id/invoke` (HTTP 402 + `PAYMENT-REQUIRED`) then paid retry (`PAYMENT-SIGNATURE`) → 200 + receipt. Optional: open `receipt.transaction` on [Sepolia Basescan](https://sepolia.basescan.org) and show `transferWithAuthorization` to `payTo`. | A raw `cast send`. A fake in-page ledger. Mainnet `eip155:8453`. |
| **3. Guest starts** | this repo + live Berthos node | `BERTHOS_URL` set, `desktop.linux` listing, paid invoke returns `fulfillment.leaseId`. Guest is the labeled Linux image, not the operator's cursor. | Docker/hypervisor code in berth-market. A marketplace “VM console” invented here. |
| **4. View / MCP** | [codeitlikemiley/berth](https://github.com/codeitlikemiley/berth) today | Operator console at `http://127.0.0.1:7432/`, `berth view` (node-local noVNC), and/or `berth mcp`. Say clearly this UI is **that** tree. Guest view/MCP on hexuria/berthos is **being added** — do not imply it already ships there. | A guest viewer hosted by berth-market. Charging occupancy in the node process. |

Suggested filenames if you store clips outside git: `01-host-parks`, `02-buyer-pays`, `03-guest-starts`, `04-view-mcp`.

## How to capture later

1. Follow [docs/DEMO.md](../DEMO.md) on one Linux box.
2. Keep secrets out of the frame (`STAGING_PAYER_PRIVATE_KEY`, pairing tokens).
3. Prefer a terminal + browser (Basescan, berth console) over a staged mock.
4. Add a one-line index here pointing at the hosted URL when a clip exists. Still no binary in this repo.

## Related

- Two-role steps and proven Sepolia txs: [docs/DEMO.md](../DEMO.md)
- Host commands: [hexuria/berthos README](https://github.com/hexuria/berthos/blob/main/README.md)
- Console / `berth view`: [codeitlikemiley/berth README](https://github.com/codeitlikemiley/berth/blob/main/README.md)
