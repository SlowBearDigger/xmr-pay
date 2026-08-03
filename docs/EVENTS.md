# Invoice states and events

xmr-pay models every order with one canonical lifecycle, shared by the watch agent, the
WooCommerce plugin's pure-PHP scanner, and any future platform. This is the contract that
webhooks, the hosted checkout page, and reporting all speak. The model lives in
[`src/state.js`](../src/state.js) (JS) and is mirrored by `XmrPay_Util::to_invoice_state`
(PHP); a conformance vector suite pins the two identical.

## The five states

| State | Meaning | summarize / classify statuses that map here | WooCommerce status |
|---|---|---|---|
| `created` | invoice made, nothing received yet | `pending` | `on-hold` |
| `processing` | funds in flight (seen, arriving, partial, or time-locked) | `mempool`, `unconfirmed`, `partial`, `underpaid`, `locked` | `on-hold` (partial/underpaid also flagged) |
| `settled` | confirmed paid | `paid` | `processing` / `completed` |
| `expired` | unpaid past the window | `expired` | `cancelled` (only if no funds arrived) |
| `invalid` | misconfigured / cannot be paid as-is | `invalid` | stays `on-hold`, flagged |

Verify-only outcomes (`node-error`, `node-disagreement`, `replay`, `no-funds`) are the
result of a single verification attempt, not invoice transitions: the invoice keeps its
state, and `toInvoiceState` returns `null` for them.

### Rules that never bend

- **`settled` latches.** A confirmed sale is never un-captured. `minConfirmations` is the
  reorg defence; a reorg shallower than it cannot falsely settle, and a deeper one is the
  merchant's bounded, accepted risk. Once `settled`, no transition leaves it.
- **`expired` is final.**
- **Funds are never orphaned.** An order that received any money (`processing`) is never
  cancelled at expiry. The agent checks before expiring; the plugin flags it
  (`_xmrpay_partial_flagged`) so the expiry cron skips it. The state map allows the
  structural transition, but the caller enforces this invariant. A late top-up always lands
  on-chain in your wallet and is summed when seen.

### Finality is `minConfirmations` — there is no automated reversal

Settlement is final at `minConfirmations`. A chain reorganisation **deeper** than that threshold
can, in principle, un-spend an on-chain payment, but the order stays `settled` — like every
payment processor, a captured sale is not auto-reversed. The threshold IS the value-at-risk knob:
raise it for high-value orders (Monero treats ~10 as fully unlocked/final). Values below `1`
are normalized to `1`; mempool observations remain `processing` and never settle an order.

### Proof-mode caveat

In proof mode the buyer must submit a transaction id for the merchant to verify — there is no
passive scanning. So an order with a real on-chain payment whose buyer never submits it has no
fund record, and the expiry cron will cancel it on time (the funds are still in the merchant's
wallet, to reconcile by hand). The "never orphan funds" guarantee is airtight only for the modes
that watch the chain (watch/agent); proof mode is buyer-action-gated by design.

### Reporting projection (WooCommerce status → state)

`toInvoiceState` maps a *settlement status* to a state. The WooCommerce reporting page also needs
the reverse — a state from a stored *WC order status* — done by `XmrPay_Report::derive_state`:
`is_paid()` / `refunded` -> `settled` (the sale happened; a refund doesn't un-capture it),
`cancelled` / `failed` -> `expired`, on-hold with funds seen -> `processing`, else -> `created`.
This is a PHP-only display projection (the JS engine has no refunded/failed concept); it is not part
of the cross-engine conformance vectors.

## Events

> **Status:** this multi-event taxonomy is the **planned contract (Phase 2)**, not yet the
> shipping behaviour. Today the agent emits a single `order.paid` webhook on settlement (shape
> below under "What the agent emits today"); `nextEvents()` exists in `src/state.js` to drive the
> per-event delivery once Phase 2 wires it. Build against `order.paid` now; the `invoice.*` events
> are additive and backward-compatible when they land.

A transition will emit one or more events:

| Event | When |
|---|---|
| `invoice.created` | the order is created |
| `invoice.processing` | first time funds are seen (entering `processing`) |
| `payment.received` | a new payment / top-up increases the received amount without (yet) settling. Fired per installment. |
| `invoice.settled` | confirmed paid (subsumes the final `payment.received`) |
| `invoice.expired` | unpaid past the window |
| `invoice.invalid` | the order cannot be paid as-is |

`nextEvents(prev, next, { receivedIncreased })` in `src/state.js` returns the event list for
a transition, so producers stay consistent.

## Webhook payload (planned, Phase 2 — per event)

The signed body carries the order's canonical state plus the money fields. Signed with your
HMAC secret (`X-XMR-Pay-Signature: sha256=...`), the signature covering the raw body.

```json
{
  "event": "invoice.settled",
  "order_id": "ord_42",
  "state": "settled",
  "status": "paid",
  "amount_xmr": "0.05",
  "received_xmr": "0.05",
  "received_pico": "50000000000",
  "confirmations": 3,
  "overpaid": false,
  "overpaid_xmr": "0",
  "txids": ["787a2f..."],
  "event_ts": 1718900000123,
  "delivery_id": "d_3f9a...",
  "nonce": "9c1e..."
}
```

> `state` is the canonical lifecycle; `status` is kept for backward compatibility. The
> `delivery_id` / `nonce` / retry / dead-letter / redelivery semantics are specified in
> Phase 2 (reliable webhooks); receivers dedup on `delivery_id` and reject a stale or
> replayed delivery. A receiver should treat the absence of `delivery_id`/`nonce` as a
> legacy delivery and accept it (idempotency on `order_id` + `event` still holds).

### What the agent emits today

The shipping `npx xmr-pay` agent sends ONE signed webhook, on settlement, and the WooCommerce
plugin acts only on `event: "order.paid"`. Build against this; the `invoice.*` events above are
the additive Phase-2 superset.

```json
{
  "event": "order.paid",
  "order_id": "ord_42",
  "amount_xmr": "0.05",
  "received_xmr": "0.05",
  "overpaid": false,
  "overpaid_xmr": "0",
  "address": "8...",
  "txids": ["787a2f..."],
  "confirmations": 3,
  "network": "mainnet",
  "receipt": { "...": "signed receipt envelope, if enabled" },
  "event_ts": 1718900000123
}
```

## Refunds (non-custodial claim-link)

A Monero payment never reveals the sender and the gateway holds no spend key, so a refund can
never be pushed automatically. The contract is a claim-link: the buyer supplies a receive
address, the merchant pays it by hand and records it. Any platform implements the same record
so the lifecycle is portable.

Refund record (the WooCommerce plugin stores these as order meta; a platform mirrors the shape):

| Field | Meaning |
|---|---|
| `refund_status` | `requested` (claim opened, awaiting the buyer) -> `address_provided` (buyer gave an address) -> `sent` (merchant paid it) |
| `refund_amount` | total amount refunded (store currency), accumulated across partial refunds |
| `refund_address` | the buyer's Monero receive address (validated: base58 + checksum + the store's network) |
| `refund_txid` | the merchant's payout transaction id, recorded for audit when marked `sent` |
| `refund_opened` | when the claim was opened (epoch); the expiry clock starts here |
| `refund_window` | how long the link stays valid from `refund_opened` (`0` = never expires); snapshotted at open so a later config change never retroactively kills an issued link |

**Claim-link expiry.** A still-`requested` claim past `refund_opened + refund_window` is effectively
`expired`: the buyer can no longer submit an address (they see a "contact the store" message) and the
merchant reissues to reset the clock. Expiry only gates the first step — once `address_provided`, the
link has done its job and never "expires". The shared logic lives in [`src/refund.js`](../src/refund.js)
(`claimExpiresAt` / `isClaimExpired` / `effectiveClaimStatus`, ms) and is mirrored in PHP by
`XmrPay_Util::claim_expires_at` / `claim_expired` (seconds) — same formula, pinned by conformance vectors.

The claim-link is authorized by the order's bearer token (the WooCommerce `order_key`), the same
capability the proof-mode verify link uses; the address-capture POST is nonce-protected. The
address is captured once (status `requested` -> `address_provided`); a later visit must contact
the store, so a leaked link cannot redirect a not-yet-sent refund. Marking `sent` is an
authenticated merchant action (capability + nonce). No money ever moves automatically.

## Mapping notes for integrators

- React to `invoice.settled` to release goods. Treat `invoice.processing` / `payment.received`
  as progress (show "received X, Y remaining"), never as "paid".
- The buyer's browser may also receive an `xmr-pay:paid` DOM event from the widget; that is
  UX only. Fulfill on the server, on `invoice.settled`, after re-checking your own record.
