'use strict';
/*
 * The canonical INVOICE state machine — the lifecycle every transport (the watch agent, the
 * WordPress-native PHP scanner, a future platform plugin) maps onto, so webhook events, the
 * hosted checkout page, and reporting all speak ONE language. Pure, zero-dependency.
 *
 * Mirrored in PHP by XmrPay_Util::to_invoice_state so both engines agree on what state an
 * order is in (pinned identical by the conformance vectors). It is a SUPERSET map of the
 * existing summarizeTransfers / classify_payment status strings — nothing regresses.
 */

// the five canonical states.
const STATES = ['created', 'processing', 'settled', 'expired', 'invalid'];

// settled LATCHES (a confirmed sale is never un-captured); expired is final.
const TERMINAL = new Set(['settled', 'expired']);

/*
 * Map a settlement status (from summarizeTransfers / classify_payment) to a canonical state.
 * Returns null for verify-ONLY outcomes (node-error, node-disagreement, replay, no-funds):
 * those are per-attempt verification results, NOT invoice transitions, so the invoice keeps
 * whatever state it was in.
 */
function toInvoiceState(status) {
    switch (status) {
        case 'pending':     return 'created';
        case 'mempool':
        case 'unconfirmed':
        case 'partial':
        case 'underpaid':
        case 'locked':      return 'processing';   // funds in flight: never terminal, never cancel
        case 'paid':        return 'settled';
        case 'expired':     return 'expired';
        case 'invalid':     return 'invalid';
        default:            return null;            // not an invoice-state transition
    }
}

/*
 * Structurally-legal transitions. `settled` latches; `expired` is final; `processing`/`invalid`
 * can still settle or expire. The "never orphan funds" rule (don't expire/cancel an order that
 * received money) is enforced by the CALLER (the agent tick / the plugin's partial flag), not
 * relaxed here — this map only states what is structurally legal.
 */
const TRANSITIONS = {
    created:    new Set(['created', 'processing', 'settled', 'expired', 'invalid']),
    processing: new Set(['processing', 'settled', 'expired', 'invalid']),
    invalid:    new Set(['invalid', 'processing', 'settled', 'expired']),
    settled:    new Set(['settled']),   // latched
    expired:    new Set(['expired']),   // final
};

function canTransition(prev, next) {
    if (!STATES.includes(next)) return false;
    if (prev == null) return next === 'created';   // an invoice is born `created`
    return (TRANSITIONS[prev] || new Set()).has(next);
}

/*
 * The events a transition emits: `invoice.<next>` on a state change (`invoice.created` at
 * birth, prev == null), plus `payment.received` when funds increased without (yet) settling —
 * an installment / top-up. `invoice.settled` subsumes the final payment. This is the planned
 * event taxonomy documented in docs/EVENTS.md; the shipping agent currently emits a single
 * `order.paid` webhook (the richer per-event delivery is the Phase-2 work this helper is for).
 */
function nextEvents(prev, next, opts) {
    const receivedIncreased = !!(opts && opts.receivedIncreased);
    const out = [];
    if (prev !== next && STATES.includes(next)) out.push('invoice.' + next);
    if (receivedIncreased && next !== 'settled' && next !== 'expired' && next !== 'invalid') {
        out.push('payment.received');
    }
    return out;
}

module.exports = { STATES, TERMINAL, toInvoiceState, canTransition, nextEvents };
