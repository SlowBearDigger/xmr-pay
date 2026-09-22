# xmr-pay: HTTP API

The library includes two HTTP services that a merchant backend can call:

- **The agent** (`npx xmr-pay`, i.e. `examples/scanner-agent.js`): watch mode: it holds
  your **view key**, scans the chain, and exposes a tiny order API. Run it on a box you
  control (bind to localhost / a private network).
- **The keyless verifier** (`examples/verify-keyless.js`): proof mode: a **stateless,
  keyless** endpoint that verifies a buyer's tx proof. Holds no keys and no order state;
  one instance can serve many stores, and anyone can run their own.

Requests and ordinary responses are JSON; the stream endpoint uses Server-Sent Events.
Expected amounts and shortfalls use decimal strings. `receivedXmr`, `pendingXmr`,
`lockedXmr` and webhook `received_xmr` are display numbers. Accounting comparisons
use integer piconero (1 XMR = 1e12 piconero).

---

## The agent API

Base URL is whatever you bind it to (default `http://127.0.0.1:8788`). Set
`AGENT_TOKEN` and send `Authorization: Bearer <token>` on `/order*`, `/receipt*`, and `/healthz`.
The agent refuses to start without a token, including on loopback.
Keep this token on the merchant backend; expose only buyer-specific proxy routes.

### `POST /order`
Create an order and get a fresh per-order subaddress to show the buyer.

Request: `{ "amount": "0.05", "id": "order-123", "label": "My Store #123" }`
Send `Content-Type: application/json`; the body limit is 16 KiB. `amount` must be
positive; a decimal string preserves precision. Optional `id` is a nonempty string
(up to 2048 characters) or a safe nonnegative integer, normalized to a string by HTTP.
Omitting it generates a random ID. Optional `label` is a string up to 256 characters.
URL-encode the ID when placing it in a request path.

Response `200`:
```json
{ "id": "order-123", "address": "8…", "amount": "0.05", "status": "pending", "birthdayHeight": 3211904 }
```
Errors: `400` (malformed JSON or object), `401` (bad token), `409` (invalid or duplicate order), `413` (body too large), `415` (JSON content type required), `503` (persistence unavailable).

### `GET /order/:id`
Poll an order's status (reads cached state: the background poller keeps it fresh; never
triggers a per-request sync).

Response `200`:
```json
{
  "id": "order-123", "paid": false, "status": "mempool",
  "amount": "0.05", "receivedXmr": 0, "pendingXmr": 0.05, "lockedXmr": 0,
  "shortfallXmr": "0", "overpaid": false, "overpaidXmr": "0",
  "confirmations": 0, "minConfirmations": 1,
  "tipHeight": 3211950, "walletHeight": 3211950, "syncing": false,
  "txids": ["…"], "webhookDelivered": true
}
```
`status` ∈ `pending | mempool | unconfirmed | partial | underpaid | locked | paid`.
`syncing: true` means either height is unavailable or the scanner is behind the tip (show "node catching up", not a bare
"pending"). `404` if the id is unknown.

### `GET /order/:id/stream`  (Server-Sent Events)
A push channel: each event is the same JSON snapshot as `GET /order/:id`, emitted the
time the poller updates an order. Detection still depends on node and scan latency.
`Content-Type: text/event-stream`; the server sends an initial snapshot on connect and a
`: ping` heartbeat. Send `AGENT_TOKEN` in the `Authorization` header.
Browser `EventSource` cannot set that header, so use a restricted store proxy that adds
it server-side. Never put the agent token in a browser URL. The plain poll is a fine
fallback if a proxy buffers SSE.

### `GET /receipt/:id`
The signed, self-contained receipt for a paid order (download/verify offline; also
verifiable on-chain when tx proofs are present). `409` while unpaid or while a receipt
is unavailable, including a signing failure; `404` for an unknown or retired order.

### `GET /healthz`
```json
{ "ok": true, "network": "mainnet", "node": "…", "viewOnly": true,
  "orders": 3, "pool": 8, "receipt": "a1b2-…", "undeliveredWebhooks": 0,
  "streamClients": 1, "walletHeight": 3211950, "daemonHeight": 3211950, "synced": true }
```

### Fulfillment webhook (agent → your store)
When an order settles, the agent POSTs a signed `order.paid` to your `FULFILL_WEBHOOK_URL`
(durable: retried with backoff until delivered). Header
`X-XMR-Pay-Signature: sha256=<hmac>` over the raw body, keyed by `FULFILL_WEBHOOK_SECRET`;
verify it constant-time (`xmr-pay/webhook` → `verifySignature`). Body:
```json
{ "event": "order.paid", "order_id": "order-123", "amount_xmr": "0.05",
  "received_xmr": 0.05, "overpaid": false, "overpaid_xmr": "0",
  "address": "8…", "txids": ["…"], "confirmations": 1,
  "network": "mainnet", "event_ts": 1750000000000 }
```
An optional `receipt` field contains the signed envelope returned by `/receipt/:id`.
The receiver must process each order idempotently; delivery can repeat. `event_ts`
(milliseconds) is a replay-window guard, not a unique payment identifier. Redirects
are rejected. See [EVENTS.md](EVENTS.md) for delivery and settlement semantics.

---

## The keyless verifier API

`examples/verify-keyless.js`: run standalone (`node examples/verify-keyless.js`, default
`http://127.0.0.1:8795`) or deploy `createVerifyHandler()` as a serverless function.
**Stateless and keyless:** it verifies one proof against **its own** configured nodes and
reports the verdict. It is **not** the replay authority: your store dedups the returned
`txid`, and binds `address`+`amount` from your own order before calling.

### `POST /verify`
Request:
```json
{ "txid": "<64 hex>", "proof": "OutProofV2… / InProofV2…", "address": "4…",
  "amount": "0.05", "minConfirmations": 1 }
```
Notes: the **server** picks the nodes, network and quorum (a caller can't point it at
arbitrary nodes); `minConfirmations` may only be **raised** above the server floor, never
lowered.

Response `200`:
```json
{ "paid": true, "status": "paid", "reason": "verified on-chain", "receivedXmr": 0.05,
  "confirmations": 3, "overpaid": false, "overpaidXmr": "0",
  "txid": "<lowercased>", "nodesAgreed": 2 }
```
`status` ∈ `paid | underpaid | unconfirmed | mempool | no-funds | locked | invalid |
node-disagreement | node-error`. Normal verifier results, including `node-error`,
use HTTP `200`; inspect `paid` and `status`. Handler validation returns `400`,
a bad token returns `401`, rate limiting returns `429`, and a thrown verification
error returns `502` with `status: node-error`.

### `GET /healthz`
`{ "ok": true, "keyless": true, "network": "mainnet", "nodes": 2 }`

---

## Using it from another backend

Any backend can call these endpoints. WooCommerce uses the agent API only in agent
mode; its native watch and proof modes verify in PHP with the merchant's view key.
Its native proof mode does not call the keyless JavaScript verifier.
