# Two-role demo

This is the honest walkthrough. There is **no polished spend/earn app** in this repo. The market surface is HTTP on `:8787` (`npm start`) plus two scripts (`npm run earn-loop`, `npm run sepolia-loop`). Isolation lives in **[hexuria/berthos](https://github.com/hexuria/berthos)**. The existing human console and `berth view` live in **[codeitlikemiley/berth](https://github.com/codeitlikemiley/berth)** — guest view/MCP is being added on berthos; do not expect that UI here.

```
Role A — Host                    Role B — Buyer
park a computer                  pay to use a listing
hexuria/berthos CLI              this repo: HTTP + loops
berth doctor / node up / pair    402 → PAYMENT-SIGNATURE → receipt
never host-desktop / laptop      POST /receipts/:id/end (desktop only)
```

| Claim                                              | Actual state                                                                                          |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Spend/earn UI                                      | HTTP + scripts. No marketplace SPA.                                                                   |
| Host / park UI                                     | [hexuria/berthos](https://github.com/hexuria/berthos) CLI (`berth doctor`, `berth node up`, pair).     |
| Guest view / MCP                                   | Being added on berthos. Full console + `berth view` already exist on [codeitlikemiley/berth](https://github.com/codeitlikemiley/berth). |
| Staging chain                                      | Base Sepolia `eip155:84532`. Public facilitator `https://x402.org/facilitator`.                       |
| On-chain transfer (public facilitator)             | **100%** to `payTo`. 90/10 is **receipt accounting** (`onChainSettlement=payTo_100`).                 |
| CDP wallets                                        | Wired via `@coinbase/cdp-sdk` when `WALLET_ADAPTER=cdp` **and** the three keys are set. Default + CI stay `MemoryWalletAdapter`. Live network is Sepolia unless `NETWORK`/`CDP_NETWORK` is explicitly `base`. Staging loop forces `WALLET_ADAPTER=memory`. |
| This repo runs Docker / a hypervisor               | **No.**                                                                                               |

Screen-recording placeholders (no binaries in git): [docs/demo/README.md](demo/README.md).

---

## Role A — Host / parking a computer

Do this in **[hexuria/berthos](https://github.com/hexuria/berthos)**, not here. Follow that repo's [README](https://github.com/hexuria/berthos/blob/main/README.md). This market does not build a guest image and does not start a node.

**Never rent the host desktop or a laptop.** `class=laptop` and `host-desktop` are rejected on the node and again when this process lists or invokes `desktop.linux`.

On the parked box (Linux + Docker + a Rust toolchain):

```bash
git clone https://github.com/hexuria/berthos.git
cd berthos
cargo install --path crates/berthos-cli   # command name is `berth`

docker build -t berthos-linux-desktop:v1 images/linux-desktop
berth doctor --json                       # must be eligible; exit 1 if red
berth node up                             # http://127.0.0.1:7432 — loopback only
# pairing code printed, e.g. ABCD-EFGH

berth pair --code ABCD-EFGH
# or:
curl -s http://127.0.0.1:7432/v1/pair \
  -H 'content-type: application/json' \
  -d '{"code":"ABCD-EFGH"}'
# → { "token": "…", "capabilities": ["operator", "lease"] }
```

The doctor will not pass without the labeled guest image (`berthos.guest.version=v1`, `berthos.desktop=xvfb-openbox-chromium`, `berthos.egress.policy=default-deny`). `berth node up --bind 0.0.0.0` is rejected.

Export the **lease** bearer into this repo when you want a paid desktop SKU:

```bash
export BERTHOS_URL=http://127.0.0.1:7432
export BERTHOS_LEASE_TOKEN=PASTE_FROM_POST_V1_PAIR
```

Leave both unset for CI and for HTTP-only loops. Occupancy quotes printed by berthos are seconds, not a charge. Money is this process.

**Human UI for park / view:** the full operator console (`http://127.0.0.1:7432/`) and `berth view` (node-local noVNC) are on [codeitlikemiley/berth](https://github.com/codeitlikemiley/berth) — see that README's "Human path (console)" and `berth view`. hexuria/berthos is the slim portable node (doctor, loopback HTTP, labeled guest). Do not look for a catalog or a wallet in either node repo.

---

## Role B — Buyer / paying to use

This repo. Two honest paths:

| Path                         | What settles                         | Chain?        |
| ---------------------------- | ------------------------------------ | ------------- |
| `npm run earn-loop`          | In-process `TestFacilitator` + fake USDC | No         |
| `npm start` + curl           | Same test facilitator unless `FACILITATOR_URL` is set | No (CI default) |
| `npm run sepolia-loop`       | Real Base Sepolia USDC via `LiveFacilitator` | Yes, testnet |

`sepolia-loop` lists a tiny **HTTP** SKU only. A `desktop.linux` pay needs `npm start` with `BERTHOS_URL` and a live node (Role A).

### HTTP SKU (no Berthos)

```bash
npm install
npm start    # http://127.0.0.1:8787
```

List, quote, pay, read the receipt:

```bash
# 1. Catalog entry — seller treasury is payTo
curl -s http://127.0.0.1:8787/listings -X POST \
  -H 'content-type: application/json' \
  -d '{
    "kind": "http",
    "title": "weather.now",
    "price": { "amount": "1000", "asset": "USDC", "network": "eip155:84532" },
    "payTo": "0x1111111111111111111111111111111111111111",
    "endpoint": { "url": "https://api.example.com/weather", "method": "GET" }
  }'
# → listing.id  (lst_…)

# 2. Unpaid invoke → HTTP 402 + PAYMENT-REQUIRED (x402 v2 quote)
curl -i http://127.0.0.1:8787/listings/LISTING_ID/invoke

# 3. Retry with PAYMENT-SIGNATURE (tests / earn-loop use test:<walletId>)
# 4. 200 + PAYMENT-RESPONSE + receipt { transaction, sellerAtomic 90%, protocolAtomic 10% }

curl -s http://127.0.0.1:8787/receipts/RECEIPT_ID
```

`POST /receipts/:id/end` on an HTTP receipt is `400 no_lease` — there is no guest to destroy. That route is for desktop.

One-command fake cycle (no keys, no chain):

```bash
npm run earn-loop
```

### `desktop.linux` (needs Role A)

After `BERTHOS_URL` + `BERTHOS_LEASE_TOKEN` and `npm start`, list a SKU the market will re-check against `GET /v1/eligibility`. Payload shape is in [LISTING.md](LISTING.md) and the README. Then:

```bash
curl -i http://127.0.0.1:8787/listings/LISTING_ID/invoke
# unpaid → 402; paid → 200 + fulfillment.leaseId + receipt.id

curl -s http://127.0.0.1:8787/receipts/RECEIPT_ID/end -X POST
# occupancySeconds / billedSeconds (min 60s billed). Not a second x402.
```

Unreachable node, red doctor, `class=laptop`, or 409 already-leased → 4xx and **no charge**. Paid invoke creates the Berthos lease **before** settle; a failed settle aborts the guest.

### Staging: `npm run sepolia-loop`

This is **Base Sepolia** (`eip155:84532`), not Base mainnet (`eip155:8453`). The script refuses `NETWORK=eip155:8453` / `base`. Never commit keys. The process never logs the private key.

1. Throwaway EOA. Fund **Base Sepolia USDC** from the [Circle faucet](https://faucet.circle.com) or the [Coinbase CDP faucet](https://portal.cdp.coinbase.com/products/faucet). Sepolia ETH is optional — x402 exact / EIP-3009 is facilitator-sponsored gas.
2. Set env (see [`.env.example`](../.env.example) and [WALLET.md](WALLET.md)):

```bash
export NETWORK=base-sepolia
export FACILITATOR_URL=https://x402.org/facilitator   # public, no API key
export STAGING_PAYER_PRIVATE_KEY=0xYOUR_SEPOLIA_EOA_KEY
export STAGING_PAY_TO=0xSELLER_RECEIVER               # 100% of the on-chain USDC
npm run sepolia-loop
```

Amount is `1000` atomic USDC (`$0.001`). If the key or `STAGING_PAY_TO` is unset, the script prints a skip and **exits 0** so CI stays secret-free.

What the script does (see [How we know this is our repo](#how-we-know-this-is-our-repo)):

1. `createApp` with `LiveFacilitator` + `WALLET_ADAPTER=memory`.
2. `POST /listings` — HTTP SKU `sepolia.staging.ping`, `payTo=STAGING_PAY_TO`.
3. Unpaid `GET /listings/:id/invoke` → **402**.
4. Sign EIP-3009 `TransferWithAuthorization` (`src/staging/signer.ts`).
5. Paid invoke → Hono → `LiveFacilitator` `POST /verify` + `POST /settle`.
6. Print `listing`, `payer`, `payTo`, `tx=` (facilitator settle hash). Receipt stores 90/10 and `onChainSettlement=payTo_100`.

### Verify on Basescan that the facilitator sent USDC to `payTo`

Use the `tx=` hash from the loop (or `receipt.transaction`). Open it on [Base Sepolia Basescan](https://sepolia.basescan.org):

`https://sepolia.basescan.org/tx/<receipt.transaction>`

Check, in order:

| What                    | Must be                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------ |
| Network                 | Base Sepolia (chain id **84532**)                                                                |
| `To`                    | Circle USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e`                                         |
| Method                  | `transferWithAuthorization` (selector `0xe3ee160e`)                                              |
| Tx `From`               | The **facilitator relayer**, not the payer EOA. The payer did not submit this tx and paid no gas. |
| Native `Value`          | `0` ETH — this is not a raw ETH send                                                             |
| ERC-20 Transfer         | `1000` atomic = `0.001` USDC, **from** the payer **to** `STAGING_PAY_TO`                         |
| `AuthorizationUsed` log | On the same USDC contract — EIP-3009, not `transfer()`                                           |

A raw `cast send` from the payer would show `From =` that EOA (they paid gas) and usually `transfer()` or a native send. That is **not** this path. See the proven rows below.

---

## How we know this is our repo

A Basescan transfer by itself does not prove a marketplace. These payments went through **this tree**: `npm run sepolia-loop` → `src/staging/loop.ts` → Hono routes → `LiveFacilitator` `POST /settle`. A raw wallet transfer is a different transaction shape.

### Code path (not `cast send`)

```
src/scripts/sepolia-loop.ts
        │
        ▼
src/staging/loop.ts
  POST /listings          → listing id lst_…   (newId("lst") in src/adapters/ids.ts)
  GET  /listings/:id/invoke (no header)        → HTTP 402 + PAYMENT-REQUIRED
  src/staging/signer.ts   EIP-3009 exact/EVM
  GET  /listings/:id/invoke + PAYMENT-SIGNATURE
        │
        ▼
src/http/routes.ts        verify, then facilitator.settle(...)
        │
        ▼
src/adapters/live-facilitator.ts
  POST {FACILITATOR_URL}/verify
  POST {FACILITATOR_URL}/settle     ← public facilitator submits the tx
        │
        ▼
receipt.transaction = settle hash   MemoryWallet is not debited
```

`src/staging/loop.ts` builds an in-process Hono app and calls `app.request`. It does not shell out to `cast`, `viem` `sendTransaction`, or a wallet UI. The only chain I/O is the facilitator's `transferWithAuthorization` after `POST /settle`.

What you will **not** find on that path:

- `cast send`
- A native ETH transfer (`value > 0`)
- A payer-submitted `transfer()` (payer as tx `from`)
- A second on-chain 10% hop to a protocol treasury

Listing ids (`lst_` + 20 hex) are minted in this process. They are **not** written to Base. The on-chain proof is the EIP-3009 USDC move; the catalog proof is the loop log line `listing lst_…` from the same run.

### Proven Base Sepolia txs created by `src/staging/loop.ts`

Payer `0xa2558A90D8cc626683b5d866b672cd192F743283`. Seller / `payTo` `0xA8351b9de3Bd0b6c6D7256d5E1D3f1Dc87eD0365`. Public facilitator relayer observed as tx `from`: `0xd407e409e34e0b9afb99ecceb609bdbcd5e7f1bf` (that key can rotate; trust the method + Transfer logs, not a frozen relayer address).

| Run        | Listing (this process)     | Tx                                                                 | On-chain Transfer                                      |
| ---------- | -------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------ |
| self-pay   | `lst_dd647c00613141948a1f` | [0x6f07…49d6](https://sepolia.basescan.org/tx/0x6f07e0da2d72d7f57a5e5e8434d1127de622e0c9d0dfde5326231326938249d6) | 1000 atomic USDC payer → **same** payer (`payTo` = payer) |
| payer→seller | `lst_18e219779fb14a10bd3c` | [0x84d7…03f7](https://sepolia.basescan.org/tx/0x84d715ab97fa0bb923bcd093c86729e45f64c43675e60a81258d2e4bba6d03f7) | 1000 atomic USDC payer → seller                      |

Both txs: `to` = Sepolia USDC, selector `0xe3ee160e` (`transferWithAuthorization`), `value = 0`, `AuthorizationUsed` + `Transfer` on `0x036CbD…CF7e`. That is the public x402 facilitator executing the authorization this repo signed, not a raw EOA send.

CI cannot replay these without secrets. `npm run sepolia-loop` without keys **skips** (exit 0). `test/staging.test.ts` mocks `fetch` so `LiveFacilitator` never hits the network in CI.

---

## Reproduce checklist (one Linux box + Docker)

Docker is for **Role A** (berthos guest image). This repo is Node 22 + npm. You do not add Docker to berth-market.

### Market only (no keys, no Docker)

- [ ] `git clone https://github.com/hexuria/berth-market.git && cd berth-market`
- [ ] `npm ci && npm test && npm run earn-loop && npm run sepolia-loop`
- [ ] `sepolia-loop` prints a skip and exits 0 (no `STAGING_*` keys — expected)
- [ ] `npm start` → `curl -s http://127.0.0.1:8787/health`

### Staging pay (optional; your throwaway key, never committed)

- [ ] Fund a Sepolia EOA with testnet USDC (faucets above)
- [ ] Export `NETWORK`, `FACILITATOR_URL`, `STAGING_PAYER_PRIVATE_KEY`, `STAGING_PAY_TO` in the **shell only**
- [ ] `npm run sepolia-loop` → `tx=0x…`
- [ ] Open that hash on Basescan and tick the [verify table](#verify-on-basescan-that-the-facilitator-sent-usdc-to-payto)

### Host park (separate clone; Docker + Rust)

- [ ] Clone [hexuria/berthos](https://github.com/hexuria/berthos) and follow its [README](https://github.com/hexuria/berthos/blob/main/README.md)
- [ ] `docker build -t berthos-linux-desktop:v1 images/linux-desktop`
- [ ] `berth doctor --json` green
- [ ] `berth node up` on `127.0.0.1:7432`
- [ ] Pair; confirm `class` is not `laptop`
- [ ] Optional human UI: [codeitlikemiley/berth](https://github.com/codeitlikemiley/berth) console at `http://127.0.0.1:7432/` and `berth view` — [console docs](https://github.com/codeitlikemiley/berth/blob/main/docs/CONSOLE.md)

### Paid desktop (this process + live node)

- [ ] `export BERTHOS_URL=http://127.0.0.1:7432` and `BERTHOS_LEASE_TOKEN=…`
- [ ] `npm start` in berth-market
- [ ] `POST /listings` `kind=desktop.linux` with a stored doctor attestation ([LISTING.md](LISTING.md))
- [ ] Unpaid invoke → 402; paid invoke → `leaseId` + receipt
- [ ] `POST /receipts/:id/end` → occupancy seconds, `chargedHere: false`
- [ ] Confirm host desktop / cursor were not the guest

### Do not

- [ ] Commit private keys or paste them into logs / issues
- [ ] Set `NETWORK=eip155:8453` for staging
- [ ] Treat `MemoryWallet` or `earn-loop` balances as Sepolia USDC
- [ ] Treat `cast send` as the market settle path
- [ ] List or rent `laptop` / `host-desktop`

---

## Related

- [ARCHITECTURE.md](ARCHITECTURE.md) — ports, x402 headers, 90/10
- [WALLET.md](WALLET.md) — treasury vs agent, staging env, env-flagged CDP adapter
- [LISTING.md](LISTING.md) — `http` / `mcp` / `desktop.linux` schema
- [hexuria/berthos README](https://github.com/hexuria/berthos/blob/main/README.md) — doctor, node, pair
- [codeitlikemiley/berth README](https://github.com/codeitlikemiley/berth/blob/main/README.md) — console + `berth view` + MCP
