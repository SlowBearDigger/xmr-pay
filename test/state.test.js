// the canonical invoice state machine — the contract the lib agent AND the WP-native PHP
// scanner both map onto. The status->state VECTORS below are mirrored byte-for-byte in the
// plugin's tests/state.test.php (Phase 6 unifies them into one shared corpus).
//   node test/state.test.js

const { STATES, TERMINAL, toInvoiceState, canTransition, nextEvents } = require('../src/state');

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { (c ? pass++ : fail++); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`); };

// status -> canonical state (MIRROR this map in tests/state.test.php)
const VECTORS = {
    pending: 'created',
    mempool: 'processing', unconfirmed: 'processing', partial: 'processing', underpaid: 'processing', locked: 'processing',
    paid: 'settled',
    expired: 'expired',
    invalid: 'invalid',
};
for (const [status, state] of Object.entries(VECTORS)) {
    ok(`status "${status}" -> ${state}`, toInvoiceState(status) === state, String(toInvoiceState(status)));
}
// verify-ONLY outcomes are NOT invoice transitions (the invoice keeps its state)
for (const s of ['node-error', 'node-disagreement', 'replay', 'no-funds', 'bogus', '']) {
    ok(`verify-only "${s}" -> null`, toInvoiceState(s) === null);
}

// terminal set
ok('settled + expired are terminal; processing is not', TERMINAL.has('settled') && TERMINAL.has('expired') && !TERMINAL.has('processing'));

// settled LATCHES (never leaves) and expired is FINAL
for (const s of STATES) ok(`settled -> ${s} ${s === 'settled' ? '(latch)' : '(blocked)'}`, canTransition('settled', s) === (s === 'settled'));
for (const s of STATES) ok(`expired -> ${s} ${s === 'expired' ? '(stay)' : '(blocked)'}`, canTransition('expired', s) === (s === 'expired'));

// birth + the money-safety transitions
ok('an invoice is born `created`', canTransition(null, 'created') && !canTransition(null, 'settled'));
ok('created -> processing', canTransition('created', 'processing'));
ok('processing -> settled', canTransition('processing', 'settled'));
ok('processing -> expired', canTransition('processing', 'expired'));
ok('processing -/-> created (never goes backwards)', !canTransition('processing', 'created'));
ok('unknown next state is illegal', !canTransition('created', 'whatever'));

// events
ok('birth fires invoice.created', JSON.stringify(nextEvents(null, 'created')) === JSON.stringify(['invoice.created']));
ok('settle fires invoice.settled', JSON.stringify(nextEvents('processing', 'settled')) === JSON.stringify(['invoice.settled']));
ok('expire fires invoice.expired', JSON.stringify(nextEvents('processing', 'expired')) === JSON.stringify(['invoice.expired']));
ok('installment (processing->processing, funds up) fires payment.received ONLY',
    JSON.stringify(nextEvents('processing', 'processing', { receivedIncreased: true })) === JSON.stringify(['payment.received']));
ok('first payment fires invoice.processing + payment.received', (() => {
    const e = nextEvents('created', 'processing', { receivedIncreased: true });
    return e.includes('invoice.processing') && e.includes('payment.received');
})());
ok('settling does NOT also fire payment.received', !nextEvents('processing', 'settled', { receivedIncreased: true }).includes('payment.received'));
ok('no event when nothing changes', nextEvents('processing', 'processing').length === 0);

console.log(`\n${fail ? 'FAILED' : 'ALL GREEN'}  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
