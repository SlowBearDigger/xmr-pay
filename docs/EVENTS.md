# Invoice states and payment events

The state helpers live in [`src/state.js`](../src/state.js) and are mirrored by PHP's `to_invoice_state`. They classify payment evidence; they do not send webhooks by themselves.

## States

| State | Payment statuses | Meaning |
|---|---|---|
| `created` | `pending` | no payment recorded |
| `processing` | `mempool`, `unconfirmed`, `partial`, `underpaid`, `locked` | funds detected, settlement requirements not met |
| `settled` | `paid` | payment accepted under the configured policy |
| `expired` | `expired` | unpaid order removed after its configured window |
| `invalid` | `invalid` | order or payment cannot be accepted as configured |

Verification-attempt results such as `node-error`, `node-disagreement`, `replay` and `no-funds` do not define an invoice transition. The state mapper returns `null` for them.

Settlement latches: the agent stops polling a paid order and does not reverse fulfillment after a chain reorganisation. Increasing confirmations reduces this risk; it does not eliminate it. Zero confirmations can accept a mempool transaction that is later dropped.

## Expiry

The agent expires an order only after a successful check with no received, pending or locked funds. A failed sync or check prevents expiry in that tick. Expired orders are removed from its store, so subsequent status requests return `404`.

WooCommerce keeps orders with detected funds on hold. Its PHP watch scanner reads blocks and may not see unmined transfers. Native proof mode depends on the buyer submitting a transaction ID. A late or unseen payment can therefore require manual reconciliation after expiry. Automatic expiry defaults to disabled (`0`).

## Delivered webhook: `order.paid`

The HTTP agent currently sends one event type, `order.paid`. It saves the paid order and retries undelivered notifications with backoff, including after restart. A receiver may see the same payment more than once, for example when it processes a request but its response is lost.

```json
{
  "event": "order.paid",
  "order_id": "ord_42",
  "amount_xmr": "0.05",
  "received_xmr": 0.05,
  "overpaid": false,
  "overpaid_xmr": "0",
  "address": "8...",
  "txids": ["787a2f..."],
  "confirmations": 3,
  "network": "mainnet",
  "event_ts": 1718900000123
}
```

A signed `receipt` envelope is included when available. `received_xmr` is a display number; expected amounts and shortfalls use decimal strings. Do not use floating-point display values for accounting comparisons.

Verify `X-XMR-Pay-Signature: sha256=<hmac>` against the raw request body with the shared secret. `verifySignature` checks only the HMAC. Check `event_ts` separately against your replay window. Fulfill from your server's order record and make processing atomic and idempotent on the payment/order identity. A valid signature alone does not prevent duplicate fulfillment. Webhook redirects are rejected.

The library's `onPaid` callback runs on a transition to paid; durable redelivery belongs to the HTTP example, not to `createPaymentAgent()` by itself. See [API.md](API.md) for the endpoint contract.

## State event helpers

`nextEvents()` can produce `invoice.created`, `invoice.processing`, `payment.received`, `invoice.settled`, `invoice.expired` and `invoice.invalid` for custom integrations. The HTTP agent does not deliver these events. Do not subscribe to `invoice.settled` expecting the agent to send it.

The widget's `xmr-pay:paid` DOM event is for display only. It does not authorize delivery of goods.

## Refund records

WooCommerce's claim-link flow records a manual refund. It never sends funds.

| Field | Meaning |
|---|---|
| `refund_status` | `requested`, `address_provided` or `sent` |
| `refund_amount` | accumulated refund amount in store currency |
| `refund_address` | buyer's validated Monero receiving address |
| `refund_txid` | merchant's outgoing transaction, recorded after sending |
| `refund_opened` | time the claim opened |
| `refund_window` | validity period, snapshotted when the claim opens; `0` disables expiry |

An expired `requested` claim can be reissued by the merchant. Once an address has been submitted, the claim window no longer gates it. The claim link uses the WooCommerce order key; address submission is nonce-protected and marking a refund sent requires merchant authorization.

[`src/refund.js`](../src/refund.js) uses milliseconds; the PHP helpers use seconds. WooCommerce reporting maps paid or refunded orders to `settled` because a refund does not undo the original sale.
