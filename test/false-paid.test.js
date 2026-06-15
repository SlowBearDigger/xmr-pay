// FALSE-PAID HUNT — does the agent EVER report paid:true (or fire onPaid) for an
// order that was not genuinely paid? throws every "looks-like-money-but-isn't"
// condition at it — below-birthday (reused subaddress / stale payment), in-pool,
// below minConf, time-locked, underpaid, dust — then a 2000-case fuzz checked
// against an INDEPENDENT ground truth. a single false-paid is a critical bug.
//   node test/false-paid.test.js

const fc = require('fast-check');
const { createPaymentAgent } = require('../src/agent');
const { creditableRows } = require('../src/scanner');
const { summarizeTransfers } = require('../src/watch');
const { xmrToPico } = require('../src/verify');

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { (c ? pass++ : fail++); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`); };

// scanner that mirrors the REAL crediting path: birthday filter, then summarize.
function mockScanner() {
    let idx = 0; const rows = new Map();
    const self = {
        rows,
        async sync() { }, async newSubaddress() { const i = ++idx; return { address: 's' + i, index: i, atHeight: 100000 + i }; }, async addressAt(i) { return 's' + i; },
        async checkOrder({ subaddressIndex, amount, minConfirmations = 1, minHeight = null }) {
            return summarizeTransfers(creditableRows(self.rows.get(subaddressIndex) || [], minHeight), xmrToPico(amount), minConfirmations);
        },
    };
    return self;
}
let seq = 0;
const T = (pico, { confs = 10, inPool = false, locked = false, height = 0 } = {}) => ({ txid: 't' + (++seq), amountPico: BigInt(pico), confirmations: confs, inPool, locked, height });
const FULL = '100000000000', AMT = '0.1', MINCONF = 1;

async function probe(makeRows) {
    const ms = mockScanner(); let fired = 0;
    const a = createPaymentAgent({ scanner: ms, minConfirmations: MINCONF, onPaid: () => fired++ });
    const o = await a.createOrder({ id: 'x', amount: AMT });
    ms.rows.set(o.index, makeRows(o.birthdayHeight));
    const r = await a.check('x');
    return { paid: r.paid, fired };
}

(async () => {
    // ── explicit "not really paid" conditions: none may settle ──
    ok('no transfers → never paid', !(await probe(() => [])).paid);
    ok('underpaid (half the amount) → never paid', !(await probe(() => [T('50000000000')])).paid);
    ok('full amount but in-pool (0 conf) → never paid', !(await probe(() => [T(FULL, { confs: 0, inPool: true })])).paid);
    ok('full amount but below minConf → never paid', !(await probe(() => [T(FULL, { confs: 0 })])).paid);
    ok('full amount but time-locked → never paid', !(await probe(() => [T(FULL, { locked: true })])).paid);
    ok('full confirmed payment BELOW birthday (reused subaddr / stale) → never paid', !(await probe(b => [T(FULL, { height: b - 100 })])).paid);
    ok('1000 dust transfers under the amount → never paid', !(await probe(() => Array.from({ length: 1000 }, () => T('1000')))).paid);

    // none of those fire onPaid
    for (const [name, mk] of [['underpaid', () => [T('50000000000')]], ['locked', () => [T(FULL, { locked: true })]], ['pre-birthday', b => [T(FULL, { height: b - 100 })]], ['in-pool', () => [T(FULL, { confs: 0, inPool: true })]]]) {
        ok(`onPaid NEVER fires on: ${name}`, (await probe(mk)).fired === 0);
    }

    // ── control: a GENUINE payment DOES settle (so the suite isn't vacuously green) ──
    const gp = await probe(b => [T(FULL, { height: b + 5 })]);
    ok('genuine confirmed full payment after birthday → paid + onPaid exactly once', gp.paid && gp.fired === 1);

    // ── FUZZ: 2000 random transfer sets vs an INDEPENDENT ground truth ──
    const arb = fc.array(fc.record({
        pico: fc.bigInt({ min: 0n, max: 200000000000n }),
        confs: fc.nat({ max: 5 }),
        inPool: fc.boolean(),
        locked: fc.boolean(),
        dh: fc.integer({ min: -200, max: 200 }),   // height offset from the order's birthday
    }), { maxLength: 8 });
    let fuzzOk = true, fuzzErr = '';
    try {
        await fc.assert(fc.asyncProperty(arb, async (specs) => {
            const ms = mockScanner(); let fired = 0;
            const a = createPaymentAgent({ scanner: ms, minConfirmations: MINCONF, onPaid: () => fired++ });
            const o = await a.createOrder({ id: 'f', amount: AMT });
            const rows = specs.map(s => T(String(s.pico), { confs: s.confs, inPool: s.inPool, locked: s.locked, height: o.birthdayHeight + s.dh }));
            ms.rows.set(o.index, rows);
            const r = await a.check('f');
            // independent ground truth: credit only confirmed, unlocked, at/after birthday
            const credit = creditableRows(rows, o.birthdayHeight);
            const confirmed = credit.filter(t => !t.locked && !t.inPool && t.confirmations >= MINCONF).reduce((s, t) => s + t.amountPico, 0n);
            const shouldPay = confirmed >= xmrToPico(AMT);
            return r.paid === shouldPay && (r.paid ? fired === 1 : fired === 0);
        }), { numRuns: 2000 });
    } catch (e) { fuzzOk = false; fuzzErr = String(e && e.message ? e.message : e).split('\n')[0]; }
    ok('FUZZ 2000: agent.paid === ground truth, onPaid exactly-once, ZERO false-paid', fuzzOk, fuzzErr);

    console.log(`\n${fail === 0 ? 'ALL GREEN' : 'FAILED'}  ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
})();
