# Payment agent

The agent is a long-running Node service that scans a view-only wallet, assigns a subaddress to each order, sums payments and sends signed `order.paid` notifications. It needs a Monero node and `monero-ts`, but no `monero-wallet-rpc` process.

## Quickstart

Use Node 20 or later. From an installed release, `npx xmr-pay` runs the setup wizard and starts the agent. `npx xmr-pay start` reuses that configuration. The CLI persists its wallet, orders and signing key under `XMR_PAY_DIR`.

To run the source example directly, install `monero-ts` with the [documented dependency overrides](../SECURITY.md#dependencies), then set the following values. Replace both key placeholders with matching stagenet credentials and create a private data directory before starting.

```bash
mkdir -p xmr-pay-data
chmod 700 xmr-pay-data
export AGENT_TOKEN="$(openssl rand -hex 32)"
export FULFILL_WEBHOOK_SECRET="$(openssl rand -hex 32)"
XMR_PRIMARY_ADDRESS="5your_stagenet_primary_address" \
XMR_VIEW_KEY="your_private_view_key" \
XMR_NETWORK=stagenet \
XMR_NODES="http://node.monerodevs.org:38089" \
XMR_WALLET_PATH="./xmr-pay-data/wallet" \
XMR_ORDERS_FILE="./xmr-pay-data/orders.json" \
XMR_RECEIPT_KEY="./xmr-pay-data/receipt-key.pem" \
FULFILL_WEBHOOK_URL="https://your-shop.example/internal/xmr-paid" \
node examples/scanner-agent.js
```

Keep the generated secrets on the merchant backend. Configure the webhook receiver with the same webhook secret.

```bash
curl -s http://127.0.0.1:8788/order \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"id":"ord_42","amount":"0.05"}'

curl -s http://127.0.0.1:8788/order/ord_42 \
  -H "Authorization: Bearer $AGENT_TOKEN"
```

Show the buyer the returned subaddress and amount. Your backend checks status or receives the webhook; it must not expose the agent token to the browser. Use unguessable order IDs or an authenticated store endpoint for buyer status.

### Configuration

| Variable | Required | Default | What it is |
|---|---|---|---|
| `XMR_PRIMARY_ADDRESS` | yes | none | your wallet's primary address |
| `XMR_VIEW_KEY` | yes | none | your **private view key** (view-only; cannot spend) |
| `XMR_NODES_JSON` | one of these | - | preferred for protected nodes; JSON array with one independent row per node |
| `XMR_NODES` | one of these | - | legacy unprotected Monero node URLs, comma-separated; your own first |
| `XMR_NETWORK` | | `mainnet` | `mainnet` · `stagenet` · `testnet` |
| `XMR_RESTORE_HEIGHT` | | tip | new wallets start at the current tip; set an earlier height for recovery |
| `XMR_WALLET_PATH` | | in-memory | persist the wallet so restarts skip re-scanning |
| `XMR_MIN_CONFIRMATIONS` | | `1` | raise for high-value orders (reorg safety) |
| `XMR_TOLERANCE_XMR` | | `0` | accept a buyer who lands short by up to this (absorbs dust/fee/rounding so they aren't stuck "underpaid"). `0` = exact; never allowed to reach the price |
| `XMR_EXPIRY_HOURS` | | `0` | drop unpaid orders after N hours (bounds per-tick work + memory; `0` = never). A late payment still lands on-chain: it just won't auto-complete. |
| `XMR_PAID_RETENTION_HOURS` | | `0` | retire SETTLED orders after N hours (`0` = keep forever). The store/webhook is the source of truth; without this, paid orders accumulate for the agent's lifetime. `GET /order/:id` and `GET /receipt/:id` 404s after retirement, so set it well past your buyers' poll window. |
| `POLL_MS` | | `15000` | idle polling interval in milliseconds |
| `POLL_ACTIVE_MS` | | `3000` | interval while a checkout is active or a status stream is connected |
| `XMR_CHECKOUT_WINDOW_MIN` | | `30` | how long a new unpaid order keeps active polling enabled |
| `FULFILL_WEBHOOK_URL` / `_SECRET` | when using callbacks | none | callback destination and shared signing secret; set both |
| `AGENT_TOKEN` | yes | none | `Bearer` token for order, receipt, and health endpoints; required on every bind address |
| `BIND` / `PORT` | | `127.0.0.1` / `8788` | keep it on localhost; every bind requires `AGENT_TOKEN` |
| `XMR_SUBADDRESS_POOL` | | `8` | how many fresh subaddresses to pre-derive to reduce allocation latency; creation still saves the wallet before returning |
| `XMR_SYNC_TIMEOUT_MS` | | `120000` | per-sync and protected-node RPC deadline; on a stall the agent fails over to the next node |
| `XMR_SYNC_GAP` | | `2` | wallet-to-daemon height gap allowed before status reports syncing |
| `XMR_WEBHOOK_SWEEP_MS` | | `30000` | how often to retry undelivered `order.paid` webhooks (durable redelivery) |
| `XMR_MERCHANT_NAME` | | none | shown on signed receipts |
| `XMR_RECEIPT_KEY` | | auto | path to the receipt-signing key (PEM); generated + persisted if absent |
| `XMR_RECEIPT_TXPROOF` | | on | attempt to embed receipt tx proofs; set `0` to disable. Proof generation can fail independently of settlement. |
| `XMR_WALLET_PASSWORD` | | none | encrypts the persisted wallet file at `XMR_WALLET_PATH` |
| `XMR_ORDERS_FILE` | | `./orders.json` | direct-example ledger path; the CLI sets a path inside its data directory |
| `XMR_PAY_DIR` | | `./xmr-pay-data` | data dir for the `npx xmr-pay` CLI (config, wallet, orders, keys) |

Set `AGENT_TOKEN` before starting the agent, including when it binds to `127.0.0.1`. Expose only the routes buyers need; never proxy the entire agent API.

Keep `XMR_PAY_DIR` outside the web root on a filesystem that enforces file ownership. On Unix, the CLI sets the data directory to mode `700` and its config to `600` on setup and start.

#### Protected nodes and failover

Use `XMR_NODES_JSON` when a daemon requires HTTP Basic or Digest authentication.
Each node has its own authentication settings, so failover never reuses one
node's credentials with another node.

```bash
export XMR_NODES_JSON='[
  {
    "url": "https://monero-primary.example:18081",
    "auth": "digest",
    "username": "merchant",
    "password": "<node-password>"
  },
  {
    "url": "https://monero-backup.example:18081",
    "auth": "basic",
    "username": "merchant-backup",
    "password": "<backup-password>"
  }
]'
```

Allowed `auth` values are `none`, `basic`, and `digest`. Credentials embedded in
the URL are rejected. Authenticated plain HTTP is also rejected unless that row
explicitly includes `"allow_insecure_http": true`; use that exception only on a
network you trust because HTTP does not encrypt the credentials or RPC traffic.

`XMR_NODES_JSON` takes precedence over `XMR_NODES` and malformed JSON stops the
agent instead of silently falling back. Protected daemons are reached through a
per-node bridge bound to an ephemeral `127.0.0.1` port because wallet2 does not
reliably negotiate every reverse proxy challenge. Passwords stay in the agent
process and are omitted from status responses and error messages. The bridge
forwards only the read-only daemon routes and JSON-RPC methods needed by wallet2;
mutating daemon calls are rejected locally.

The setup wizard asks for every node separately and stores its configuration in
`xmr-pay-data/config.json` with mode `600` on systems that support Unix file
permissions. It probes every configured node, reports unavailable rows as
warnings, and uses the first reachable height in configured order. Keep that
directory private and out of source control.


## Settlement and delivery

The scanner checks wallet capability with `isViewOnly()`. The HTTP agent refuses to start unless that check returns true. The private view key remains on the merchant's system; node passwords are sent only to their configured nodes for authentication.

A payment counts when its amount and confirmation policy pass and any explicit `unlock_time` has elapsed. Ordinary wallet maturation is not an extra ten-confirmation requirement: `XMR_MIN_CONFIRMATIONS` controls acceptance. A paid order remains paid even if a later reorganisation removes the payment. Choose confirmations for the value being delivered.

`order.paid` delivery is retried, so receivers must verify the HMAC and process duplicates idempotently. The library callback is not an exactly-once delivery guarantee. Keep one agent writer per wallet and ledger.

Order status is cached between scans. New checkouts and connected streams use the active polling interval; idle periods use `POLL_MS`. Node delays and wallet catch-up affect detection time.

## Persistence and expiry

The HTTP example persists orders to its JSON ledger; the library `createPaymentAgent()` defaults to memory. Persist the wallet as well as orders for restart recovery. See [STORAGE.md](STORAGE.md).

Expiry and paid retention default to disabled. Expiry removes only orders with a successful check and no detected funds; it does not return a payment or stop the address receiving funds. Retention preserves paid orders with an undelivered webhook. Retired orders and receipts return `404`, so keep records in the store for accounting and support.

## Node trust and network access

The JavaScript watch scanner uses one active node and switches nodes on failure. This is failover, not independent quorum verification. Nodes see the agent's network address, request timing and requested chain data; address matching happens locally. Run trusted nodes and protect the host that holds the view key.

Every HTTP route requires the agent token, including health and receipts. Bind to loopback and proxy only the buyer-specific routes your store needs. The [HTTP API](API.md) lists request limits, response fields and error codes; [EVENTS.md](EVENTS.md) describes callback handling.

## Embed the library

Create a scanner and order manager inside your service. This example uses an
in-memory order store; add durable storage before using it for fulfillment:

```js
const { createScanner } = require('xmr-pay/scanner');
const { createPaymentAgent } = require('xmr-pay/agent');

const scanner = await createScanner({ primaryAddress, privateViewKey, networkType, nodes });
const agent = createPaymentAgent({ scanner, minConfirmations: 1, onPaid: (o) => fulfil(o) });
agent.start();

const order = await agent.createOrder({ id: 'ord_42', amount: '0.05' });  // → { address, … }
const status = await agent.check('ord_42');                               // live: { paid, shortfallXmr, … }
```
