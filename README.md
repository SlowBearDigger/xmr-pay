<p align="center">
  <img src="https://raw.githubusercontent.com/SlowBearDigger/xmr-pay/main/assets/monero-symbol.png" width="76" alt="Monero">
</p>

<h1 align="center">xmr-pay</h1>

<p align="center">
  <b>Sovereign Monero payments</b> — Stripe, but self-hosted and nobody's customer.<br>
  Payment links, QR codes, an embeddable checkout widget, and on-chain payment detection.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/xmr-pay"><img src="https://img.shields.io/npm/v/xmr-pay?color=FF6600&label=npm" alt="npm version"></a>
  <img src="https://img.shields.io/badge/license-MIT-FF6600" alt="MIT license">
  <img src="https://img.shields.io/badge/runtime%20deps-0-FF6600" alt="zero runtime dependencies">
  <img src="https://img.shields.io/badge/releases-signed-FF6600" alt="signed releases">
</p>

<p align="center">
  <a href="#install"><b>Install</b></a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#checkout-widget">Widget</a> ·
  <a href="#proof-mode">Proof mode</a> ·
  <a href="#watch-mode">Watch mode</a> ·
  <a href="#webhooks">Webhooks</a> ·
  <a href="#security-and-trust">Security</a> ·
  <a href="docs/AGENT.md">Agent guide&nbsp;↗</a>
</p>

---

**No accounts. No API keys. No CDN. No third party in the payment path.** You hold
the address, you choose the nodes, you run the (tiny, optional) server piece.
xmr-pay is code, not a service.

The widget, payment links, and QR are pure browser — no server. *Detecting* a
payment runs on a server **you** control (a serverless function or your own box),
never in the buyer's browser and never on ours. A tips button needs no server at
all; a store needs one small piece. Trustless detection just has to talk to a
Monero node from somewhere you trust.

## Install

```
npm i xmr-pay monero-ts        # monero-ts only needed for server-side detection
```

**Run the agent in one command** (non-custodial — it holds only your view key):

```
npx xmr-pay        # setup wizard (address + view key + node), then it runs
```

It scans from the current block (no historical rescan), generates the token + webhook secret, asks your **settlement speed** (`instant` 0-conf · `fast` 1 block · `secure` 10 blocks), persists its wallet + orders, and prints the exact values to paste into your store. `npx xmr-pay start` runs it again later.

Donations welcome, no obligation:
`42w9YaCW8UwZ2BmQztNmUd6JgYVcjW7LXEMTcQqHdmtFCsSo5RGY2eQg2iZ3WyBSSs63gnhczLkJ46yfr4ojCXWT3H1ZBbR`

## How it works

| Module | Runs | Purpose |
|---|---|---|
| `xmr-pay/core` | browser + server | payment URIs (links), QR as SVG, per-order amount nonces |
| `xmr-pay` (verify) | your backend / serverless fn | re-verify a buyer's tx proof on-chain — trustless |
| `xmr-pay/watch` | your backend | auto-detection through your own monero-wallet-rpc |
| `xmr-pay/scanner` | your backend | view-only WASM scanner — auto-detection with NO wallet-rpc daemon |
| `xmr-pay/agent` | your backend | long-running order manager: per-order subaddress, summing, signed paid webhook |
| `xmr-pay/config` | offline + browser | signed merchant configs, tamper-evident addresses |
| `xmr-pay/webhook` | your backend | signed fulfillment webhooks to YOUR systems |
| `widget/xmr-pay.js` | browser | full checkout UI — one self-hosted file, zero dependencies |

**Two detection modes, freely combined:**

| | **Proof mode** (default) | **Watch mode** |
|---|---|---|
| Infra (yours) | a stateless verify endpoint, on demand | a long-running process you host |
| Buyer effort | pastes txid + proof | none — just pays |
| View key | not needed | yours, in-process (view-only) |
| Partial / top-up auto-complete | manual (single-tx proofs) | **automatic** — sums transfers |
| Best for | tips, a single product, lowest infra | a real store, installments, hands-off |

```
proof mode (no always-on process; your verify endpoint runs on demand):
  buyer's browser:  pays ─▶ wallet makes a tx proof ─▶ widget POSTs {txid, proof}
  YOUR server:      ─▶ verify endpoint ─▶ verifyPayment re-checks on YOUR nodes ─▶ paid

watch mode (the agent — no monero-wallet-rpc needed):
  order ─▶ fresh subaddress ─▶ buyer pays ─▶ your agent scans + SUMS transfers
        ─▶ paid (handles partial / split / top-up payments) ─▶ signed order.paid webhook
```

They share the same exact-math core, so a payment counts identically either way.
Many shops run watch mode and keep proof as a dispute path. Watch mode is
documented in full in **[docs/AGENT.md](docs/AGENT.md)**.

## Checkout widget

One self-hosted file (`widget/xmr-pay.js`, ~98 KB, bundles its own QR encoder —
no external requests, ever). Drop it in and you have a Monero checkout.

```html
<script src="/xmr-pay.js"></script>

<!-- tips / donations — nothing else needed -->
<xmr-pay address="4YOUR_ADDRESS…" label="Buy me a coffee"></xmr-pay>

<!-- store checkout — detection against YOUR endpoint -->
<xmr-pay
  address="4YOUR_ADDRESS…"
  amount="0.050000004821"
  order="ord_123"
  verify-url="/api/verify-payment"
  theme="light" lang="en"></xmr-pay>
```

<details>
<summary><b>Attributes, events, skins, error feedback</b></summary>

What the buyer gets: amount + QR (generated locally, with the exact `tx_amount`
prefilled so wallets can't be sent the wrong amount) + click-to-copy address with
a highlighted fingerprint + "open in wallet" deep link + an always-there **trust
panel** + a **"paid? prove it"** panel that submits txid + tx proof to your
endpoint.

**Attributes:** `address` (required unless `config` is set) · `amount` · `label` ·
`order` · `verify-url` · `redirect-url` · `lang` (`en`/`es`) · `theme` (`light`)
· `skin` (`brutal`) · `config` (base64 signed envelope) · `fingerprint`/`pubkey`
(pin the signer).
**Events:** `xmr-pay:paid`, `xmr-pay:result` (CustomEvent, verify result in `detail`).

**Buyer-error feedback (built in).** Bad txid → *"that transaction ID should be 64
characters"*; not a proof → *"paste the tx key or the proof block from your
wallet"* — caught instantly, before any server round-trip. **Underpaid** → *"Detected
0.1 XMR — send 0.2 more to complete"* plus a fresh **QR for exactly the missing
amount** (piconero-exact, no float drift). The proof box also smart-pastes a whole
Feather block and picks out the txid + proof itself.

**Skins.** Default is a neutral, universal look (system sans, rounded, soft
shadows). `skin="brutal"` is the GOXMR brand look (monospace, square, hard
shadow). Both are driven by `--xp-*` CSS variables, so any brand can retheme
without forking.

</details>

## Payment links

A payment link is just a URL. Host [examples/pay-link.html](examples/pay-link.html)
anywhere static and share:

```
https://your-site.com/pay-link.html#address=4…&amount=0.05&label=Invoice%2042
```

<details>
<summary><b>monero: URIs, wallet compatibility, short links</b></summary>

`core.makePaymentURI()` builds the `monero:` URI (also what the widget's QR and
"open in wallet" use). The URIs are round-trip tested against the **official
wallet2 parser** — what GUI, CLI and Feather run internally — including 12-decimal
nonce amounts and unicode descriptions, so they prefill cleanly across Feather,
GUI, CLI, Cake, Monerujo and Stack (mobile + desktop, Win/Mac/Linux).

Prefer the `#fragment` form for shared links — fragments never reach server logs
or proxies. Truly short URLs (`/p/x7k2`) need a lookup; add a redirect route on
your own server rather than a third-party shortener that would track your buyers.

Buyer-side wallet instructions (Feather/GUI/Cake/CLI menu names, restored-seed
caveat): **[docs/WALLETS.md](docs/WALLETS.md)**.

</details>

## Order creation (amount-nonce)

```js
const { makeAmountNonce } = require('xmr-pay/core');
const amount = makeAmountNonce('0.05');   // '0.050000004821' — unique per order
// store { order_id, amount } in YOUR db; render the widget with that amount
```

The random piconero tail makes each order's on-chain amount unique, so a proof
structurally fits only its own order — a secondary anti-replay guard on top of
your txid dedup. The added value is dust (default ≤ 0.000001 XMR).

## Proof mode

The only server piece, and it's yours — stateless, runs on demand.

```js
const { verifyPayment } = require('xmr-pay');

const r = await verifyPayment({
  txid, proof,                       // what the buyer pasted (tx key or tx proof — auto-detected)
  address: order.address,
  amount: order.amount_xmr,          // string keeps 12-decimal nonces exact
  nodes: ['https://your-node:18081', 'https://fallback:18081'],
  minConfirmations: 1,               // 0 accepts mempool — your risk, your call
  quorum: 1,                         // 2+ = independent nodes must agree
  alreadyUsed: (txid) => db.txidSeen(txid),
});
// { paid, status, reason, receivedXmr, expectedXmr, shortfallXmr, confirmations,
//   txid, nodesAgreed, overpaid }   — txid comes back normalized (lowercase)
```

Full endpoint with anti-spam gates: [examples/serverless.js](examples/serverless.js).
Drop it in Vercel/Netlify/Express — stateless; your orders table is the only
state and it's already yours. One-click deploy template: **[docs/DEPLOY.md](docs/DEPLOY.md)**.

<details>
<summary><b>No <code>monero-ts</code>? Verify through your wallet-rpc</b></summary>

If you already run `monero-wallet-rpc`, `verifyPaymentViaRpc` checks the same
proofs through it — same gates, same result shape, **no WASM peer to install** (so
none of `monero-ts`'s transitive advisories; see SECURITY.md):

```js
const { verifyPaymentViaRpc } = require('xmr-pay/watch');
const r = await verifyPaymentViaRpc({
  url: 'http://127.0.0.1:18083',     // your monero-wallet-rpc
  txid, proof, address: order.address, amount: order.amount_xmr,
  nodes: ['https://your-node:18081'], // for the time-lock gate if the wallet has no record of the tx
});
```

</details>

## Watch mode

Automatic detection: a fresh subaddress per order, payments **summed** (so partial
payments and top-ups auto-complete), the buyer submits nothing. Two transports —
your own `monero-wallet-rpc`, or a **view-only WASM scanner with no daemon at all**.

```js
// no daemon — a view-only wallet from (address + view key), the agent does the rest
const { createScanner } = require('xmr-pay/scanner');
const { createPaymentAgent } = require('xmr-pay/agent');

const scanner = await createScanner({ primaryAddress, privateViewKey, networkType, nodes });
const agent = createPaymentAgent({ scanner, minConfirmations: 1, onPaid: (o) => fulfil(o) });
agent.start();

const order = await agent.createOrder({ id: 'ord_42', amount: '0.05' });  // → { address, … }
const r = await agent.check('ord_42');   // { paid, status, receivedXmr, shortfallXmr, … }
```

**→ Full guide, the runnable HTTP service, config, and the trust model:
[docs/AGENT.md](docs/AGENT.md).**

<details>
<summary><b>Or through your own monero-wallet-rpc</b></summary>

```js
const { createWatcher } = require('xmr-pay/watch');
const watcher = createWatcher({ url: 'http://127.0.0.1:18083' });
const { address, index } = await watcher.newSubaddress('order ord_123');
const r = await watcher.checkOrder({ subaddressIndex: index, amount: order.amount_xmr });
// { paid, status: paid|partial|mempool|locked|pending, receivedXmr, shortfallXmr, txids }
```

Per-order subaddresses replace the amount-nonce here (the address identifies the
order). Time-locked outputs never count as paid. Keep wallet-rpc on localhost.

</details>

## Webhooks

There is no xmr-pay server to call you. **Your detection IS the webhook moment** —
when a payment settles, notify whatever needs to know (shop platform, shipping,
Discord, Zapier), signed with your own secret:

```js
const { sendWebhook, verifySignature } = require('xmr-pay/webhook');

if (r.paid) {
  await sendWebhook(process.env.FULFILL_WEBHOOK_URL, {
    event: 'order.paid', order_id, txid: r.txid, confirmations: r.confirmations,
  }, { secret: process.env.FULFILL_WEBHOOK_SECRET });   // X-XMR-Pay-Signature: sha256=…
}
// receiver: verifySignature(rawBody, secret, req.headers['x-xmr-pay-signature'])
```

Retries with backoff built in. (The agent fires this for you, once, on settle.)
The signed body carries an `event_ts` (unix ms) — after verifying the signature,
reject a delivery whose `event_ts` is stale, and stay idempotent on `order_id`, so
a replayed webhook can't trigger a second fulfillment. The browser also gets an
`xmr-pay:paid` DOM event — treat it as **UX only** (a thank-you, a redirect),
never the signal to release goods.

## Security and trust

**The browser decides nothing. Fulfill on your server.** A buyer can fake the
`xmr-pay:paid` event in devtools or point the widget at a fake server — it only
fools their own screen; your server never verified a real payment.

**Node trust.** Verification is only as honest as the nodes you query. The default
`quorum` is `1` (fast, single node) — set `quorum: 2`–`3` for serious volume so
independent nodes must agree (it fails **closed** on disagreement, so availability
then rides on your nodes). For the highest confidence run your own `monerod` and
use **RPC mode** (`verifyPaymentViaRpc` against your own `monero-wallet-rpc`) —
that sidesteps the bundled WASM wallet and its transitive dependencies entirely.

<details>
<summary><b>Threat model</b></summary>

| Attack | Outcome |
|---|---|
| Buyer claims "I paid" with no proof | nothing to verify — rejected |
| Buyer fakes "paid" in devtools (forge the event, edit DOM, point `verify-url` at a fake server) | cosmetic — only their screen; your order stays unpaid. Fulfill server-side |
| Forged / tampered proof | fails cryptographic verification on-chain |
| Proof for a payment to someone else | proofs are address-bound — rejected |
| Reusing a real proof on another order | amount-nonce + `alreadyUsed` — `replay`/`underpaid` |
| Off by 1 piconero | integer-piconero compare — `underpaid` |
| Amount above Monero's max supply (uint64) | rejected — `xmrToPico`/`atomicToPico` enforce the on-chain ceiling, parity with monerod's `parse_amount` |
| **Time-locked payment** (`unlock_time` set — confirms but frozen) | raw tx fetched from the daemon; `unlock_time ≠ 0` → `locked`. Fails **closed** if no node returns the tx |
| A node lies | `quorum: 2+` → `node-disagreement` |
| A node / wallet-rpc is down, slow, or times out | `node-error` — transient and **retryable**, never a false `paid`. Distinct from `invalid` so you can tell "retry" from "reject"; the example endpoint answers `503` |
| Endpoint spam | gate on "order exists & pending" before any RPC |
| Double-submit race (same txid, concurrent) | claim the txid atomically: `UNIQUE` constraint on `tx_hash` |

</details>

<details>
<summary><b>Hardening checklist (the part that stays on you)</b></summary>

- **Fulfill server-side, never from the browser.** Release goods only after your
  server returned `paid` and wrote it to your order record. Same rule as Stripe.
- **`UNIQUE` constraint on `tx_hash`** in your orders table — closes the replay
  race the `alreadyUsed` callback only narrows.
- **Use `makeAmountNonce` for every order** (proof mode) — a proof can't fit
  another order.
- **Scale `minConfirmations` with value** — 1 for small carts, 10 for high-value
  (reorg safety). `minConfirmations: 0` (mempool) is opt-in risk.
- **`quorum: 2` for high-value orders** — two independent nodes must agree.
- **Never take `address`/`amount` from the request body** — always your own order
  record (the examples do this).
- **Your page is the trust root.** If it's compromised the address can be swapped
  — use a **signed config + published fingerprint** (below) for real-money stores.

</details>

<details>
<summary><b>Signed config (tamper-evident address)</b></summary>

Signing moves address integrity onto a key the merchant keeps **off** the web
server, so a breach can serve the real signed config or a broken one, but cannot
mint a new one for the attacker's address.

```js
const { generateSigningKey, signConfig } = require('xmr-pay/config');
const key = generateSigningKey();                 // keep privateKey offline
const env = signConfig({ address, amount: '0.05', networkType: 'mainnet' }, key.privateKey);
// env.fingerprint e.g. "2847-789f-a55a-bd90-1234-5678" — publish where buyers can check
```

```html
<xmr-pay config="<base64 envelope>" verify-url="/api/verify-payment"></xmr-pay>
```

The widget verifies the Ed25519 signature (WebCrypto, no extra dependency), uses
the signed address, and shows `Signed · <fingerprint>`. A "signed" config that
fails verification shows a red warning and no payable address. Pin a known signer
with `pubkey="…"` or `fingerprint="…"`. With the fingerprint known out of band a
buyer catches an address swap even on a fully compromised page.

</details>

<details>
<summary><b>Privacy: what a node sees</b></summary>

Verifying a payment asks one node for one transaction by its txid. The node learns
the **txid** and your **IP/timing** — not the amount or address (derived locally).
That's less than a normal wallet exposes. Close the exposure at the connection
level: **run your own node** (list it first in `nodes`), or egress over **Tor** /
point at an **`.onion`** node. `nodes` takes any URL — configuration, not code.

</details>

## Demo

A complete, deployable demo lives in [`demo/`](demo/): a stagenet store checkout
that verifies a real payment on-chain, plus a mainnet tip widget with no backend.

```
cd demo && npm install && npm start    # http://localhost:8780 — click "Try it"
```

## Validated

**187 offline checks + a 92,006-case math fuzz**, plus live stagenet validation.

- Offline: input gates 40 · core (links/QR/nonce) 22 · signed configs 10 · watch
  summing 14 · webhooks 8 · wallet-rpc verify 20 · adversarial "chaos" 27 · agent
  lifecycle 17 · monerod amount parity 29. The fuzz hammers the piconero math
  (shortfall, summing, round-trips) so paying the displayed difference always
  completes an order to the exact piconero — including the float traps
  (`0.1 + 0.2 = 0.3`). The parity suite mirrors monerod's own `parse_amount`
  (overflow ceiling, 13th-decimal, signs) so we never accept an amount the chain
  rejects.
- Live on stagenet: proof verify through a **13-case adversarial matrix** (exact,
  underpaid/overpaid to the piconero, replay, address-bound rejection, malformed
  → `invalid`, dead node → `node-error`, 2-node quorum, at 0-conf and 1-conf), all
  through the unlock_time gate; the
  **view-only scanner** detecting a real payment via the view key alone; **two real
  payments summed** on one subaddress to complete an order; the **agent** end to
  end (per-order subaddress → settle → one-time signed webhook). Spot-checked
  against a real mainnet transaction key.

## Releases

<details>
<summary><b>Build the widget yourself & verify a download</b></summary>

The widget is a plain concatenation of `widget/xmr-pay.part.js` and the vendored
`qrcode-generator` (`src/vendor/`) — no minifier, no timestamps, no npm install:

```
npm run build
shasum -a 256 widget/xmr-pay.js     # must match SHA256SUMS in the release
```

Each release ships `SHA256SUMS` + a minisign signature. Public key (also
`minisign.pub` in this repo): `RWSA/E4ogu5/1mQf2r66pkWK9fYBEeFdf2cvrjkhiALoXCWT3woSSRtH`

```
minisign -Vm SHA256SUMS -P RWSA/E4ogu5/1mQf2r66pkWK9fYBEeFdf2cvrjkhiALoXCWT3woSSRtH
shasum -a 256 -c SHA256SUMS
```

From npm the package is published with provenance (`npm view xmr-pay --json | grep
provenance`). If a signature or hash doesn't match, don't use the file — report it.

</details>

## Docs

- **[docs/AGENT.md](docs/AGENT.md)** — watch mode & the merchant agent (what it solves, API, trust model)
- **[docs/DEPLOY.md](docs/DEPLOY.md)** — one-click deploy of the verify endpoint
- **[docs/WALLETS.md](docs/WALLETS.md)** — buyer-side wallet instructions per wallet
- **[docs/SUITE.md](docs/SUITE.md)** — how the pieces fit together
- **[SECURITY.md](SECURITY.md)** — reporting, dependency advisories, "try to break it"

## License

MIT. The widget bundles [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator)
(c) Kazuhiko Arase, MIT — vendored so the file makes zero external requests.

A [GoXMR](https://goxmr.click) project.
