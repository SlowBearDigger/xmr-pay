// Derive payment lifecycle states.
'use strict';

const STATES = ['created', 'processing', 'settled', 'expired', 'invalid'];

const TERMINAL = new Set(['settled', 'expired']);

function toInvoiceState(status) {
    switch (status) {
        case 'pending':     return 'created';
        case 'mempool':
        case 'unconfirmed':
        case 'partial':
        case 'underpaid':
        case 'locked':      return 'processing';
        case 'paid':        return 'settled';
        case 'expired':     return 'expired';
        case 'invalid':     return 'invalid';
        default:            return null;
    }
}

const TRANSITIONS = {
    created:    new Set(['created', 'processing', 'settled', 'expired', 'invalid']),
    processing: new Set(['processing', 'settled', 'expired', 'invalid']),
    invalid:    new Set(['invalid', 'processing', 'settled', 'expired']),
    settled:    new Set(['settled']),
    expired:    new Set(['expired']),
};

function canTransition(prev, next) {
    if (!STATES.includes(next)) return false;
    if (prev == null) return next === 'created';
    return (TRANSITIONS[prev] || new Set()).has(next);
}

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
