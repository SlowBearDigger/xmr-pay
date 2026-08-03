# xmr-pay

Accept Monero on your own site. The money goes straight to your wallet. There is no
company in the middle, no account to open, no fee paid to anyone, and nobody can
freeze, see, or hold your funds but you.

xmr-pay is a small toolkit you run yourself: payment links and QR codes, an
embeddable checkout widget, and trustless on-chain payment detection. It is code,
not a service.

[![npm](https://img.shields.io/npm/v/xmr-pay?color=blue)](https://www.npmjs.com/package/xmr-pay)
[![tests](https://img.shields.io/github/actions/workflow/status/SlowBearDigger/xmr-pay/test.yml?branch=main&label=tests)](https://github.com/SlowBearDigger/xmr-pay/actions/workflows/test.yml)
[![runtime deps](https://img.shields.io/badge/runtime%20deps-0-brightgreen)](#)
[![external requests](https://img.shields.io/badge/external%20requests-0-brightgreen)](#)
[![license: MIT](https://img.shields.io/npm/l/xmr-pay)](LICENSE)

MIT licensed · zero runtime dependencies · signed releases

**Quick links:** [Live demo (stagenet)](https://demo.xmrpay.shop) · [npm](https://www.npmjs.com/package/xmr-pay) · [WooCommerce plugin](https://github.com/SlowBearDigger/xmr-pay-woocommerce) · [Docs](docs/) · [5-minute start](#install)

## Running a WooCommerce store?

There is a separate, standalone plugin built on this engine:

> **[xmr-pay for WooCommerce](https://github.com/SlowBearDigger/xmr-pay-woocommerce)**

If you just want to accept Monero in a WordPress store with no code, start there.
That plugin stands on its own (install it, paste your address, done) and this README
is about the library underneath it. The two projects are independent; each links the
other.

## See it live (stagenet, no real money)

> [live.xmrpay.shop](https://live.xmrpay.shop) : configure it yourself and watch it verify a payment
> [demo.xmrpay.shop](https://demo.xmrpay.shop) : a full demo store, pay with free test XMR
> [xmrpay.shop/demo.html](https://xmrpay.shop/demo.html) : the checkout widget and the "prove you paid" flow

## How it compares

Every option here is Monero-only and non-custodial in spirit — no fiat processors, no
custody. The honest difference is how much you have to keep running, and whether anything
sits between the buyer and your wallet. (xmr-pay is the JavaScript library — payment links,
a checkout widget, and on-chain verification; WooCommerce and the PHP engine live in the
separate [companion plugin](https://github.com/SlowBearDigger/xmr-pay-woocommerce).)

| | **xmr-pay** | BTCPay Server (Monero plugin) | AcceptXMR | MoneroPay | monerowp |
|---|---|---|---|---|---|
| Custody | Non-custodial, view key only | Non-custodial (self-run) | Non-custodial, view pair (no hot wallet) | View-only or hot wallet | View-only recommended |
| Always-on server / daemon? | **No** — a static page / widget client-side, a serverless function, or watch mode in a runtime you already run | Yes — full server + wallet-rpc | Yes — a process + your own daemon | Yes — daemon + wallet-rpc + database | Yes — wallet-rpc on your server |
| Runtime dependencies | **Zero** | Full stack (Docker) | Rust crates | Go + database | PHP + wallet-rpc |
| Third party in the verify path | **None** (your own node) | None (your own node) | None (your own node) | None (your own node) | wallet-rpc, or a public block explorer |
| Drop-in WooCommerce | Via the companion plugin (no server) | Via BTCPay's WC plugin (needs the server) | No (Rust library) | No (HTTP API — build your own) | Yes |
| Monero refunds | Non-custodial claim-link (helpers in the lib; full buyer flow in the plugin) | Manual (collect a return address) | Not built-in | Via its outgoing API (needs a hot wallet) | Not built-in |
| Maturity & adoption | New (2026) | Most mature, years in production | Established, active | Established | Long-standing community plugin |

> **Where the others are genuinely stronger:** BTCPay Server does far more (multi-coin,
> point-of-sale, Lightning, accounting) and is battle-tested; AcceptXMR is a fast Rust
> gateway with realtime updates and the closest non-custodial philosophy to ours;
> MoneroPay's daemon can also send outgoing payments; monerowp has years of real merchant
> use. xmr-pay is the newest and least proven of the bunch. Its bet is narrow on purpose:
> Monero only, nothing always-on by default, zero dependencies, an npm library plus a static
> checkout — and a companion WooCommerce plugin (built on this same engine) that adds
> non-custodial claim-link refunds.

## You do not need a dedicated server

This is worth being blunt about, because it is where most Monero tooling adds
friction: confirming a Monero payment is, underneath, just reading public blockchain
data and doing some math. So none of the ways to do it require a box that stays on
24/7.

> **Proof mode** is a stateless function that runs on demand. It can live in a
> serverless function or one small route on the site you already have. Nothing is
> always-on.
> **Watch mode** runs wherever you already run code, against your own wallet-rpc or
> a built-in view-only scanner that needs no daemon at all.
> **Inside WordPress**, the plugin does both in pure PHP. No Node, no daemon, no
> separate process. WordPress's own cron and the buyer's checkout page trigger the
> check; the rest of the time nothing runs.

### Why that is reasonably trustworthy (and where the limits honestly are)

> **It can see, it cannot spend.** Detection only ever holds your *view* key. It can
> read incoming payments; it can never move your money. The key that spends funds is
> never asked for and never stored.
> **The amount is proven, not claimed.** Monero commits the real amount of every
> output on-chain. The verifier checks that commitment, so a forged or edited amount
> is rejected. It cannot be talked into seeing money that is not there.
> **It fails closed.** Several independent checks must all pass: the amount
> commitment, enough confirmations, the funds are not time-locked, and no
> transaction is counted twice. If anything is missing, or a node will not answer,
> the order stays unpaid. It never guesses "paid".
> **The honest caveat:** verification trusts the Monero node you point it at to tell
> the truth. A public node is fine for most sites. For serious money, point it at
> your own node, or require two nodes to agree. That one thing is on you, and the
> setting is right there.

The verification math is cross-checked against the reference Monero library and the
whole money path is covered by an adversarial test suite, so "no server" does not
mean "cut corners".

## What you get

> **Your money, directly.** Payments land in your wallet. xmr-pay never holds,
> routes, or can touch a cent. There is no xmr-pay in the payment path.
> **No accounts, no API keys, no monthly fee.** It is code you run, not a service
> you subscribe to.
> **Privacy by default.** Monero hides amounts and parties on-chain, and nothing in
> the buyer's browser is trusted to settle an order.
> **Underpaid, or paid in two goes?** Watch mode sums the payments, so the order
> finishes itself once the total adds up, and the buyer can top up to the same
> address.

## The truths (please read before taking real money)

We would rather tell you the rough edges than have you find them with a customer.

> **Monero is irreversible, and the sender is hidden, so there are no automatic
> refunds.** If you need to refund someone you send them XMR back by hand. That is
> the trade for having no chargebacks and no middleman.
> **You are trusting a node to tell the truth.** A single public node could lie, be
> slow, or go down. Fine for tips. For real revenue, run your own node or require two
> nodes to agree (it then refuses to confirm rather than trust one source).
> **Few confirmations is fast but reversible.** XMRPay shows mempool funds as
> provisional and requires at least one block before `paid`. Use more confirmations
> for higher-value orders. This is your risk dial to set.
> **A brand-new transaction can take a moment to verify on a public node.** If a
> buyer submits a proof for a transaction still in the mempool, a public node may not
> serve it yet and the check comes back "try again", never a false "paid". It clears
> once the transaction is in a block. Your own node removes the wait.
> **The browser is never trusted.** Anything shown in a buyer's browser can be faked
> by that buyer. Goods are released only after your own server verified a real
> payment on-chain. Same rule as every serious payment system.

## Install

```
npm i xmr-pay monero-ts        # monero-ts only needed for server-side detection
```

The network is explicit at every entry point. Default is mainnet; use stagenet to
test with no real money:

> **Widget:** the network follows the address you pass — a `4…` address is mainnet, `5…`/`7…` is stagenet (no separate attribute).
> **Verify:** `verifyPayment({ networkType: 'stagenet', ... })`.
> **Agent:** the `XMR_NETWORK=stagenet` env var (the `npx xmr-pay` wizard asks).

**Run the agent in one command** (non-custodial; it holds only your view key):

```
npx xmr-pay        # setup wizard (address + view key + node), then it runs
```

It scans from the current block (no historical rescan), generates the token and
webhook secret, asks your settlement speed (`instant` and `fast` both wait 1 block,
`secure` waits 10 blocks), persists its wallet and orders, and prints the exact values to
paste into your store. `npx xmr-pay start` runs it again later.

## How it works

| Module | Runs | Purpose |
|---|---|---|
| `xmr-pay/core` | browser + server | payment URIs (links), QR as SVG, per-order amount nonces |
| `xmr-pay` (verify) | your backend or serverless fn | re-verify a buyer's tx proof on-chain, trustless |
| `xmr-pay/watch` | your backend | auto-detection through your own monero-wallet-rpc |
| `xmr-pay/scanner` | your backend | view-only WASM scanner, auto-detection with NO wallet-rpc daemon |
| `xmr-pay/agent` | your backend | long-running order manager: per-order subaddress, summing, signed paid webhook |
| `xmr-pay/config` | offline + browser | signed merchant configs, tamper-evident addresses |
| `xmr-pay/webhook` | your backend | signed fulfillment webhooks to YOUR systems |
| `widget/xmr-pay.js` | browser | full checkout UI, one self-hosted file, zero dependencies |

Two detection modes, freely combined:

| | Proof mode (default) | Watch mode |
|---|---|---|
| Infra (yours) | a stateless verify endpoint, on demand | a long-running process you host |
| Buyer effort | pastes txid + proof | none, just pays |
| View key | not needed | yours, in-process (view-only) |
| Partial / top-up auto-complete | manual (single-tx proofs) | automatic, sums transfers |
| Best for | tips, a single product, lowest infra | a real store, installments, hands-off |

```
proof mode (no always-on process; your verify endpoint runs on demand):
  buyer's browser:  pays > wallet makes a tx proof > widget POSTs {txid, proof}
  YOUR server:      > verify endpoint > verifyPayment re-checks on YOUR nodes > paid

watch mode (the agent; no monero-wallet-rpc needed):
  order > fresh subaddress > buyer pays > your agent scans and SUMS transfers
        > paid (handles partial / split / top-up payments) > signed order.paid webhook
```

They share the same exact-math core, so a payment counts identically either way.
Many shops run watch mode and keep proof as a dispute path. Watch mode is documented
in full in [docs/AGENT.md](docs/AGENT.md).

## Checkout widget

One self-hosted file (`widget/xmr-pay.js`, ~98 KB, bundles its own QR encoder, no
external requests ever). Drop it in and you have a Monero checkout.

```html
<script src="/xmr-pay.js"></script>

<!-- tips / donations, nothing else needed -->
<xmr-pay address="4YOUR_ADDRESS…" label="Buy me a coffee"></xmr-pay>

<!-- store checkout, detection against YOUR endpoint -->
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
prefilled so wallets can't be sent the wrong amount), click-to-copy address with a
highlighted fingerprint, "open in wallet" deep link, an always-there trust panel,
and a "paid? prove it" panel that submits txid + tx proof to your endpoint.

**Attributes:** `address` (required unless `config` is set), `amount`, `label`,
`order`, `verify-url`, `redirect-url`, `lang` (`en`/`es`), `theme` (`light`),
`skin` (`brutal`), `config` (base64 signed envelope), `fingerprint`/`pubkey` (pin
the signer).
**Events:** `xmr-pay:paid`, `xmr-pay:result` (CustomEvent, verify result in `detail`).

**Buyer-error feedback (built in).** Bad txid gives *"that transaction ID should be
64 characters"*; not a proof gives *"paste the tx key or the proof block from your
wallet"*, caught instantly before any server round-trip. **Underpaid** gives
*"Detected 0.1 XMR, send 0.2 more to complete"* plus a fresh QR for exactly the
missing amount (piconero-exact, no float drift). The proof box also smart-pastes a
whole Feather block and picks out the txid + proof itself.

**Skins.** Default is a neutral, universal look (system sans, rounded, soft
shadows). `skin="brutal"` is the GOXMR brand look (monospace, square, hard shadow).
Both are driven by `--xp-*` CSS variables, so any brand can retheme without forking.

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
"open in wallet" use). The URIs are round-trip tested against the official wallet2
parser (what GUI, CLI and Feather run internally), including 12-decimal nonce
amounts and unicode descriptions, so they prefill cleanly across Feather, GUI, CLI,
Cake, Monerujo and Stack (mobile + desktop, Win/Mac/Linux).

Prefer the `#fragment` form for shared links; fragments never reach server logs or
proxies. Truly short URLs (`/p/x7k2`) need a lookup, so add a redirect route on your
own server rather than a third-party shortener that would track your buyers.

Buyer-side wallet instructions (Feather/GUI/Cake/CLI menu names, restored-seed
caveat): [docs/WALLETS.md](docs/WALLETS.md).

</details>

## Order creation (amount-nonce)

```js
const { makeAmountNonce } = require('xmr-pay/core');
const amount = makeAmountNonce('0.05');   // '0.050000004821', unique per order
// store { order_id, amount } in YOUR db; render the widget with that amount
```

The random piconero tail makes each order's on-chain amount unique, so a proof
structurally fits only its own order: a secondary anti-replay guard on top of your
txid dedup. The added value is dust (default ≤ 0.000001 XMR).

## Proof mode

The only server piece, and it is yours: stateless, runs on demand.

```js
const { verifyPayment } = require('xmr-pay');

const r = await verifyPayment({
  txid, proof,                       // what the buyer pasted (tx key or tx proof, auto-detected)
  address: order.address,
  amount: order.amount_xmr,          // string keeps 12-decimal nonces exact
  nodes: ['https://your-node:18081', 'https://fallback:18081'],
  minConfirmations: 1,               // values below 1 are normalized to 1
  quorum: 1,                         // 2+ means independent nodes must agree
  alreadyUsed: (txid) => db.txidSeen(txid),
});
// { paid, status, reason, receivedXmr, expectedXmr, shortfallXmr, confirmations,
//   txid, nodesAgreed, overpaid }   txid comes back normalized (lowercase)
```

Full endpoint with anti-spam gates: [examples/serverless.js](examples/serverless.js).
Drop it in Vercel/Netlify/Express; stateless, your orders table is the only state
and it is already yours. One-click deploy template: [docs/DEPLOY.md](docs/DEPLOY.md).

A freshly broadcast (mempool) transaction may not be retrievable from a public node
yet, so verification returns `node-error` (retryable, never a false `paid`) until the
tx is in a block. Run your own node to remove the wait.

<details>
<summary><b>No <code>monero-ts</code>? Verify through your wallet-rpc</b></summary>

If you already run `monero-wallet-rpc`, `verifyPaymentViaRpc` checks the same proofs
through it: same gates, same result shape, no WASM peer to install (so none of
`monero-ts`'s transitive advisories; see SECURITY.md):

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

Automatic detection: a fresh subaddress per order, payments summed (so partial
payments and top-ups auto-complete), the buyer submits nothing. Two transports: your
own `monero-wallet-rpc`, or a view-only WASM scanner with no daemon at all.

```js
// no daemon: a view-only wallet from (address + view key), the agent does the rest
const { createScanner } = require('xmr-pay/scanner');
const { createPaymentAgent } = require('xmr-pay/agent');

const scanner = await createScanner({ primaryAddress, privateViewKey, networkType, nodes });
const agent = createPaymentAgent({ scanner, minConfirmations: 1, onPaid: (o) => fulfil(o) });
agent.start();

const order = await agent.createOrder({ id: 'ord_42', amount: '0.05' });  // returns { address, … }
const r = await agent.check('ord_42');   // { paid, status, receivedXmr, shortfallXmr, … }
```

Each order gets its own subaddress, and a second order can never bind a subaddress
already in use, so two orders can't credit the same payment. Full guide, the runnable
HTTP service, config, and the trust model: [docs/AGENT.md](docs/AGENT.md).

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

There is no xmr-pay server to call you. Your detection IS the webhook moment: when a
payment settles, notify whatever needs to know (shop platform, shipping, Discord,
Zapier), signed with your own secret:

```js
const { sendWebhook, verifySignature } = require('xmr-pay/webhook');

if (r.paid) {
  await sendWebhook(process.env.FULFILL_WEBHOOK_URL, {
    event: 'order.paid', order_id, txid: r.txid, confirmations: r.confirmations,
  }, { secret: process.env.FULFILL_WEBHOOK_SECRET });   // X-XMR-Pay-Signature: sha256=…
}
// receiver: verifySignature(rawBody, secret, req.headers['x-xmr-pay-signature'])
```

Retries with backoff built in. (The agent fires this for you, once, on settle.) The
signed body carries an `event_ts` (unix ms): after verifying the signature, reject a
delivery whose `event_ts` is stale, and stay idempotent on `order_id`, so a replayed
webhook can't trigger a second fulfillment. The browser also gets an `xmr-pay:paid`
DOM event; treat it as UX only (a thank-you, a redirect), never the signal to release
goods.

## Security and trust

**The browser decides nothing. Fulfill on your server.** A buyer can fake the
`xmr-pay:paid` event in devtools or point the widget at a fake server; it only fools
their own screen, and your server never verified a real payment.

**Node trust.** Verification is only as honest as the nodes you query. The default
`quorum` is `1` (fast, single node); set `quorum: 2`–`3` for serious volume so
independent nodes must agree (it fails closed on disagreement, so availability then
rides on your nodes). For the highest confidence run your own `monerod` and use RPC
mode (`verifyPaymentViaRpc` against your own `monero-wallet-rpc`), which sidesteps the
bundled WASM wallet and its transitive dependencies entirely.

<details>
<summary><b>Threat model</b></summary>

| Attack | Outcome |
|---|---|
| Buyer claims "I paid" with no proof | nothing to verify, rejected |
| Buyer fakes "paid" in devtools (forge the event, edit DOM, point `verify-url` at a fake server) | cosmetic, only their screen; your order stays unpaid. Fulfill server-side |
| Forged or tampered proof | fails cryptographic verification on-chain |
| Proof for a payment to someone else | proofs are address-bound, rejected |
| Reusing a real proof on another order | amount-nonce + `alreadyUsed`, returns `replay`/`underpaid` |
| Off by 1 piconero | integer-piconero compare, returns `underpaid` |
| Amount above Monero's max supply (uint64) | rejected; `xmrToPico`/`atomicToPico` enforce the on-chain ceiling, parity with monerod's `parse_amount` |
| Time-locked payment (`unlock_time` set, confirms but frozen) | raw tx fetched from the daemon; `unlock_time ≠ 0` returns `locked`. Fails closed if no node returns the tx |
| A node lies | `quorum: 2+` returns `node-disagreement` |
| A node or wallet-rpc is down, slow, or times out | `node-error`, transient and retryable, never a false `paid`. Distinct from `invalid` so you can tell "retry" from "reject"; the example endpoint answers `503` |
| Endpoint spam | gate on "order exists and pending" before any RPC |
| Double-submit race (same txid, concurrent) | claim the txid atomically with a `UNIQUE` constraint on `tx_hash` |

</details>

<details>
<summary><b>Hardening checklist (the part that stays on you)</b></summary>

> **Fulfill server-side, never from the browser.** Release goods only after your
> server returned `paid` and wrote it to your order record. Same rule as Stripe.
> **`UNIQUE` constraint on `tx_hash`** in your orders table closes the replay race
> the `alreadyUsed` callback only narrows.
> **Use `makeAmountNonce` for every order** (proof mode), so a proof can't fit
> another order.
> **Scale `minConfirmations` with value**: 1 for small carts, 10 for high-value
> (reorg safety). Mempool detection is provisional and never authorizes fulfillment.
> **`quorum: 2` for high-value orders**, so two independent nodes must agree.
> **Never take `address`/`amount` from the request body**; always your own order
> record (the examples do this).
> **Your page is the trust root.** If it is compromised the address can be swapped,
> so use a signed config + published fingerprint (below) for real-money stores.

</details>

<details>
<summary><b>Signed config (tamper-evident address)</b></summary>

Signing moves address integrity onto a key the merchant keeps off the web server, so
a breach can serve the real signed config or a broken one, but cannot mint a new one
for the attacker's address.

```js
const { generateSigningKey, signConfig } = require('xmr-pay/config');
const key = generateSigningKey();                 // keep privateKey offline
const env = signConfig({ address, amount: '0.05', networkType: 'mainnet' }, key.privateKey);
// env.fingerprint e.g. "2847-789f-a55a-bd90-1234-5678", publish where buyers can check
```

```html
<xmr-pay config="<base64 envelope>" verify-url="/api/verify-payment"></xmr-pay>
```

The widget verifies the Ed25519 signature (WebCrypto, no extra dependency), uses the
signed address, and shows `Signed · <fingerprint>`. A "signed" config that fails
verification shows a red warning and no payable address. Pin a known signer with
`pubkey="…"` or `fingerprint="…"`. With the fingerprint known out of band a buyer
catches an address swap even on a fully compromised page.

</details>

<details>
<summary><b>Privacy: what a node sees</b></summary>

Verifying a payment asks one node for one transaction by its txid. The node learns
the txid and your IP/timing, not the amount or address (derived locally). That is
less than a normal wallet exposes. Close the exposure at the connection level: run
your own node (list it first in `nodes`), or egress over Tor / point at an `.onion`
node. `nodes` takes any URL, configuration not code.

</details>

## Demo

A complete, deployable demo lives in [`demo/`](demo/): a stagenet store checkout that
verifies a real payment on-chain, plus a mainnet tip widget with no backend.

```
cd demo && npm install && npm start    # http://localhost:8780, click "Try it"
```

## Validated

187 offline checks plus a 92,006-case math fuzz, plus live stagenet validation.

> Offline: input gates 40, core (links/QR/nonce) 22, signed configs 10, watch summing
> 14, webhooks 8, wallet-rpc verify 20, adversarial "chaos" 27, agent lifecycle 17,
> monerod amount parity 29, node-quorum 13, plus order-independence and
> byzantine-duplicate stress. The fuzz hammers the piconero math (shortfall, summing,
> round-trips) so paying the displayed difference always completes an order to the
> exact piconero, including the float traps (`0.1 + 0.2 = 0.3`). The parity suite
> mirrors monerod's own `parse_amount` (overflow ceiling, 13th-decimal, signs) so we
> never accept an amount the chain rejects.
> Live on stagenet: proof verify through a 13-case adversarial matrix (exact,
> underpaid/overpaid to the piconero, replay, address-bound rejection, malformed
> returns `invalid`, dead node returns `node-error`, 2-node quorum, and legacy 0-conf
> normalization to 1-conf), all through the unlock_time gate; the view-only scanner detecting a real
> payment via the view key alone; two real payments summed on one subaddress to
> complete an order; the agent end to end (per-order subaddress, settle, one-time
> signed webhook). Spot-checked against a real mainnet transaction key.

## Donate

If xmr-pay saved you a payment processor's cut, a little Monero back is welcome,
never required:

```
45sEohkyWYxAfHy8ekP7B34Bd3qhgrupcQfUQAHvfUWkfgqJhCA4QYLigrBg8G8TE4WggtMGpmjXrbmvepkWLec58KKLkm9
```

## Releases

<details>
<summary><b>Build the widget yourself and verify a download</b></summary>

The widget is a plain concatenation of `widget/xmr-pay.part.js` and the vendored
`qrcode-generator` (`src/vendor/`): no minifier, no timestamps, no npm install:

```
npm run build
shasum -a 256 widget/xmr-pay.js     # must match SHA256SUMS in the release
```

Each release ships `SHA256SUMS` plus a minisign signature. Public key (also
`minisign.pub` in this repo): `RWSA/E4ogu5/1mQf2r66pkWK9fYBEeFdf2cvrjkhiALoXCWT3woSSRtH`

```
minisign -Vm SHA256SUMS -P RWSA/E4ogu5/1mQf2r66pkWK9fYBEeFdf2cvrjkhiALoXCWT3woSSRtH
shasum -a 256 -c SHA256SUMS
```

From npm the package is published with provenance (`npm view xmr-pay --json | grep
provenance`). If a signature or hash does not match, do not use the file, and report
it.

</details>

## Docs

> [docs/AGENT.md](docs/AGENT.md) : watch mode and the merchant agent (what it solves, API, trust model)
> [docs/DEPLOY.md](docs/DEPLOY.md) : one-click deploy of the verify endpoint
> [docs/WALLETS.md](docs/WALLETS.md) : buyer-side wallet instructions per wallet
> [docs/SUITE.md](docs/SUITE.md) : how the pieces fit together
> [CHANGELOG.md](CHANGELOG.md) : release notes
> [SECURITY.md](SECURITY.md) : reporting, dependency advisories, "try to break it"

## Acknowledgements

We stand on excellent open-source work. Give them a star:

> [monero-project](https://www.getmonero.org/): the protocol; our money-math parity suite mirrors `parse_amount`'s own unit tests.
> [monero-integrations / monerophp](https://github.com/monero-integrations/monerophp) (MIT): the pure-PHP ed25519, key-derivation and base58 primitives the WordPress-native verifier is vendored on. The breakthrough that made "verify in PHP" possible.
> [kornrunner/php-keccak](https://github.com/kornrunner/php-keccak) (MIT): Keccak-256 with Monero's padding, in pure PHP.
> [monero-ts](https://github.com/woodser/monero-ts) (woodser, MIT): the WASM Monero library powering the watch/proof paths, and our ground-truth reference for cross-checking the PHP verifier.
> [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) (MIT): the checkout widget's self-contained QR encoder.
> Inspiration: [BTCPay Server](https://btcpayserver.org/)'s Monero plugin, [MoneroPay](https://gitlab.com/moneropay/moneropay), and [AcceptXMR](https://github.com/busyboredom/acceptxmr). We studied all three to match (and, on reorg-safety, double-spend and arithmetic, exceed) their detection model.

## License

MIT, including the vendored [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator)
(c) Kazuhiko Arase, bundled so the widget makes zero external requests.

A [GoXMR](https://goxmr.click) project, also available for [WordPress / WooCommerce](https://github.com/SlowBearDigger/xmr-pay-woocommerce).
