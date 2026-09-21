# Deploying a proof endpoint

[`examples/serverless.js`](../examples/serverless.js) shows how to verify a buyer's transaction ID and proof against server-owned order data. It is a reference handler, not a complete store: its order map and rate limiter are in memory.

## Requirements

Use Node 20 or later with `xmr-pay` and `monero-ts`. Follow the [dependency overrides](../SECURITY.md#dependencies) and check the resolved installation. WASM verification needs a Node runtime; this example does not support edge runtimes. Allow enough startup time for the wallet library and node requests.

Before accepting orders, replace the sample `ORDERS` map with durable storage. Load the expected address and amount from that record. Atomically claim the transaction ID and mark the order paid in one database transaction, with a unique transaction-hash constraint. Persist fulfillment work so it can be retried after a crash.

The sample's webhook send has bounded retries only. It does not implement the watch agent's durable redelivery queue. The sample also has no automatic order-expiry policy.

## Configuration

| Variable | Purpose |
|---|---|
| `XMR_ADDRESS` | address for the sample order |
| `XMR_NODES` | comma-separated node URLs |
| `XMR_QUORUM` | number of agreeing nodes required; default `2` |
| `CORS_ORIGIN` | allowed browser origin; set the exact store origin |
| `VERIFY_TOKEN` | optional server-to-server bearer secret; never embed it in a widget |
| `VERIFY_RL_MAX` | per-process requests per IP per 60-second window; default `30` |
| `FULFILL_WEBHOOK_URL` | optional fulfillment destination |
| `FULFILL_WEBHOOK_SECRET` | shared HMAC secret when sending a webhook |

The example calls `verifyPayment` with its default mainnet network. For stagenet, pass `networkType: 'stagenet'` in that call and use matching addresses and nodes. Setting an unused environment variable does not change the network.

## Hosting

For a Node serverless host, place the handler at the platform's function route, install its dependencies and connect the durable order store. Provider request limits must accommodate WASM startup and node verification. For Express:

```js
const express = require('express');
const handler = require('./serverless');
const app = express();
app.use(express.json({ limit: '16kb' }));
app.all('/api/verify-payment', handler);
app.listen(3000, '127.0.0.1');
```

Use a TLS reverse proxy for public traffic. The example trusts `x-forwarded-for` for rate limiting, so the proxy must overwrite that header. Enforce shared rate limits at the proxy or application layer when using multiple instances. CORS controls browser access; it is not endpoint authentication.

## Widget

Render the amount and address from the same order record used by the verifier:

```html
<xmr-pay
  address="4YOUR_ADDRESS"
  amount="0.050000000817"
  order="ord_123"
  verify-url="/api/verify-payment"></xmr-pay>
```

The buyer submits a transaction ID and tx key or proof. The widget displays the result and may emit `xmr-pay:paid`; fulfillment belongs to the server. This proof path needs no merchant view key.

For cross-origin requests, set `CORS_ORIGIN` to the checkout origin. The sample allows the `Content-Type` header. A private bearer-protected endpoint should be called by your backend, since the widget has no bearer-token option.
