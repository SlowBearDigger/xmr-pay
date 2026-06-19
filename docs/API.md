# xmr-pay — HTTP API

Two small HTTP surfaces ship with the library, so you can accept Monero from **any**
stack (PHP, Python, Go, Ruby, a static site + a function) — not just Node:

- **The agent** (`npx xmr-pay`, i.e. `examples/scanner-agent.js`) — watch mode: it holds
  your **view key**, scans the chain, and exposes a tiny order API. Run it on a box you
  control (bind to localhost / a private network).
- **The keyless verifier** (`examples/verify-keyless.js`) — proof mode: a **stateless,
  keyless** endpoint that verifies a buyer's tx proof. Holds no keys and no order state;
  one instance can serve many stores, and anyone can run their own.

All requests/responses are JSON. Amounts are XMR decimal strings unless noted; the
authoritative integer is piconero (1 XMR = 1e12 piconero).

---

## The agent API

Base URL is whatever you bind it to (default `http://127.0.0.1:8788`). If you set
`AGENT_TOKEN`, send `Authorization: Bearer <token>` on `/order*` and `/receipt*`.

### `POST /order`
Create an order and get a fresh per-order subaddress to show the buyer.

Request: `{ "amount": "0.05", "id": "order-123", "label": "My Store #123" }`
(`amount` required; `id` optional — yours; `label` optional.)

Response `200`:
```json
{ "id": "order-123", "address": "8…", "amount": "0.05", "status": "pending", "birthdayHeight": 3211904 }
```
Errors: `400` (bad/missing amount), `401` (bad token), `409` (id already exists).

### `GET /order/:id`
Poll an order's status (reads cached state — the background poller keeps it fresh; never
triggers a per-request sync).

Response `200`:
```json
{
  "id": "order-123", "paid": false, "status": "mempool",
  "amount": "0.05", "receivedXmr": "0.05", "lockedXmr": "0",
  "shortfallXmr": "0", "overpaid": false, "overpaidXmr": "0",
  "confirmations": 0, "minConfirmations": 1,
  "tipHeight": 3211950, "walletHeight": 3211950, "syncing": false,
  "txids": ["…"], "webhookDelivered": true
}
```
`status` ∈ `pending | mempool | unconfirmed | partial | underpaid | locked | paid`.
`syncing: true` means the scanner is behind the tip (show "node catching up", not a bare
"pending"). `404` if the id is unknown.

### `GET /order/:id/stream`  (Server-Sent Events)
A push channel — each event is the same JSON snapshot as `GET /order/:id`, emitted the
instant the poller folds a change (the buyer's page updates in seconds, no polling lag).
`Content-Type: text/event-stream`; the server sends an initial snapshot on connect and a
`: ping` heartbeat. Token (if set) may be passed as `?token=<token>` (EventSource can't set
headers). The plain poll is a fine fallback if a proxy buffers SSE.

### `GET /receipt/:id`
The signed, self-contained receipt for a paid order (download/verify offline; also
verifiable on-chain via its embedded tx proofs). `409` until the order is paid; token-gated.

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
  "received_xmr": "0.05", "overpaid": false, "overpaid_xmr": "0",
  "address": "8…", "txids": ["…"], "confirmations": 1,
  "network": "mainnet", "receipt": { … }, "event_ts": 1750000000000 }
```
Idempotent on `order_id`; `event_ts` (ms) is a replay-window guard.

---

## The keyless verifier API

`examples/verify-keyless.js` — run standalone (`node verify-keyless.js`, default
`http://127.0.0.1:8795`) or deploy `createVerifyHandler()` as a serverless function.
**Stateless and keyless:** it verifies one proof against **its own** configured nodes and
reports the verdict. It is **not** the replay authority — your store dedups the returned
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
{ "paid": true, "status": "ok", "reason": "", "receivedXmr": 0.05,
  "confirmations": 3, "overpaid": false, "overpaidXmr": "0",
  "txid": "<lowercased>", "nodesAgreed": 2 }
```
`status` ∈ `ok | underpaid | unconfirmed | mempool | no-funds | locked | invalid |
node-disagreement`. `400` (bad input — never reaches a node), `401` (token), `429`
(rate-limited), `502` (`status: node-error`, retryable).

### `GET /healthz`
`{ "ok": true, "keyless": true, "network": "mainnet", "nodes": 2 }`

---

## Using it without Node
You don't need Node in your app — your app just makes HTTP calls to one of these. The
WordPress plugin, for example, talks to the agent over HTTP in agent mode, and to a keyless
verifier in proof mode. Any backend that can POST JSON can integrate the same way. (The
WordPress plugin can also skip both and verify in pure PHP — see that project.)
