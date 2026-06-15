// order expiry — bounds the agent's per-tick work + memory. an unpaid order
// older than expiryMs is dropped (a late payment still lands on-chain in your
// wallet; it just won't auto-complete). paid orders never expire. deterministic
// via an injectable clock.
//   node test/expiry.test.js

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
const row = (pico, confs = 10) => ({ txid: 't' + pico + '_' + (++seq), amountPico: BigInt(pico), confirmations: confs, inPool: false, locked: false });

(async () => {
    // ── basic expiry, injectable clock ──
    {
        let clock = 0; const expired = [];
        const ms = mockScanner();
        const a = createPaymentAgent({ scanner: ms, minConfirmations: 1, expiryMs: 1000, now: () => clock, onExpire: o => expired.push(o.id), pollMs: 1e9 });
        const o = await a.createOrder({ id: 'e1', amount: '0.1' });
        ok('order carries createdAt from the injected clock', o.createdAt === 0);
        clock = 500; await a.tick();
        ok('before expiryMs: still pending (and checked)', a.get('e1') && a.get('e1').status === 'pending' && ms.checks === 1);
        clock = 1000; await a.tick();
        ok('at expiryMs: dropped from the store', a.get('e1') === null);
        ok('onExpire fired exactly once with the order', expired.length === 1 && expired[0] === 'e1');
    }

    // ── paid orders NEVER expire ──
    {
        let clock = 0; const expired = [];
        const ms = mockScanner();
        const a = createPaymentAgent({ scanner: ms, minConfirmations: 1, expiryMs: 1000, now: () => clock, onExpire: o => expired.push(o.id), pollMs: 1e9 });
        const o = await a.createOrder({ id: 'p1', amount: '0.1' });
        ms.rows.set(o.index, [row('100000000000')]);
        await a.check('p1');
        ok('order settles before expiry', a.get('p1').paid);
        clock = 99999; await a.tick();
        ok('a PAID order is never expired (even far past expiryMs)', a.get('p1') && a.get('p1').paid === true && expired.length === 0);
    }

    // ── a payment after expiry: order is gone, not auto-completed (the tradeoff) ──
    {
        let clock = 0; const ms = mockScanner();
        const a = createPaymentAgent({ scanner: ms, minConfirmations: 1, expiryMs: 1000, now: () => clock, pollMs: 1e9 });
        const o = await a.createOrder({ id: 'late', amount: '0.1' });
        clock = 1500; await a.tick();                          // expires
        ms.rows.set(o.index, [row('100000000000')]);          // payment lands AFTER expiry
        await a.tick();
        ok('payment after expiry: order stays gone (funds on-chain, manual reconcile)', a.get('late') === null);
    }

    // ── expiryMs=0 (default) → nothing ever expires (backward compatible) ──
    {
        let clock = 0; const ms = mockScanner();
        const a = createPaymentAgent({ scanner: ms, minConfirmations: 1, now: () => clock, pollMs: 1e9 });
        await a.createOrder({ id: 'z', amount: '0.1' });
        clock = 1e12; await a.tick();
        ok('expiryMs=0: order never expires', a.get('z') && a.get('z').status === 'pending');
    }

    // ── an order with no createdAt (old ledger) is never expired ──
    {
        let clock = 5000; const ms = mockScanner();
        const store = new Map([['old', { id: 'old', amount: '0.1', address: 's1', index: 1, birthdayHeight: 1000, status: 'pending', paid: false, shortfallXmr: '0.1', txids: [] }]]);
        const a = createPaymentAgent({ scanner: ms, store, minConfirmations: 1, expiryMs: 1000, now: () => clock, pollMs: 1e9 });
        await a.tick();
        ok('order without createdAt is never expired (safe for old ledgers)', a.get('old') !== null);
    }

    // ── BOUNDING: 10k orders, 5k past expiry → store + expensive checks bounded ──
    {
        let clock = 0; const ms = mockScanner();
        const a = createPaymentAgent({ scanner: ms, minConfirmations: 1, expiryMs: 1000, now: () => clock, pollMs: 1e9 });
        for (let i = 0; i < 5000; i++) await a.createOrder({ id: 'old' + i, amount: '0.1' });   // createdAt 0
        clock = 2000;
        for (let i = 0; i < 5000; i++) await a.createOrder({ id: 'new' + i, amount: '0.1' });   // createdAt 2000
        ms.checks = 0; clock = 2500;
        await a.tick();
        ok('10k orders, 5k expired → store bounded to the 5k active', a.list().length === 5000, `${a.list().length} left`);
        ok('expensive checkOrder ran ONLY for the 5k active orders', ms.checks === 5000, `${ms.checks} checks`);
    }

    console.log(`\n${fail === 0 ? 'ALL GREEN' : 'FAILED'}  ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
})();
