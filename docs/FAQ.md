# xmr-pay — FAQ & Guide

Accept Monero, non-custodial, with **no backend you have to run**.

> **The breakthrough, in one line:** the WordPress plugin verifies Monero payments
> **natively in PHP, inside WordPress itself** — no separate Node process, no
> `monero-wallet-rpc`, no daemon to keep alive. Just your site + a public Monero node.
> (The npm library does the same inside your own Node app.) That "verify Monero in pure
> PHP" path is the part nobody had shipped before — see "How we solved it" below.

This covers both products in the project:

- **`xmr-pay`** — the JavaScript/Node library + `<xmr-pay>` checkout widget + `npx xmr-pay` agent (this repo).
- **xmr-pay for WooCommerce** — the WordPress/WooCommerce plugin (separate repo).

The facts below are taken from the actual code (lib `xmr-pay@0.4.0-beta.1`, plugin
`0.1.5-beta`), not from memory.

---

# Part 1 — Plain language (start here)

**What is this?**
A way to take Monero payments on your store or app where the money goes **straight to
your own wallet**. There's no company in the middle, no account to sign up for, and
nothing of yours that we hold.

**Do I need a server or backend?**
No dedicated one. Payments are verified by code that runs **inside what you already
have** — your WordPress site (PHP), or your own app/serverless function (Node). The one
thing you always need is a **Monero node** to read the blockchain — you can use a free
public one or run your own. That's the deal: *no backend, but yes a node.*

**Is it custodial? Can you (or anyone) touch my money?**
No. It's **non-custodial**. We never hold a spend key, so no one but you can move your
funds. Payments land directly in your wallet.

**What do I actually need to start?**
- Your Monero **address**.
- A **Monero node** URL (a public one is fine).
- For *automatic* detection: your wallet's **private view key** (view-only — it can *see*
  incoming payments but **cannot spend**). It stays on your own server.

**WordPress or code — which do I use?**
- Run a WooCommerce store → install the **WordPress plugin**, fill in 3 fields, done.
- Building your own app/site → use the **npm library** (`npm i xmr-pay`).

**Which mode should I pick?** Three options, you choose:
1. **Auto-detect (recommended)** — the buyer pays and the order completes by itself. No
   buyer action. Needs your view key on your server.
2. **Buyer taps "I've paid"** — the lightest option: the buyer pastes their transaction
   ID (or a proof) and it's verified. Good if you'd rather not store a view key.
3. **Your own agent/infra** — run the separate `xmr-pay` daemon (advanced).

**Does the buyer have to do anything?**
In auto-detect mode, no — they pay and wait a moment. In "I've paid" mode, they paste a
transaction ID (every wallet shows it). Either way they scan a QR to pay.

**Is it safe?**
Honest answer: the **verification math is correct and tested** — it's cross-checked
against Monero's own library on real payments, with commitment checks and exact
piconero arithmetic. But "100% secure" isn't a claim anyone should make about money
software. What's on **you** (and is normal for any non-custodial tool): pick a node you
trust (or run your own), pick how many confirmations to require, and keep your site
secure. An independent audit is planned before a 1.0 mainnet push. (How it works and why
it's trustworthy is spelled out in "How we solved it" below.)

**Is it *really* serverless?**
Honest version: not magic, and not *nothing*. There's no **dedicated backend**, no daemon
to keep alive, no external service, and no custodian — the checking runs inside the
runtime you already have (WordPress's PHP, or your own app). You do still need a **Monero
node** to read the chain (a public one is fine, or run your own). So "no backend" — yes;
"no node at all" — no, and we don't pretend otherwise.

**What if a buyer underpays or overpays?**
Underpaid → the order stays unpaid (you can allow a small tolerance for dust). Overpaid →
the order completes and the buyer is told to contact you for the difference (refunds are
manual — see below).

**Refunds?**
Manual. Monero is non-custodial and a transaction doesn't reveal the sender, so there's
no address to auto-refund to. You send it back by hand.

**Fees?**
None from us. There's no processor and no account. You pay only the normal Monero network
fee on your own transactions.

**Should I test first?**
Yes — use **stagenet** (free, zero-value test coins) to try the whole flow, then switch
your wallet/address to mainnet.

---

# Part 2 — Technical

## Requirements & dependencies

### Library (`xmr-pay`, npm)
- **Node 18+** (uses `fetch`, `AbortSignal.timeout`; no `engines` field, but 18 is the floor). Not for **edge** runtimes (Cloudflare/Vercel Edge) when using the WASM verifier — use a Node function.
- **Runtime dependencies: zero.** `package.json` has no `dependencies`.
- **`monero-ts`** is an **optional peer dependency** (`>=0.11.0`), **lazy-required** — only loaded when a WASM wallet is actually needed (proof verify, the WASM scanner, the agent). `core`, `config`, `webhook`, and the wallet-rpc path never load it. The `npx` CLI auto-installs it on first run.
- **External:** a Monero node for anything on-chain. The wallet-rpc path (`verifyPaymentViaRpc`, `createWatcher`) needs a running `monero-wallet-rpc` instead and then needs **no** `monero-ts`.
- License **MIT**. Heads-up: `monero-ts` pins two old transitive deps with advisories (`serialize-javascript`, `uuid`); clear them with npm `overrides`, or skip `monero-ts` entirely via the wallet-rpc path.

### WordPress plugin (`xmr-pay-for-woocommerce`)
- **PHP 7.4+** (runs clean on 8.5), **WordPress 6.2+**, **WooCommerce 7.0+**. HPOS-compatible.
- **GMP PHP extension** — effectively required for the no-server (auto-detect / "I've paid") modes; the money math uses GMP so it's exact to uint64 (a BCMath fallback works but is ~10× slower). Agent mode does no crypto in PHP and doesn't need GMP.
- **No Composer, no Node, no separate daemon** for the no-server modes. The crypto is **vendored** in `includes/vendor/monero/`: `ed25519.php`/`base58.php`/`Varint.php`/`Cryptonote.php` from **monero-integrations/monerophp** (MIT, pinned commit) + `Keccak.php` from **kornrunner/php-keccak** (MIT). Vendored on purpose so it works on any shared host.
- **External:** a Monero node for the no-server modes. The plugin calls only public daemon RPCs over HTTP — `get_transactions`, `get_block` (json_rpc), `get_height` — and **never sends the view key to the node**.
- License **MIT**.

## The three modes, precisely

| | Auto-detect ("watch") | "I've paid" | Agent |
|---|---|---|---|
| Buyer action | none | pastes their txid | none |
| Needs your view key | **yes** (on your server) | **yes** (on your server) | no (the agent holds it) |
| Runs a separate daemon | no | no | **yes** (`npx xmr-pay`) |
| How it completes | scans the chain (WP-Cron + buyer poll) | verifies the submitted txid | agent detects + signed webhook |

> **Be clear on this:** in the **WordPress plugin, all three modes use your view key**
> (the "I've paid" mode verifies the buyer's *txid* with your view key — it is **not**
> keyless). The plugin has **no keyless path today.**
>
> The **truly keyless** option — where the buyer submits a Monero **tx proof**
> (`OutProofV2…`/`InProofV2…`) and it's verified with **no view key at all** — exists
> **only in the npm library** (`verifyPayment()`), not in the WooCommerce plugin yet.

Library pieces (subpath exports): `xmr-pay` (=`./verify`, keyless proof), `./scanner`
(view-only WASM watch), `./watch` (`createWatcher` over wallet-rpc + `verifyPaymentViaRpc`),
`./agent` (`createPaymentAgent`), `./core` (URI/QR/amount-nonce, keyless), `./webhook`
(HMAC), `./config` (signed configs, Ed25519), `./receipt` (signed receipts), `./widget`.

## Security model / what it does NOT do

- **The browser decides nothing.** A client-side "paid" event is **UX only** — fulfillment
  happens on your server's verification. A faked event "only fools their own screen."
- **The four on-chain guards** (the plugin scanner; the lib enforces the same): ownership
  (`Hs(8·a·R,i)·G + C` equals the output key), amount (RingCT ecdh decode), **commitment**
  (`C_chain == amount·H + mask·G` — the decoded amount is the *real* committed amount),
  and **unlock/confirmations** (spendable + settled). All fail **closed**.
- **Node trust.** Verification is only as honest as the node you query. Default is a single
  node (you trust it, or run your own). The **library** supports `quorum ≥ 2` (independent
  nodes must agree, fails closed on disagreement); the **plugin** uses one node today.
- **Replay.** Each order gets a unique amount (amount-nonce) and/or a per-order subaddress;
  a txid can settle exactly one order (the plugin dedups on `_xmrpay_proof_txid`). In the
  library, replay protection is **the caller's job and must be atomic** (`UNIQUE` on the
  tx hash).
- **Time-locks (`unlock_time`).** A future-locked (unspendable) payment is reported
  `locked`, never paid. Fails closed if no node returns the tx.
- **0-conf** (`minConfirmations: 0`) is opt-in risk (a mempool tx can be dropped) — use it
  for small/digital goods; scale confirmations with value (e.g. 10 for high value).
- **Reorgs after fulfillment.** Once an order is marked paid the poller stops re-checking
  it; a later reorg won't un-settle it. Choose confirmations for your value-at-risk.
- **View-key privacy.** The view key can *read* all your incoming payments but cannot
  spend. A leak is a **privacy** issue, not theft. In WordPress, prefer
  `define( 'XMRPAY_VIEW_KEY', '…' );` in `wp-config.php` so it stays out of the database,
  the settings screen, and backups. A queried node learns only the txid + your IP/timing
  (not the amount or address); run your own node or egress via Tor for max privacy.
- **Non-custodial → manual refunds / overpayments.** No spend key is ever held, so refunds
  and overpayment returns are sent by hand (the order records the exact excess).
- **Whale precision.** wallet-rpc returns atomic amounts as JSON numbers, exact below
  ~9007 XMR per transfer; the math fails closed past JS safe-integer (pass string/BigInt).

## Where data lives
The plugin creates **no custom tables** — settings in one option row, per-order data in
order meta, short-lived caches in transients, two idempotent WP-Cron jobs. Full map:
the plugin's `docs/DATA-AND-FOOTPRINT.md`.

---

# Getting started

## WordPress (WooCommerce)
1. Install & activate the **xmr-pay for WooCommerce** plugin.
2. WooCommerce → Settings → Payments → **Monero (xmr-pay)**.
3. Pick a **mode** (Auto-detect is recommended).
4. Enter your **Monero address**, your **private view key** (or set `XMRPAY_VIEW_KEY` in
   `wp-config.php`), and a **node** URL.
5. Set confirmations (1 is a good default; 0 = instant/riskier).
6. Test on **stagenet** first, then switch to your mainnet wallet.

> The settings are grouped into "No-server settings (Auto-detect & I've paid)" — address,
> view key, node(s), confirmations — and "Agent settings (advanced)" for Agent mode. Fill
> in the group that matches your chosen mode.

## Node / your own app (npm)
```bash
npm i xmr-pay            # zero runtime deps; add monero-ts for watch/WASM-proof
```
- **Keyless proof** (buyer submits a proof; nothing to run 24/7):
  ```js
  const { verifyPayment } = require('xmr-pay');
  const r = await verifyPayment({ txid, proof, address, amount, nodes, minConfirmations: 1, quorum: 2 });
  // r.paid === true → fulfill (bind address+amount from YOUR order, dedup r.txid)
  ```
- **Self-watch** (auto-detect inside your own process — no separate agent): drive
  `./scanner` (`createScanner` + `checkOrders`) or `./agent` (`createPaymentAgent`) from
  your app's own loop/cron.
- **Turnkey agent**: `npx xmr-pay` — a wizard asks for network, address, view key, node,
  and writes a `config.json` (mode 600), then runs the HTTP agent.

See the library `README.md`, `docs/AGENT.md` (watch agent), `docs/DEPLOY.md` (serverless
verify), `docs/WALLETS.md` (how a buyer gets a proof), and `docs/STORAGE.md` (persistence).

---

# How we solved it (and why you can trust it)

**Being honest about "serverless."** It isn't magic, and it isn't *nothing*. The point is
not "no computer runs" — it's **no dedicated backend, no daemon to babysit, no external
service, and no custodian.** The verification runs inside the runtime you *already* have:
**WordPress's own PHP**, or your **own Node app/function**. The only outside thing is a
**Monero node** to read the chain — which was always unavoidable, and which you can run
yourself. So: "no backend," yes. "No node," no — and we never claimed that.

**The hard part we solved.** WordPress is PHP; it cannot run the JavaScript/WASM Monero
crypto. The usual answer is "run a separate Node daemon (the agent)" — a 24/7 process most
WordPress merchants won't keep alive. So we did the thing nobody had: **we verify Monero
payments in pure PHP, inside WordPress itself.** Given a buyer's transaction (and, for
auto-detect, your view key), PHP fetches the public transaction data from a node and
checks four things, all failing **closed**:

1. **Ownership** — the output's one-time key equals `Hs(8·a·R, i)·G + C`. Only your view
   key + your address can produce this, so the output is provably yours.
2. **Amount** — the RingCT amount is decoded: `amount = ecdhInfo ⊕ first8(keccak("amount" ‖ Hs(D,i)))`.
3. **Commitment** — `C_chain == amount·H + mask·G`. This proves the decoded amount is the
   *real committed* amount on-chain, not a forged value.
4. **Spendable + settled** — `unlock_time` elapsed and enough confirmations.

**Why it's trustworthy — verified, not asserted.** The money math is **exact** (piconero
integers via GMP, correct up to uint64 — no floating-point drift), and the whole verifier
was **cross-checked against Monero's own reference library (monero-ts) on real on-chain
payments** (a primary address and a per-order subaddress on stagenet both reproduced the
exact amount monero-ts reported). On top of that: a **92,000-case fuzz** over the
piconero math, a suite that **mirrors monerod's own `parse_amount` tests**, and adversarial
suites (replay, time-locks, double-spend, malformed proofs). It is correct *because the
tests show it matches Monero*, not because we say so. (Still on you, as with any
non-custodial tool: pick a node you trust or run your own; pick your confirmation count;
an independent audit is planned before a 1.0 mainnet push.)

**Why this is good for you.** Non-custodial like running your own node, easy like a hosted
processor — no fees, no account, no API key, no third party who can freeze or see your
revenue, and nothing to keep running. Just your store + the Monero network.

# Credits

We stand on excellent open-source work, with thanks:

- **[monero-project](https://www.getmonero.org/)** — the protocol, and `parse_amount`'s
  own unit tests, which our money-math parity suite mirrors.
- **[monero-integrations / monerophp](https://github.com/monero-integrations/monerophp)**
  (MIT) — the pure-PHP ed25519, key-derivation and base58 primitives the WordPress-native
  verifier is vendored on. The breakthrough that made "verify in PHP" possible.
- **[kornrunner/php-keccak](https://github.com/kornrunner/php-keccak)** (MIT) — Keccak-256
  with Monero's padding, in pure PHP.
- **[monero-ts](https://github.com/woodser/monero-ts)** (woodser, MIT) — the WASM Monero
  library powering the Node library's watch/proof paths, and our ground-truth reference
  for cross-checking the PHP verifier.
- **[qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator)** (MIT) — the
  checkout widget's self-contained QR encoder.
- **Inspiration:** [BTCPay Server](https://btcpayserver.org/)'s Monero plugin and
  [MoneroPay](https://gitlab.com/moneropay/moneropay) — we studied both to match (and, on
  reorg-safety, double-spend and arithmetic, exceed) their detection model.

A [GoXMR](https://goxmr.click) project · MIT.
