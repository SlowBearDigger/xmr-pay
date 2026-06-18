'use strict';
// regression for the adversarial type/encoding probe: summarizeTransfers must be
// FAIL-SOFT on malformed rows (never crash the tick), and the amount parsers must
// REJECT non-scalar types instead of silently coercing (e.g. [5] → "5"). these
// were real crashes/flags found by hammering the public API with hostile inputs.

const assert = require('assert');
const { xmrToPico, atomicToPico } = require('../src/verify');
const { summarizeTransfers } = require('../src/watch');

let pass = 0, fail = 0;
const ok = (name, fn) => { try { fn(); console.log('PASS  ' + name); pass++; } catch (e) { console.log('FAIL  ' + name + '  — ' + e.message); fail++; } };

const E = 100000000000n;   // 0.1 XMR expected

// — summarizeTransfers: malformed rows must be SKIPPED, never throw —
ok('null row → no throw, not paid', () => { const r = summarizeTransfers([null], E, 1, 0n); assert.strictEqual(r.paid, false); });
ok('undefined row → no throw', () => { summarizeTransfers([undefined], E, 1, 0n); });
ok('empty-object row → no throw, not paid', () => { const r = summarizeTransfers([{}], E, 1, 0n); assert.strictEqual(r.paid, false); });
ok('non-object rows (number/string) → no throw', () => { summarizeTransfers([5, 'x', true], E, 1, 0n); });
ok('amountPico as a JS number → credited (coerced to BigInt), no BigInt-mix throw', () => {
    const r = summarizeTransfers([{ txid: 'a', amountPico: 100000000000, confirmations: 10, inPool: false }], E, 1, 0n);
    assert.strictEqual(r.paid, true);
});
ok('amountPico as a string → credited', () => {
    const r = summarizeTransfers([{ txid: 'a', amountPico: '100000000000', confirmations: 10, inPool: false }], E, 1, 0n);
    assert.strictEqual(r.paid, true);
});
ok('NEGATIVE amount row → skipped, never paid/credited', () => {
    const r = summarizeTransfers([{ txid: 'a', amountPico: -999999999999999n, confirmations: 10, inPool: false }], E, 1, 0n);
    assert.strictEqual(r.paid, false);
    assert.strictEqual(r.receivedPico, '0');
});
ok('NaN confirmations → treated as 0 (not paid at minConf 1)', () => {
    const r = summarizeTransfers([{ txid: 'a', amountPico: E, confirmations: NaN, inPool: false }], E, 1, 0n);
    assert.strictEqual(r.paid, false);
});
ok('string confirmations "10" → coerced, paid', () => {
    const r = summarizeTransfers([{ txid: 'a', amountPico: E, confirmations: '10', inPool: false }], E, 1, 0n);
    assert.strictEqual(r.paid, true);
});
ok('5000 tiny rows → no throw, sane shape', () => {
    const rows = Array.from({ length: 5000 }, () => ({ txid: 'x', amountPico: 1n, confirmations: 10, inPool: false }));
    const r = summarizeTransfers(rows, E, 1, 0n);
    assert.strictEqual(typeof r.status, 'string');
});

// — amount parsers: reject non-scalar TYPES (no silent coercion) —
ok('xmrToPico([5]) throws (array not coerced to 5)', () => assert.throws(() => xmrToPico([5])));
ok('xmrToPico({}) throws', () => assert.throws(() => xmrToPico({})));
ok('xmrToPico(true) throws', () => assert.throws(() => xmrToPico(true)));
ok('atomicToPico([100]) throws (array not coerced to 100)', () => assert.throws(() => atomicToPico([100])));
ok('atomicToPico({}) throws', () => assert.throws(() => atomicToPico({})));
ok('atomicToPico(true) throws', () => assert.throws(() => atomicToPico(true)));
// still accepts the legitimate scalar forms
ok('xmrToPico("0.1") still works', () => assert.strictEqual(xmrToPico('0.1'), E));
ok('atomicToPico(100000000000) still works', () => assert.strictEqual(atomicToPico(100000000000), E));
ok('atomicToPico(null) → 0n (unchanged)', () => assert.strictEqual(atomicToPico(null), 0n));

console.log(`\n${fail === 0 ? 'ALL GREEN' : 'SOME FAILED'}  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
