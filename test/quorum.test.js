// resolveQuorum — the per-node voting rule that decides a payment. this is the
// single most security-critical decision in proof mode, so it gets its own
// adversarial unit test independent of any network mock.
//   node test/quorum.test.js

const { resolveQuorum } = require('../src/verify');

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
    if (cond) { pass++; console.log('PASS  ' + name); }
    else { fail++; console.log('FAIL  ' + name + (extra ? '  — ' + extra : '')); }
}

// answer shapes: a node that confirms the payment vs one that contradicts it.
const GOOD = i => ({ nodeUri: 'good' + i, isGood: true, receivedPico: 1000n, confirmations: 10, inTxPool: false });
const BAD = i => ({ nodeUri: 'bad' + i, isGood: false, receivedPico: 0n, confirmations: 0, inTxPool: false });
// two honest nodes that disagree on the AMOUNT (still a contradiction, not agreement)
const GOODAMT = (i, p) => ({ nodeUri: 'g' + i, isGood: true, receivedPico: p, confirmations: 10, inTxPool: false });

// ── happy paths ──
ok('single node, want 1 → agreed', resolveQuorum([GOOD(1)], 1).agreed === true);
ok('two agree, want 2 → agreed', resolveQuorum([GOOD(1), GOOD(2)], 2).agreed === true);
ok('three agree, want 2 → agreed', resolveQuorum([GOOD(1), GOOD(2), GOOD(3)], 2).agreed === true);

// ── tolerate a CONTRADICTING node when there is still a real majority ──
ok('want 2, [good,good,bad] → agreed on good (one liar tolerated)',
    (r => r.agreed === true && r.head.isGood === true)(resolveQuorum([GOOD(1), GOOD(2), BAD(1)], 2)));
ok('want 2, bad node FIRST does not block the majority',
    (r => r.agreed === true && r.head.isGood === true)(resolveQuorum([BAD(1), GOOD(1), GOOD(2)], 2)));

// ── THE FIX: an even split must fail closed regardless of order ──
ok('want 2, even split 2-2 (bad first) → NOT agreed (no false-paid)',
    resolveQuorum([BAD(1), BAD(2), GOOD(1), GOOD(2)], 2).agreed === false);
ok('want 2, even split 2-2 (good first) → NOT agreed (order-independent)',
    resolveQuorum([GOOD(1), GOOD(2), BAD(1), BAD(2)], 2).agreed === false);
ok('want 1, one good one bad → NOT agreed (cannot resolve a 1-1 by order)',
    resolveQuorum([BAD(1), GOOD(1)], 1).agreed === false);

// ── attacker controls exactly `want`, honest nodes also reach `want`: conflict ──
ok('want 2, attacker 2 + honest 2 on different amounts → NOT agreed',
    resolveQuorum([GOODAMT(1, 5n), GOODAMT(2, 5n), GOODAMT(3, 9n), GOODAMT(4, 9n)], 2).agreed === false);

// ── not enough agreement at all ──
ok('want 3, split 2-2 → NOT agreed', resolveQuorum([GOOD(1), GOOD(2), BAD(1), BAD(2)], 3).agreed === false);
ok('want 3, [good,good,good,bad] → agreed (3 ≥ 3, unique)',
    resolveQuorum([GOOD(1), GOOD(2), GOOD(3), BAD(1)], 3).agreed === true);

// ── head always comes from the winning (majority) cluster ──
ok('head is from the majority cluster, not answers[0]',
    resolveQuorum([BAD(1), GOOD(1), GOOD(2)], 2).head.isGood === true);

// ── empty input is safe ──
ok('no answers → not agreed, head null',
    (r => r.agreed === false && r.head === null)(resolveQuorum([], 1)));

console.log(`\n${fail === 0 ? 'ALL GREEN' : 'FAILED'}  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
