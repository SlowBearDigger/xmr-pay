# Agent storage and recovery

The HTTP agent stores an order ledger and a wallet scan cache. Keep both: the ledger maps an order to its receiving subaddress; the wallet tracks subaddress allocation and scanned payments. Losing these files does not remove on-chain funds, but it can prevent automatic order reconciliation.

## Defaults

| Entry point | Orders | Wallet | Receipt key |
|---|---|---|---|
| `npx xmr-pay` | `orders.json` inside the configured data directory | persisted inside that directory | persisted inside that directory |
| `node examples/scanner-agent.js` | `XMR_ORDERS_FILE`, or `./orders.json` | `XMR_WALLET_PATH`, otherwise memory only | `XMR_RECEIPT_KEY`, or `./receipt-key.pem` |
| `createPaymentAgent()` | an in-memory `Map` unless `store` is supplied | configured separately on the scanner | not created by the library agent |

`XMR_PAY_DIR` controls the CLI data directory, default `./xmr-pay-data`. It does not relocate files when running the HTTP example directly. Keep the directory outside the web root. The CLI sets directory mode `700` and config mode `600` on Unix filesystems.

## Writes and restart

The HTTP agent saves wallet allocation and the order ledger before acknowledging a new order. A failure returns `503` and stops the process. Ledger writes use an exclusive temporary file, `fsync`, and rename; a corrupt existing ledger stops startup.

Status updates coalesce into a ledger write after one second. Paid transitions, receipts and webhook delivery results are saved explicitly. A periodic task also saves the ledger every 30 seconds and the wallet every two minutes. Shutdown saves both. These are separate files, not a cross-file database transaction.

At restart the agent reloads the ledger, reopens the wallet and scans forward. Pending orders can settle after the wallet catches up. Undelivered paid webhooks are retried. Without a persisted wallet, a fresh scanner defaults to the current tip and may miss payments received during downtime.

## Backups

Back up the ledger, wallet files, config and receipt signing key together while the agent is stopped, or use a consistent filesystem snapshot. Protect backups as secrets: they may contain the view key, node passwords, agent token and webhook secret.

A wallet cache can be rebuilt using the same address, view key, subaddress indexes and a restore height at or before the oldest relevant payment. The order mapping must also be restored. An unset restore height starts a new wallet at the tip; an unnecessarily low height increases scan time. Test recovery before relying on it.

Use one writer per ledger and wallet. The JSON store has no multi-process locking.

## Custom stores

`createPaymentAgent({ store })` expects synchronous Map-like methods: `has`, `set`, `get` and `values`. Expiry and paid retention also call `delete`. Hydrate the store before starting the agent.

The agent mutates stored order objects in place. A remote database adapter must persist changes from `onUpdate`, `onPaid` and `onExpire`, as well as order creation and retention deletion. Simply replacing `Map.set` with an asynchronous database call is not sufficient. Use the HTTP example's persistence flow as a reference and define how failures stop acknowledgment or fulfillment.

## Store integration

The commerce platform owns fulfillment, refunds and invoice balances. The agent owns payment detection and callback delivery. Keep their order IDs and receiving addresses linked in durable storage.

WooCommerce's native `watch` and `proof` modes keep scan state in WordPress and do not use the agent ledger. Agent mode uses both WordPress order records and the agent files. See [the agent guide](AGENT.md) and [HTTP contract](API.md).
