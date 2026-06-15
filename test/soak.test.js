// soak — churn the agent through thousands of cycles (create → pay → expire) and
// assert nothing grows unbounded. paid orders are retired after paidRetentionMs,
// abandoned ones after expiryMs, and onPaid stays exactly-once. WITHOUT retention
// the store would grow to ~every-paid-order-ever — a long-running memory + save
// leak (every ledger save re-serializes the whole store).
//   node test/soak.test.js

const { createPaymentAgent } = require('../src/agent');
const { summarizeTransfers } = require('../src/watch');
const { xmrToPico } = require('../src/verify');

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { (c ? pass++ : fail++); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`); };

function mockScanner() {
    let idx = 0; const rows = new Map();
    const self = {
        rows, checks: 0,
        async sync() { },
        async newSubaddress() { const i = ++idx; return { address: 's' + i, index: i, atHeight: 1000 + i }; },
        async addressAt(i) { return 's' + i; },
        async checkOrder({ subaddressIndex, amount, minConfirmations = 1 }) { self.checks++; return summarizeTransfers(rows.get(subaddressIndex) || [], xmrToPico(amount), minConfirmations); },
    };
    return self;
}
let seq = 0;
const row = (p) => ({ txid: 't' + (++seq), amountPico: BigInt(p), confirmations: 10, inPool: false, locked: false });
const HOUR = 3600000;

(async () => {
    let clock = 0; const ms = mockScanner(); let paid = 0;
    const a = createPaymentAgent({ scanner: ms, minConfirmations: 1, expiryMs: HOUR, paidRetentionMs: HOUR, now: () => clock, onPaid: () => paid++, pollMs: 1e9 });

    const CYCLES = 3000;
    for (let c = 0; c < CYCLES; c++) {
        for (let i = 0; i < 5; i++) { const o = await a.createOrder({ amount: '0.1' }); if (i < 3) ms.rows.set(o.index, [row('100000000000')]); } // 3 of 5 pay this cycle
        clock += 60000;   // +1 minute per cycle (so 1h retention/expiry = 60 cycles)
        await a.tick();
    }

    const size = a.list().length;
    const heapMB = Math.round(process.memoryUsage().heapUsed / 1e6);
    // 15,000 orders created, 9,000 paid — but only the last ~hour (60 cycles) is
    // retained, so the store stays a few hundred, not tens of thousands.
    ok(`store bounded after ${CYCLES} cycles / ${CYCLES * 5} orders created`, size < 1000, `${size} in store`);
    ok('onPaid fired once per genuinely paid order (no dupes, no misses)', paid === CYCLES * 3, `${paid} vs ${CYCLES * 3}`);
    ok('store still holds the recent (retained) orders', size > 0);
    console.log(`    → ${CYCLES * 5} created · ${paid} paid · store holds ${size} (bounded) · heap ~${heapMB}MB`);

    console.log(`\n${fail === 0 ? 'ALL GREEN' : 'FAILED'}  ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
})();
