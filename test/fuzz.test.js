// fuzz the money math: tens of thousands of random amounts + piconero tails,
// trying to make the exact arithmetic drift the way floats would. the invariants
// that MUST hold for "send the difference" and installment-summing to be safe:
//   1. a canonical amount string round-trips to the SAME piconero (no loss)
//   2. the shortfall equals expected − received exactly
//   3. received + (the shortfall string, paid back as an amount) lands EXACTLY
//      on expected — i.e. paying the displayed difference completes the order
//   4. summing installments is exact, so the second/third payment completes it
// deterministic (xorshift) so any failure is reproducible — bump SEED to explore.
//   node test/fuzz.test.js

const { classifyResult, xmrToPico, picoToXmrString } = require('../src/verify');

const SEED = 0x1234567;
let _s = SEED >>> 0;
function rnd() { _s ^= _s << 13; _s ^= _s >>> 17; _s ^= _s << 5; _s >>>= 0; return _s / 0x100000000; }
// random piconero with a full random sub-XMR tail (1 .. maxXmr·1e12)
function randPico(maxXmr) { return BigInt(Math.floor(rnd() * maxXmr)) * 1000000000000n + BigInt(Math.floor(rnd() * 1e12)) + 1n; }

let pass = 0, fail = 0, firstFail = null;
const ok = (cond, ctx) => { if (cond) pass++; else { fail++; if (!firstFail) firstFail = ctx; } };
const shortfallOf = (expectedPico, receivedPico) =>
    classifyResult({ isGood: true, receivedPico, confirmations: 1, inTxPool: false }, { expectedPico, minConfirmations: 1 });

const N = 20000;

// 1) canonical string round-trips to the same piconero
for (let i = 0; i < N; i++) {
    const p = randPico(10000);
    ok(xmrToPico(picoToXmrString(p)) === p, `roundtrip p=${p} s=${picoToXmrString(p)}`);
}

// 2+3) shortfall is exact, and received + shortfall(as paid string) === expected
for (let i = 0; i < N; i++) {
    const expected = randPico(5000) + 1n;
    const received = (expected * BigInt(Math.floor(rnd() * 1e6))) / 1000000n;   // 0 .. <expected
    const cls = shortfallOf(expected, received);
    if (received <= 0n) { ok(cls.status === 'no-funds', `nofunds e=${expected}`); continue; }
    const exact = expected - received;
    ok(cls.status === 'underpaid', `status ${cls.status} e=${expected} r=${received}`);
    ok(cls.shortfallXmr === picoToXmrString(exact), `short e=${expected} r=${received} got=${cls.shortfallXmr}`);
    // the real path: the buyer's wallet parses the displayed shortfall string back
    // into piconero — it must complete the order to the exact piconero.
    ok(received + xmrToPico(cls.shortfallXmr) === expected, `completion e=${expected} r=${received} s=${cls.shortfallXmr}`);
}

// 4) summing 2..5 random installments is exact — paying all but the last leaves a
// shortfall equal to the last payment, and adding it back completes the order.
for (let i = 0; i < N / 5; i++) {
    const k = 2 + Math.floor(rnd() * 4);
    const parts = []; let sum = 0n;
    for (let j = 0; j < k; j++) { const p = randPico(1000); parts.push(p); sum += p; }
    ok(xmrToPico(picoToXmrString(sum)) === sum, `sum roundtrip ${sum}`);
    const partial = parts.slice(0, -1).reduce((a, b) => a + b, 0n);
    const cls = shortfallOf(sum, partial);
    const last = parts[parts.length - 1];
    ok(cls.shortfallXmr === picoToXmrString(last), `last-installment shortfall ${last}`);
    ok(partial + xmrToPico(cls.shortfallXmr) === sum, `installment completion sum=${sum}`);
}

// 5) explicit float-trap cases that naive float arithmetic gets WRONG
const trap = (a, b, expSum) => ok(xmrToPico(a) + xmrToPico(b) === xmrToPico(expSum), `trap ${a}+${b}=${expSum}`);
trap('0.1', '0.2', '0.3');            // float: 0.1 + 0.2 = 0.30000000000000004
trap('0.07', '0.01', '0.08');         // float: 0.07999999999999999
trap('0.29', '0.01', '0.3');
trap('0.000000000001', '0.000000000002', '0.000000000003');   // piconero dust
ok(shortfallOf(xmrToPico('0.3'), xmrToPico('0.1')).shortfallXmr === '0.2', 'shortfall 0.3-0.1 = 0.2, not 0.1999…');
ok(shortfallOf(xmrToPico('1'), xmrToPico('0.999999999999')).shortfallXmr === '0.000000000001', '1 piconero shortfall');

console.log(`\nfuzz (seed 0x${SEED.toString(16)}): ${pass} passed, ${fail} failed${firstFail ? '\n  first fail: ' + firstFail : ''}`);
console.log(fail === 0 ? 'ALL GREEN' : 'FAILED');
process.exit(fail === 0 ? 0 : 1);
