# xmr-pay

Sovereign Monero payments toolkit — "Stripe, but serverless and nobody's
customer". Accept XMR with payment links, QR codes, an embeddable checkout
widget, and stateless on-chain proof verification.

**No accounts. No API keys. No CDN. No third party in the payment path.**
You hold the address, you choose the nodes, you run the (tiny, optional)
verify endpoint. xmr-pay is code, not a service.

```
npm i xmr-pay monero-ts        # monero-ts only needed for server-side verify
```

## The pieces

| Module | Runs | Purpose |
|---|---|---|
| `xmr-pay/core` | browser + server | payment URIs (links), QR as SVG, per-order amount nonces |
| `xmr-pay` (verify) | your backend / serverless fn | re-verify a buyer's tx proof on-chain — trustless |
| `xmr-pay/watch` | your backend | auto-detection through your own monero-wallet-rpc |
| `xmr-pay/config` | offline + browser | signed merchant configs, tamper-evident addresses |
| `xmr-pay/webhook` | your backend | signed fulfillment webhooks to YOUR systems |
| `widget/xmr-pay.js` | browser | full checkout UI — one self-hosted file, zero dependencies |

Two detection modes, freely combined:

| Mode | Infra | Buyer effort | Detection |
|---|---|---|---|
| **proof** (default) | none | pastes txid + proof | on submission |
| **watch** | your `monero-wallet-rpc` | none | automatic, supports partial payments |

Proof mode needs nothing running anywhere. Watch mode is for merchants who
want the "it just detects" experience — the view key lives in *their*
wallet-rpc, on *their* machine, so it stays sovereign. Many shops will run
watch for convenience and keep proof as the dispute path.

## 1 · Checkout widget (zero backend to start)

Copy `widget/xmr-pay.js` to your site (one file, ~80 KB, bundles its own QR
encoder — no external requests, ever) and drop:

```html
<script src="/xmr-pay.js"></script>

<!-- tips / donations — nothing else needed -->
<xmr-pay address="4YOUR_ADDRESS…" label="Buy me a coffee"></xmr-pay>

<!-- store checkout — verification against YOUR endpoint -->
<xmr-pay
  address="4YOUR_ADDRESS…"
  amount="0.050000004821"
  order="ord_123"
  verify-url="/api/verify-payment"
  redirect-url="/thanks"
  lang="es"></xmr-pay>
```

What the buyer gets: amount + QR (generated locally) + click-to-copy address
with a highlighted fingerprint + "open in wallet" deep link + an always-there
**trust panel** (funds go straight to the merchant, check the address, check
the link) + a **"paid? prove it"** panel that submits txid + tx proof to your
endpoint.

Attributes: `address` (required unless `config` is set) · `amount` · `label` ·
`order` · `verify-url` · `redirect-url` · `lang` (`en`/`es`) · `theme` (`light`)
· `skin` (`brutal`) · `config` (base64 signed envelope, see below) ·
`fingerprint`/`pubkey` (pin the signer). Events: `xmr-pay:paid`,
`xmr-pay:result` (CustomEvent with the verify result in `detail`).

The proof box accepts a whole pasted block — Feather's formatted proof, a
copied details screen — and picks out the txid and proof by itself.

**Skins.** The default is a neutral, universal look (system sans, rounded,
soft shadows) that drops into any site. `skin="brutal"` switches to the GOXMR
brand look (monospace, square, hard offset shadow). Both are driven by the same
CSS custom properties (`--xp-accent`, `--xp-bg`, `--xp-radius`, `--xp-font`, …)
so any brand can retheme without forking.

## 2 · Payment links

A payment link is just a URL. Host [examples/pay-link.html](examples/pay-link.html)
anywhere static and share:

```
https://your-site.com/pay-link.html#address=4…&amount=0.05&label=Invoice%2042
```

For wallet-native links, `core.makePaymentURI()` builds the `monero:` URI
(that's also what the widget's QR and "open in wallet" use). Our URIs are
round-trip tested against the official wallet2 parser — what GUI, CLI and
Feather run internally — including 12-decimal nonce amounts and unicode
descriptions.

Prefer the `#fragment` form for shared links: fragments never reach server
logs or proxies. Truly short URLs (`/p/x7k2`) require a lookup somewhere — if
you want them, add a redirect route on your own server; a third-party
shortener would put a tracker in your payment path.

Buyer-side wallet instructions (Feather/GUI/Cake/CLI menu names, restored-seed
caveat): [docs/WALLETS.md](docs/WALLETS.md).

## 3 · Order creation (amount-nonce)

```js
const { makeAmountNonce, makePaymentURI, qrSvg } = require('xmr-pay/core');

const amount = makeAmountNonce('0.05');   // '0.050000004821' — unique per order
// store { order_id, amount } in YOUR db; render the widget with that amount
```

The random piconero tail makes each order's on-chain amount unique, so a
payment proof only fits its own order — anti-replay without any shared state.
The added value is dust (≤ 0.00000001 XMR).

## 4 · Verification (the only server piece — yours)

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
// { paid, status, reason, receivedXmr, confirmations, txid, nodesAgreed,
//   overpaid, overpaidXmr }   — txid comes back normalized (lowercase)
```

Full endpoint with the anti-spam gates: [examples/serverless.js](examples/serverless.js).
Drop it in Vercel/Netlify/Express — it's stateless; your orders table is the
only state and it's already yours.

## 4b · Watch mode (optional auto-detection)

Run `monero-wallet-rpc` with a **view-only** wallet on your own machine, then:

```js
const { createWatcher } = require('xmr-pay/watch');
const watcher = createWatcher({ url: 'http://127.0.0.1:18083' });

// at order creation: a fresh subaddress per order
const { address, index } = await watcher.newSubaddress('order ord_123');

// on a timer or per status request:
const r = await watcher.checkOrder({ subaddressIndex: index, amount: order.amount_xmr });
// { paid, status: paid|partial|mempool|locked|pending, receivedXmr, pendingXmr, txids }
```

Per-order subaddresses replace the amount-nonce in this mode (the address
itself identifies the order), buyers do nothing, and partial payments sum up.
Time-locked outputs never count as paid, same as proof mode. Keep wallet-rpc
on localhost or a private network.

## 5 · Webhooks (products, shipping, fulfillment)

There is no xmr-pay server to call you. **Your verify endpoint IS the webhook
moment**: when `verifyPayment` returns `paid`, notify whatever needs to know —
your shop platform, shipping, Discord, Zapier — signed with your own secret:

```js
const { sendWebhook, verifySignature } = require('xmr-pay/webhook');

if (r.paid) {
  await sendWebhook(process.env.FULFILL_WEBHOOK_URL, {
    event: 'order.paid', order_id, txid: r.txid, confirmations: r.confirmations,
  }, { secret: process.env.FULFILL_WEBHOOK_SECRET });   // X-XMR-Pay-Signature: sha256=…
}
// receiver side: verifySignature(rawBody, secret, req.headers['x-xmr-pay-signature'])
```

Retries with backoff built in. The browser side additionally gets the
`xmr-pay:paid` DOM event for instant UX (redirect, unlock).

## Threat model

| Attack | Outcome |
|---|---|
| Buyer claims "I paid" with no proof | nothing to verify — rejected |
| Forged / tampered proof | fails cryptographic verification on-chain |
| Proof for a payment to someone else | proofs are address-bound — rejected |
| Reusing a real proof on another order | amount-nonce + `alreadyUsed` — `replay`/`underpaid` |
| Off by 1 piconero | integer-piconero compare — `underpaid` |
| **Time-locked payment** (tx with `unlock_time` — confirmations accrue but funds are frozen, possibly for years) | raw tx fetched from the daemon; `unlock_time ≠ 0` → `locked`. Fails **closed** if no node can return the tx |
| A node lies | `quorum: 2+` → `node-disagreement` |
| Endpoint spam | gate on "order exists & pending" before any RPC |
| Double-submit race (two orders, same txid, concurrent requests) | claim the txid atomically: UNIQUE constraint on `tx_hash` (or a synchronous check-and-set — see examples) |

## Hardening checklist (the part that stays on you)

- **`UNIQUE` constraint on `tx_hash`** in your orders table — the `alreadyUsed`
  callback narrows the window; the constraint closes it.
- **Use `makeAmountNonce` for every order** — it makes a proof structurally
  unable to fit any other order.
- **Scale `minConfirmations` with value** — 1 conf for small carts, 10 for
  high-value (reorg safety). `minConfirmations: 0` (mempool) is opt-in risk.
- **Set `quorum: 2` for high-value orders** — two independent nodes must agree.
- **Serve everything over HTTPS** and keep `verify-url` same-origin.
- **Never take `address` or `amount` from the request body** — always from your
  own order record (the examples already do this).
- **Your page is the trust root** — if your site is compromised, the displayed
  address can be swapped. The widget's trust panel gives buyers a human check;
  signed configs (next section) close it properly.

## Signed config (optional, tamper-evident address)

The page that renders the address is the trust root. If a merchant's site is
compromised, the address can be swapped. Signing moves address integrity onto a
key the merchant keeps off the web server, so a breach can serve the real
signed config or a broken one, but cannot mint a new one for the attacker's
address.

```js
const { generateSigningKey, signConfig, verifyConfig } = require('xmr-pay/config');

const key = generateSigningKey();                 // keep privateKey offline
const env = signConfig({ address, amount: '0.05', networkType: 'mainnet' }, key.privateKey);
// env.fingerprint e.g. "2847-789f-a55a-bd90" — publish this somewhere buyers can check
```

Serve the base64 of `env` to the widget:

```html
<xmr-pay config="<base64 envelope>" verify-url="/api/verify-payment"></xmr-pay>
```

The widget verifies the signature (WebCrypto Ed25519, no extra dependency),
uses the address from the signed config, and shows `Signed · <fingerprint>`. A
config that claims to be signed but fails verification shows a red warning and
no payable address. Pin a known signer with `pubkey="…"` or `fingerprint="…"`.

What it does and doesn't do: with the fingerprint known out of band (printed on
the product, pinned, listed in a directory) a buyer catches an address swap even
on a fully compromised page. Without that anchor it is tamper-evidence: a
"signed" config that no longer verifies is a clear red flag, but a fresh forgery
signed by the attacker's own key looks valid unless you pin.

## Privacy: what a node sees

When you verify a payment the lib asks one node for one transaction by its
txid. The node learns the **txid** and your **IP/timing**. It does not learn the
amount or the address — those are derived locally from the proof. This is less
than a normal wallet exposes (a full wallet asks a node about every block it
scans).

You can't "encrypt" this at the payload level: the node has to read the txid to
return the transaction. The exposure is closed at the connection level instead:

- **Run your own node** and put it first in `nodes`. Nothing leaks to anyone.
- **Tor.** Point at an `.onion` node, or run `monerod` egressing over Tor and
  target it on localhost. The node then sees a Tor circuit, not your IP.
- **HTTPS / `.onion` nodes** encrypt the transit so the network path can't read
  the txid either.

`nodes` takes any URL, so all three are configuration, not code changes.

## Demo

```
npm run demo     # http://localhost:8771 — live stagenet verification
```

Five widgets: both skins, signed config, a tampered config (refuses to render
a payable address), and a replay-defense pair — all against a real stagenet
verify endpoint.

## Validated

41 checks across four suites. Live on stagenet: verify 15/15 (tx-proof and
tx-key paths, nonce-grade amount exactness, address binding, replay, txid case
normalization, overpaid flag, quorum, mempool/0-conf, all through the
unlock_time gate). Offline: signed configs 10/10, watch mode 9/9 against a
mock wallet-rpc, and our payment URIs parse in the official wallet2 code 7/7.
Widget E2E in a real browser: paste proof → merchant endpoint → on-chain
verify → paid, then the same valid proof against a second order → rejected as
replay. Spot-checked against a real mainnet transaction key from a phone
wallet.

## Build it yourself (reproducible)

The widget is a plain concatenation of `widget/xmr-pay.part.js` and the pinned
`qrcode-generator` — no minifier, no timestamps. Rebuild and compare:

```
npm ci
npm run build
shasum -a 256 widget/xmr-pay.js     # must match SHA256SUMS in the release
```

Same inputs, same bytes. You never have to trust a binary you didn't build.

## Verify your download

Each release ships `SHA256SUMS` and a minisign signature `SHA256SUMS.minisig`.
The signing public key is `minisign.pub` in this repo:

```
RWSA/E4ogu5/1mQf2r66pkWK9fYBEeFdf2cvrjkhiALoXCWT3woSSRtH
```

```
minisign -Vm SHA256SUMS -P RWSA/E4ogu5/1mQf2r66pkWK9fYBEeFdf2cvrjkhiALoXCWT3woSSRtH
shasum -a 256 -c SHA256SUMS                # checks the files against it
```

From npm, the package is published with provenance, so npm shows the repo and
commit it was built from:

```
npm view xmr-pay --json | grep -i provenance
```

If a signature or hash does not match, do not use the file. Report it.

## Buy me a beer 🍺

If xmr-pay saved you from a payment processor, the tip jar is — of course — an
`<xmr-pay>` widget pointed at its own author. No account, no fee, no middleman;
exactly what the library is for.

```html
<xmr-pay
  address="42w9YaCW8UwZ2BmQztNmUd6JgYVcjW7LXEMTcQqHdmtFCsSo5RGY2eQg2iZ3WyBSSs63gnhczLkJ46yfr4ojCXWT3H1ZBbR"
  label="Buy me a beer"></xmr-pay>
```

Or just send to:

```
42w9YaCW8UwZ2BmQztNmUd6JgYVcjW7LXEMTcQqHdmtFCsSo5RGY2eQg2iZ3WyBSSs63gnhczLkJ46yfr4ojCXWT3H1ZBbR
```

## License

MIT. The widget bundles [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator)
(c) Kazuhiko Arase, MIT — vendored so the file makes zero external requests.

A [GoXMR](https://goxmr.click) project.
