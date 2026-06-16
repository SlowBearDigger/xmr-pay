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
// a scanner with batch support (checkOrders) — the real production path. counts
// how many account-wide getTransfers it does so a test can assert O(1) per tick.
function batchMockScanner() {
    let idx = 0; const rows = new Map();
    const self = {
        rows, getTransfers: 0,
        async sync() { },
        async newSubaddress() { const i = ++idx; return { address: 's' + i, index: i, atHeight: 1000 + i }; },
        async addressAt(i) { return 's' + i; },
        // present so the constructor accepts the scanner (real scanner has both);
        // the batch path below never calls it — that's the whole point.
        async checkOrder({ subaddressIndex, amount, minConfirmations = 1 }) { return summarizeTransfers(rows.get(subaddressIndex) || [], xmrToPico(amount), minConfirmations); },
        async checkOrders(list, { minConfirmations = 1 } = {}) {
            self.getTransfers++;   // ONE account-wide getTransfers, distributed to every order
            const m = new Map();
            for (const o of list) m.set(o.id, summarizeTransfers(rows.get(o.index) || [], xmrToPico(o.amount), minConfirmations));
            return m;
        },
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

    // ── a PARTIALLY-PAID order is NEVER expired (never orphan the buyer's funds) ──
    {
        let clock = 0; const expired = []; const ms = mockScanner();
        const a = createPaymentAgent({ scanner: ms, minConfirmations: 1, expiryMs: 1000, now: () => clock, onExpire: o => expired.push(o.id), pollMs: 1e9 });
        const o = await a.createOrder({ id: 'partial', amount: '0.1' });
        ms.rows.set(o.index, [row('50000000000')]);   // 0.05 of 0.1 — a partial payment
        await a.check('partial');
        ok('partial payment recorded (received > 0, not paid)', !a.get('partial').paid && Number(a.get('partial').receivedXmr) > 0);
        clock = 99999; await a.tick();                 // far past expiry
        ok('a PARTIALLY-PAID order is NEVER expired (funds never orphaned)', a.get('partial') !== null && expired.length === 0);
        ms.rows.set(o.index, [row('50000000000'), row('50000000000')]);   // buyer tops up → total 0.1
        await a.check('partial');
        ok('a top-up after the expiry window still completes the kept order', a.get('partial').paid === true);
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

    // ── BOUNDING: 10k orders, 5k past expiry → store stays bounded ──
    {
        let clock = 0; const ms = mockScanner();
        const a = createPaymentAgent({ scanner: ms, minConfirmations: 1, expiryMs: 1000, now: () => clock, pollMs: 1e9 });
        for (let i = 0; i < 5000; i++) await a.createOrder({ id: 'old' + i, amount: '0.1' });   // createdAt 0
        clock = 2000;
        for (let i = 0; i < 5000; i++) await a.createOrder({ id: 'new' + i, amount: '0.1' });   // createdAt 2000
        ms.checks = 0; clock = 2500;
        await a.tick();
        ok('10k orders, 5k expired → store bounded to the 5k active', a.list().length === 5000, `${a.list().length} left`);
        // every unpaid order is checked on FRESH state BEFORE the expiry decision,
        // so a payment that landed in an order's final pre-expiry window is recorded
        // and the order is never wrongly dropped — funds are never orphaned. that
        // means the soon-to-expire orders get one last check too. on the real batch
        // path that's a no-op (ONE getTransfers per tick, O(1) network — proven by
        // the batch-path test below); only the per-order fallback mock counts 10k.
        ok('all unpaid checked before expiry (never orphan a late payment)', ms.checks === 10000, `${ms.checks} checks`);
    }

    // ── SCALE: the production batch path is O(1) in NETWORK calls, not O(orders) ──
    {
        let clock = 0; const bms = batchMockScanner();
        const a = createPaymentAgent({ scanner: bms, minConfirmations: 1, expiryMs: 1000, now: () => clock, pollMs: 1e9 });
        for (let i = 0; i < 10000; i++) await a.createOrder({ id: 'b' + i, amount: '0.1' });
        bms.getTransfers = 0; clock = 500;
        await a.tick();
        ok('batch path: ONE getTransfers per tick for 10k orders (O(1) network)', bms.getTransfers === 1, `${bms.getTransfers} calls`);
    }

    // ── RACE (the orphan-funds bug): a payment that lands in the very tick an order
    //    would expire COMPLETES the order — it is never expired-then-orphaned. the
    //    check now runs BEFORE the expiry sweep on fresh state, so the just-arrived
    //    funds are seen first. (the old order: expire on stale receivedXmr, then
    //    check — which dropped the order before the funds were ever recorded.) ──
    {
        let clock = 0; const expired = []; const ms = mockScanner();
        const a = createPaymentAgent({ scanner: ms, minConfirmations: 1, expiryMs: 1000, now: () => clock, onExpire: o => expired.push(o.id), pollMs: 1e9 });
        const o = await a.createOrder({ id: 'race', amount: '0.1' });
        // funds arrive on-chain, but no tick has run since; clock jumps to exactly expiry.
        ms.rows.set(o.index, [row(xmrToPico('0.1'))]);
        clock = 1000;
        await a.tick();
        const r = a.get('race');
        ok('order funded in its expiry tick is COMPLETED, not orphaned', !!r && r.paid === true && r.status === 'paid', r ? r.status : 'deleted');
        ok('onExpire never fired for the funded order', expired.length === 0);
    }

    console.log(`\n${fail === 0 ? 'ALL GREEN' : 'FAILED'}  ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
})();
