'use strict';
// parity with monerod's own amount parser. mirrors the cases in
// monero-project/monero tests/unit_tests/parse_amount.cpp so our xmrToPico can
// never (a) accept an amount monerod rejects as out-of-range, nor (b) silently
// disagree on the 12-decimal / overflow boundary that decides real money.
//
// MUST-MATCH monerod: overflow above MONEY_SUPPLY (uint64 max), a non-zero 13th
// decimal, signs, empty, and multiple decimal points are ALL rejected.
// INTENTIONALLY STRICTER than monerod (documented): we reject a leading/trailing
// bare point and >12 fractional digits even when they are trailing zeros — our
// amounts are merchant-authored in a canonical `\d+(.\d{1,12})?` form, and the
// amount-nonce lives in those 12 decimals, so we don't accept lax variants.

const assert = require('assert');
const { xmrToPico } = require('../src/verify');

let pass = 0, fail = 0;
const ok = (name, fn) => { try { fn(); console.log('PASS  ' + name); pass++; } catch (e) { console.log('FAIL  ' + name + '  — ' + e.message); fail++; } };
const accepts = (s, expectPico) => ok(`accept ${JSON.stringify(s)} → ${expectPico}`, () => assert.strictEqual(xmrToPico(s), expectPico));
const rejects = (s, why) => ok(`reject ${JSON.stringify(s)} (${why})`, () => assert.throws(() => xmrToPico(s)));

// — accepted, same value monerod computes —
accepts('0', 0n);
accepts('00', 0n);                                   // leading zeros
accepts('0.000000000001', 1n);                       // 1 piconero
accepts('0.000000000009', 9n);
accepts('1', 1000000000000n);
accepts('6553.5', 6553500000000000n);
accepts('429496.7295', 429496729500000000n);
accepts('18446744.0737', 18446744073700000000n);
accepts('18446744.073709551615', 18446744073709551615n);   // exactly MONEY_SUPPLY (uint64 max)

// — MUST reject, exactly like monerod (the money-critical boundary) —
rejects('', 'empty');
rejects('-0', 'sign');
rejects('+0', 'sign');
rejects('-1', 'sign');
rejects('+1', 'sign');
rejects('.', 'only a point');
rejects('0.0000000000001', '13th decimal is non-zero (below 10^-12)');
rejects('0.0000000000009', '13th decimal is non-zero');
rejects('184467440737.000000001', 'non-zero digit past 12 + over supply');
rejects('184467440737.09551616', 'over MONEY_SUPPLY');
rejects('184467440738', 'over MONEY_SUPPLY (whole)');
rejects('18446744073709551616', 'over MONEY_SUPPLY');
rejects('..', 'two points');
rejects('0..', 'two points');
rejects('0.0.0', 'two points');

// — intentionally STRICTER than monerod (it accepts these; we do not) —
rejects('0.', 'trailing bare point (monerod accepts → 0)');
rejects('.0', 'leading bare point (monerod accepts → 0)');
rejects('.5', 'leading bare point (monerod accepts → 0.5)');
rejects('5.', 'trailing bare point (monerod accepts → 5)');
rejects('0.0000000000010000', '>12 fractional digits even as trailing zeros (monerod truncates → 1)');

console.log(`\n${fail === 0 ? 'ALL GREEN' : 'SOME FAILED'}  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
