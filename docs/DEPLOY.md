# Deploy the verify function (serverless, free tier)

The only server piece is one stateless function that re-checks a buyer's proof
on-chain. Your static checkout (GitHub Pages, anywhere) calls it; it never sees
a third party. This is the **private, per-user, real-time** detection path —
the one to use for a store.

Reference handler: [`examples/serverless.js`](../examples/serverless.js).

## What it needs

- Node 18+ runtime (Vercel/Netlify/Render functions, or your own server). It
  uses `monero-ts` (WASM) for verification — that runs in Node serverless, but
  **not on edge runtimes** (Cloudflare Workers / Vercel Edge). Use a Node
  function, not edge.
- `monero-ts` as a dependency: `npm i xmr-pay monero-ts`.
- Your order store. The example uses an in-memory `Map`; swap it for your real
  database and put a **`UNIQUE` constraint on `tx_hash`** (the atomic replay
  guard).

## Vercel (one file)

```
your-project/
  api/verify-payment.js   ← paste examples/serverless.js here
  package.json            ← deps: xmr-pay, monero-ts
```

Set env vars in the Vercel dashboard:

| var | value |
|-----|-------|
| `XMR_ADDRESS` | your Monero address |
| `XMR_NODES` | comma-separated node URLs you trust (your own first) |
| `CORS_ORIGIN` | your site origin, e.g. `https://you.github.io` (or `*` for a public tip endpoint) |
| `FULFILL_WEBHOOK_URL` | optional — where to POST `order.paid` |
| `FULFILL_WEBHOOK_SECRET` | optional — HMAC secret for that webhook |

Deploy. Your endpoint is `https://your-app.vercel.app/api/verify-payment`.

## Plain Node / Express

```js
const express = require('express');
const handler = require('./serverless');   // the reference handler
const app = express();
app.use(express.json());
app.all('/api/verify-payment', handler);
app.listen(3000);
```

Render / Railway / Fly / a VPS all work the same way.

## Wire the widget to it

```html
<xmr-pay
  address="4YOUR_ADDRESS…"
  amount="0.050000004821"
  order="ord_123"
  verify-url="https://your-app.vercel.app/api/verify-payment"></xmr-pay>
```

The buyer pays, expands "prove it", pastes the tx key/proof; the widget POSTs to
your function; your function verifies on-chain and returns `paid`. The widget
flips to confirmed and fires `xmr-pay:paid`.

## CORS, the part everyone hits

If the widget's page and the function are on different origins (a github.io site
calling a vercel.app function), the browser sends a preflight `OPTIONS` and
requires `Access-Control-Allow-Origin`. The reference handler sets it from
`CORS_ORIGIN`. Set that to your exact site origin in production; `*` only for a
public, no-secrets tip endpoint.

## Why not pure client-side?

You can skip the function entirely and scan in the browser — but then the
**view key has to live in the page**, public to everyone, and the page carries
a full `monero-ts` WASM wallet that syncs the chain on every load (heavy, and
the flaky part of any such setup). That is only acceptable for a public
donation address where you don't mind every incoming payment being visible.
For a store, run the function — the view key never leaves your machine.
