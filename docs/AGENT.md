# Payment agent — accept Monero, auto-complete, no daemon

The **payment agent** is the watch-mode side of xmr-pay: a small, long-running
service the merchant runs on their own box. It builds a **view-only** wallet from
the merchant's address + private view key, hands out a **fresh subaddress per
order**, scans the chain, **sums payments**, and fires a **signed `order.paid`
webhook** the moment an order settles.

No `monero-wallet-rpc`. No custodian. The view key **never leaves the merchant's
process**, and it **cannot spend** (view-only). This is "watch mode" — the buyer
submits nothing; the merchant just watches their own subaddresses.

> Prefer zero infrastructure? Use **proof mode** instead (a stateless verify
> endpoint, see the main README) — the buyer pastes a payment proof and nothing
> runs 24/7. The agent is for merchants who want automatic detection and top-ups.

---

## What this solves

Monero adoption stalls on two sides: it's hard for **merchants** to accept, and
easy for **customers** to get wrong. Here's what each piece fixes.

### For merchants

| Problem | How the agent solves it |
|---|---|
| Accepting Monero usually means running a node **and** `monero-wallet-rpc`, or trusting a custodian | One Node process. No wallet-rpc daemon. Funds go straight to your address — **non-custodial**. |
| Handing your **view key** to a payment processor leaks every sale and is a trust risk | The view key stays **in your process**, bound to localhost. It's **view-only** — the agent refuses to start if a spend key is present. |
| Underpayments and abandoned carts create support tickets | Underpayment is detected and **summed**: the buyer tops up the difference and the order **auto-completes**. No manual reconciliation. |
| Knowing exactly **when to ship** | A **signed `order.paid` webhook** fires **exactly once**, on the pending→paid transition. Verify the HMAC, release the goods. |
| Scanning the chain is **slow** | A fresh scanner starts at the **current tip** (a payment processor never needs history) and only scans **forward**. The WASM cold start is paid **once** at boot; per-order checks are ~0.5s. |
| **Fake / time-locked** payments that look paid but can't be spent | Outputs locked by `unlock_time` (or still in the ~10-block maturation window) **never count as paid** until spendable. |
| **Replay / cross-order** confusion | Every order gets its **own subaddress**, so a payment is unambiguously attributed to exactly one order. |

### For customers (buyers)

| Problem | How it's solved |
|---|---|
| Fear of typing the **wrong amount** | The QR and the "open in wallet" link **prefill the exact amount** (`tx_amount`), in a form **every wallet parses** (Feather, GUI, CLI, Cake, Monerujo, Stack — mobile and desktop, Win/Mac/Linux). |
| **Underpaid** and stuck, not knowing what to do | A clear message — *"Detected 0.1 XMR — send 0.2 more to complete"* — plus a **QR for exactly the missing amount**. Scan, pay the difference, done. The math is **piconero-exact** (no float drift). |
| Confusing "it didn't work" errors | **Instant, specific** feedback before anything is submitted: *"that transaction ID should be 64 characters"*, *"that doesn't look like a payment proof — paste the tx key or proof block"*. |
| In watch mode, **doing extra work** (copying proofs) | Nothing to submit. The buyer just pays the address/QR; the merchant's agent detects it. |
| Trusting the checkout page | Non-custodial — **funds go directly to the merchant**. Optional **signed config + fingerprint** catches an address swap even on a compromised page. The browser **decides nothing**; the merchant's server is the source of truth. |

---

## How it works

```
merchant's box (the view key never leaves here)
┌───────────────────────────────────────────────────────────────┐
│  scanner-agent.js                                              │
│   ├─ view-only wallet  ←  primary address + private view key   │
│   │     (cannot spend — refuses to start otherwise)            │
│   ├─ per order:  newSubaddress()  →  unique address + birthday │
│   ├─ poller:     sync forward, SUM transfers, exact shortfall  │
│   └─ on paid:    signed order.paid webhook  (fires once)       │
└───────────────────────────────────────────────────────────────┘
        ▲  POST /order {amount}          │  order.paid (HMAC-signed)
        │  GET  /order/:id               ▼
   your shop backend  ───────────────▶  your fulfillment
```

The buyer is shown the order's subaddress + amount (QR). They pay — in one
transaction or several. The agent sums everything that arrives to that
subaddress; when the confirmed, spendable total covers the amount, the order is
`paid` and the webhook fires.

---

## Quickstart

Needs Node and `monero-ts` (the only non-core dependency — `npm i monero-ts`).
`monero-ts` pins two old transitive deps with advisories; patch them with npm
`overrides` in your deployment's `package.json` (recipe in
[SECURITY.md](../SECURITY.md#dependencies) — `npm audit` then reports zero).

```bash
XMR_PRIMARY_ADDRESS="4your_primary_address…" \
XMR_VIEW_KEY="your_private_view_key" \
XMR_NETWORK=stagenet \
XMR_NODES="http://node.monerodevs.org:38089" \
FULFILL_WEBHOOK_URL="https://your-shop/internal/xmr-paid" \
FULFILL_WEBHOOK_SECRET="whsec_…" \
node examples/scanner-agent.js
# → payment agent on http://127.0.0.1:8788
```

Create an order from your shop backend, show the buyer the address, poll for status:

```bash
# create
curl -s -XPOST localhost:8788/order -d '{"id":"ord_42","amount":"0.05"}'
# → {"id":"ord_42","address":"8B…","amount":"0.05","status":"pending","birthdayHeight":2140925}

# check (your backend polls, or rely on the webhook)
curl -s localhost:8788/order/ord_42
# → {"paid":false,"status":"partial","receivedXmr":0.02,"shortfallXmr":"0.03",…}
# …buyer tops up…
# → {"paid":true,"status":"paid","receivedXmr":0.05,"shortfallXmr":"0",…}
```

When `ord_42` settles, the agent POSTs a signed `order.paid` to your webhook —
verify it with `verifySignature(rawBody, secret, req.headers['x-xmr-pay-signature'])`
(`xmr-pay/webhook`) and fulfill.

### Configuration

| Variable | Required | Default | What it is |
|---|---|---|---|
| `XMR_PRIMARY_ADDRESS` | ✅ | — | your wallet's primary address |
| `XMR_VIEW_KEY` | ✅ | — | your **private view key** (view-only; cannot spend) |
| `XMR_NODES` | ✅ | — | Monero node URLs, comma-separated — your own first |
| `XMR_NETWORK` | | `mainnet` | `mainnet` · `stagenet` · `testnet` |
| `XMR_RESTORE_HEIGHT` | | tip | omit to start at "now" (instant first sync); set it only to find older payments |
| `XMR_WALLET_PATH` | | in-memory | persist the wallet so restarts skip re-scanning |
| `XMR_MIN_CONFIRMATIONS` | | `1` | raise for high-value orders (reorg safety) |
| `XMR_EXPIRY_HOURS` | | `0` | drop unpaid orders after N hours (bounds per-tick work + memory; `0` = never). A late payment still lands on-chain — it just won't auto-complete. |
| `XMR_PAID_RETENTION_HOURS` | | `0` | retire SETTLED orders after N hours (`0` = keep forever). The store/webhook is the source of truth; without this, paid orders accumulate for the agent's lifetime. `GET /order|/receipt/:id` 404s after retirement, so set it well past your buyers' poll window. |
| `POLL_MS` | | `15000` | how often the poller re-checks pending orders |
| `FULFILL_WEBHOOK_URL` / `_SECRET` | | — | where + how to sign the `order.paid` webhook |
| `AGENT_TOKEN` | | — | optional `Bearer` token required on `POST /order` |
| `BIND` / `PORT` | | `127.0.0.1` / `8788` | keep it on localhost — it holds your view key |

---

## API

- `POST /order` `{amount, id?, label?}` → `{id, address, amount, status, birthdayHeight}` — derives a fresh per-order subaddress. (Requires `Authorization: Bearer <AGENT_TOKEN>` if set.)
- `GET /order/:id` → `{paid, status, amount, receivedXmr, lockedXmr, shortfallXmr, confirmations, txids}` — live on-chain status.
- `GET /healthz` → `{ok, network, node, viewOnly, orders}`.

`status` is one of: `pending` · `partial` · `mempool` · `locked` · `paid`.
`shortfallXmr` is the **exact** amount still owed (piconero-precise; counts funds
already on-chain, including those still maturing, so a top-up prompt never asks
for too much).

---

## Trust & security

- **View-only, always.** The agent reads `getPrivateSpendKey()` and **refuses to
  start** if a spendable key is present. It can watch; it can never move funds.
- **The view key never leaves your process.** Run the agent on your own
  infrastructure, bound to `127.0.0.1` (the default). Put your shop backend in
  front; don't expose `/order` to the public internet.
- **Per-order subaddresses** isolate every order — no cross-order leakage, and a
  payment can only ever settle the order it was sent to.
- **The webhook is the trigger, signed.** Fulfill on `order.paid` after verifying
  the HMAC — never on anything client-side.
- **Privacy:** a node you query learns the subaddresses you scan and your IP/
  timing. Run your own node (list it first in `XMR_NODES`) or egress over Tor to
  close that.

---

## Proof mode or the agent — which do I want?

| | **Proof mode** (verify endpoint) | **Agent** (watch mode) |
|---|---|---|
| Infrastructure | a stateless function, runs on demand | a long-running process you host |
| Buyer effort | pastes a tx proof | nothing — just pays |
| View key | not needed | yours, in-process (view-only) |
| Partial / top-up auto-complete | manual (single-tx proofs) | **automatic** (sums transfers) |
| Best for | tips, a single product, lowest infra | a real store, installments, hands-off |

They share the same exact-math core (`summarizeTransfers`, piconero shortfalls),
so a payment counts identically either way. Many shops run the agent and keep the
proof endpoint as a dispute path.

---

## Performance & sync

- **Start at the tip.** A fresh scanner reads the current chain height and starts
  there — **0 history blocks scanned**. It only ever scans forward (~1 block per
  couple of minutes), so detection is near-instant after the first sync.
- **Cold start once.** Building the monero-ts WASM wallet + connecting is a
  one-time ~tens-of-seconds cost at boot — **not per order**. Keep the agent
  running; warm per-order checks are ~0.5s.
- **At scale**, a self-hosted [`monero-lws`](https://github.com/vtnerd/monero-lws)
  light-wallet server (same trust boundary — your view key, your box) moves
  scanning off the client entirely. The agent's transport is swappable; this is a
  future option, not required.

---

## Honest notes

- **Order state is in memory** in the reference agent. For production, persist
  orders (id → subaddress index + amount) in your own DB and re-register them on
  restart (`createOrder({ id, amount, index })` binds an existing subaddress); the
  wallet itself persists with `XMR_WALLET_PATH` so scanning resumes fast.
- **Maturation vs. time-locks.** Every confirmed output is briefly unspendable
  during Monero's ~10-block maturation — that's benign, so a confirmed payment
  counts toward `paid` at `XMR_MIN_CONFIRMATIONS`, the same as proof mode and the
  wallet-rpc watcher. Only an **explicit** `unlock_time` (the time-lock scam)
  holds an order at `locked` (with `shortfallXmr: "0"` — the buyer owes nothing).
- **Reorgs are final once fulfilled.** When `onPaid` fires, the poller treats the
  order as settled and stops re-checking it — a later reorg will **not** un-settle
  it on its own. So don't ship high-value orders at 1 conf: scale
  `XMR_MIN_CONFIRMATIONS` with value (e.g. 10), and re-`check()` manually before an
  expensive fulfillment if you want to confirm the tx is still buried.
- **Run ONE agent per view key.** `onPaid` is exactly-once *per process*. For high
  availability, run a single instance — or make your webhook receiver idempotent
  on `order_id` (and/or use shared state) so two instances can never double-fulfill.

---

## Build on it

The agent is two small, reusable pieces — embed them in your own service:

```js
const { createScanner } = require('xmr-pay/scanner');
const { createPaymentAgent } = require('xmr-pay/agent');

const scanner = await createScanner({ primaryAddress, privateViewKey, networkType, nodes });
const agent = createPaymentAgent({ scanner, minConfirmations: 1, onPaid: (o) => fulfil(o) });
agent.start();

const order = await agent.createOrder({ id: 'ord_42', amount: '0.05' });  // → { address, … }
const status = await agent.check('ord_42');                               // live: { paid, shortfallXmr, … }
```

A [GoXMR](https://goxmr.click) project · MIT.
