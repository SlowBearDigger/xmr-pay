# xmr-pay

Accept Monero on your own site. Payments go directly to your wallet. XMRPay provides
payment links, QR codes, a checkout widget and server-side verification.

[![npm](https://img.shields.io/npm/v/xmr-pay?color=blue)](https://www.npmjs.com/package/xmr-pay)
[![tests](https://img.shields.io/github/actions/workflow/status/SlowBearDigger/xmr-pay/test.yml?branch=main&label=tests)](https://github.com/SlowBearDigger/xmr-pay/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/npm/l/xmr-pay)](LICENSE)

## Choose an integration

| Use | What runs |
|---|---|
| Donation link or QR | static page; no automatic payment verification |
| Buyer submits a tx key or proof | your Node endpoint verifies one transaction |
| Automatic detection and top-ups | a long-running view-only agent, or your wallet-rpc integration |
| WooCommerce | the [standalone plugin](https://github.com/SlowBearDigger/xmr-pay-woocommerce), with native PHP verification or agent mode |

The widget has no mandatory runtime dependencies and generates QR codes locally.
Node verification needs the optional `monero-ts` peer, or your own wallet-rpc.
Payment detection contacts your configured Monero nodes; fiat pricing in adapters may
also contact a price feed. A static page alone does not verify an order.

The agent holds a private view key but no spend key. It cannot send payments or
refunds. Your backend owns the expected amount, payment identity and fulfillment.
Browser status and DOM events do not authorize delivery.

## Verification limits

- Nodes provide chain evidence. The proof verifier supports a quorum; the watch
  agent uses one active node with failover. These are different trust models.
- Confirmation thresholds reduce reorganisation risk. Settled orders are not
  automatically reversed if a payment later disappears from the chain.
- Watch mode sums partial payments. Proof mode verifies one transaction at a time.
- Expiry is disabled by default. Late or unseen payments may require manual
  reconciliation if it is enabled.
- A merchant must process callbacks idempotently and persist payment records.

See the [agent guide](docs/AGENT.md), [HTTP API](docs/API.md),
[FAQ](docs/FAQ.md) and [suite components](docs/SUITE.md). Test the full checkout on
stagenet before deploying a change. The [demo](https://demo.xmrpay.shop) uses test coins.

## Install

```
npm i xmr-pay                 # links, QR and widget
# For WASM verification, also install monero-ts with the overrides in SECURITY.md.
```

Use Node 20 or later for the agent and verification examples. Follow the
[dependency guidance](SECURITY.md#dependencies) for existing installations.

Server-side network selection defaults to mainnet; use stagenet to
test with no real money:

> **Widget:** the receiving address determines where the payment goes. A UI attribute
> cannot convert an address to another network; keep it consistent with the backend.
> **Verify:** `verifyPayment({ networkType: 'stagenet', ... })`.
> **Agent:** the `XMR_NETWORK=stagenet` env var (the `npx xmr-pay` wizard asks).

**Run the agent in one command** (non-custodial; it holds only your view key):

```
npx xmr-pay        # setup wizard (address + view key + node), then it runs
```

It scans from the current block (no historical rescan), generates the token and
webhook secret, asks your settlement speed (`instant` 0-conf, `fast` 1 block,
`secure` 10 blocks), persists its wallet and orders, and prints the exact values to
paste into your store. `npx xmr-pay start` runs it again later.

## How it works

| Module | Runs | Purpose |
|---|---|---|
| `xmr-pay/core` | browser + server | payment URIs (links), QR as SVG, per-order amount nonces |
| `xmr-pay` (verify) | your backend or serverless fn | verify a buyer's tx proof against configured nodes |
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

They share integer amount helpers, but use different transports and node trust
policies. Proof mode checks one transaction; watch mode sums payments. Watch mode is documented
in full in [docs/AGENT.md](docs/AGENT.md).

## Checkout widget

One self-hosted file (`widget/xmr-pay.js`) bundles the QR encoder. It contacts the
verify, status and receipt endpoints you configure; it needs no external QR service.

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
const amount = makeAmountNonce('0.05');   // e.g. '0.050000004821'
// store { order_id, amount } in YOUR db; render the widget with that amount
```

The random piconero tail helps distinguish amounts but can collide, and a larger
payment may satisfy more than one amount. It is not replay protection. Atomically
claim each accepted transaction in your order store. The added value is at most
0.000001 XMR by default.

## Proof mode

The only server piece, and it is yours: stateless, runs on demand.

```js
const { verifyPayment } = require('xmr-pay');

const r = await verifyPayment({
  txid, proof,                       // what the buyer pasted (tx key or tx proof, auto-detected)
  address: order.address,
  amount: order.amount_xmr,          // string keeps 12-decimal nonces exact
  nodes: ['https://your-node:18081', 'https://fallback:18081'],
  minConfirmations: 1,               // 0 accepts mempool, your risk, your call
  quorum: 1,                         // 2+ means independent nodes must agree
  alreadyUsed: (txid) => db.txidSeen(txid),
});
// { paid, status, reason, receivedXmr, expectedXmr, shortfallXmr, confirmations,
//   txid, nodesAgreed, overpaid }   txid comes back normalized (lowercase)
```

Full endpoint with anti-spam gates: [examples/serverless.js](examples/serverless.js).
Connect it to durable order storage and atomic transaction deduplication before
deployment. The sample uses an in-memory order map. See [docs/DEPLOY.md](docs/DEPLOY.md).

A freshly broadcast (mempool) transaction may not be retrievable from a public node
yet, so verification returns `node-error` (retryable, never a false `paid`) until the
tx is in a block. Your own node gives you control over availability; it does not guarantee immediate detection.

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

`sendWebhook` makes a bounded number of attempts. The HTTP agent also persists
undelivered notifications and retries them after restart; duplicates are possible. The
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
| Reusing a real proof on another order | `alreadyUsed` checks prior use; the store must enforce an atomic unique transaction claim |
| Off by 1 piconero | integer-piconero compare, returns `underpaid` |
| Amount above the uint64 atomic-value range | rejected by `xmrToPico`/`atomicToPico`; this is a serialization bound, not Monero's total supply |
| Time-locked payment (`unlock_time` set, confirms but frozen) | raw tx fetched from the daemon; a nonzero `unlock_time` that has not elapsed returns `locked`. Fails closed if no node returns the tx |
| Proof-verification nodes disagree | the verifier requires a sufficient agreeing group; quorum does not protect against agreeing dishonest nodes |
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
> **Amount nonces are optional disambiguation**, not a replacement for atomic
> transaction deduplication.
> **Scale `minConfirmations` with value**: 1 for small carts, 10 for high-value
> (reorg safety). `minConfirmations: 0` (mempool) is opt-in risk.
> **`quorum: 2` for high-value orders**, so two independent nodes must agree.
> **Never take `address`/`amount` from the request body**; always your own order
> record (the examples do this).
> **Your page is the trust root.** If it is compromised the address can be swapped,
> so use a signed config and verify its fingerprint through a trusted channel (below).

</details>

<details>
<summary><b>Signed config (tamper-evident address)</b></summary>

Signing moves address integrity onto a key the merchant keeps off the web server, so
an attacker cannot mint a valid replacement envelope without the signing key.
A fully compromised page can still replace the widget or its pinned key. Buyers
need a trusted copy of the fingerprint outside that page to detect that attack.

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
`pubkey="…"` or `fingerprint="…"`. A buyer must check the envelope with a trusted verifier and an independently
obtained fingerprint if the page itself may be compromised.

</details>

<details>
<summary><b>Privacy: what a node sees</b></summary>

Proof verification requests a transaction by ID from the configured nodes; watch
mode requests chain data to scan locally. Nodes see the requested data and the
connection address and timing. Address matching and amount decoding happen locally.
Use your own nodes or configure network routing appropriate to your privacy needs. Use supported HTTP(S) URLs and configure any proxy routing outside the library.

</details>

## Demo

A complete, deployable demo lives in [demo/](https://github.com/SlowBearDigger/xmr-pay/tree/main/demo): a stagenet store checkout that
verifies a real payment on-chain, plus a mainnet tip widget with no backend.

```
cd demo && npm install && npm start    # http://localhost:8780, click "Try it"
```

## Tests

`npm test` runs the offline regression, property, concurrency and invariant suites.
`npm run build` rebuilds the widget and hosted copy from source. Live stagenet tests
are separate and need `monero-ts`, matching keys and a reachable node; see
[CONTRIBUTING.md](CONTRIBUTING.md).

Tests cover amount precision, proof gates, time locks, duplicate evidence, node
agreement, agent persistence, callbacks and browser input handling. They do not
replace a checkout test on the platform and versions you deploy.

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
> [monero-integrations / monerophp](https://github.com/monero-integrations/monerophp) (MIT): the pure-PHP ed25519, key-derivation and base58 primitives the WordPress-native verifier is vendored on. Used by the PHP verifier.
> [kornrunner/php-keccak](https://github.com/kornrunner/php-keccak) (MIT): Keccak-256 with Monero's padding, in pure PHP.
> [monero-ts](https://github.com/woodser/monero-ts) (woodser, MIT): the WASM Monero library powering the watch/proof paths, and our ground-truth reference for cross-checking the PHP verifier.
> [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) (MIT): the checkout widget's self-contained QR encoder.
> Inspiration: [BTCPay Server](https://btcpayserver.org/)'s Monero plugin, [MoneroPay](https://gitlab.com/moneropay/moneropay), and [AcceptXMR](https://github.com/busyboredom/acceptxmr). Related open-source payment projects.

## License

MIT, including the vendored [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator)
(c) Kazuhiko Arase, bundled so QR generation needs no external service.

A [GoXMR](https://goxmr.click) project, also available for [WordPress / WooCommerce](https://github.com/SlowBearDigger/xmr-pay-woocommerce).
