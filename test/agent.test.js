// payment agent lifecycle — offline, with a MOCK scanner (no monero-ts). drives
// an order through pending → partial → paid and asserts the one-time onPaid fires
// exactly once, plus order binding, dedup, and poll behaviour. uses the REAL
// summarizeTransfers so the summing/shortfall the agent surfaces is the real one.
//   node test/agent.test.js

const { createPaymentAgent } = require('../src/agent');
const { summarizeTransfers } = require('../src/watch');
const { xmrToPico } = require('../src/verify');

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { (c ? pass++ : fail++); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`); };

// a scanner stand-in: per-subaddress rows feed the real summarizeTransfers.
function mockScanner() {
    let idx = 0;
    const rowsByIndex = new Map();
    const self = {
        rowsByIndex,
        syncs: 0,
        newSubCalls: 0,
        async sync() { self.syncs++; },
        async newSubaddress(label) { self.newSubCalls++; const i = ++idx; return { address: `sub_${i}`, index: i, atHeight: 1000 + i }; },
        async addressAt(i) { return `sub_${i}`; },
        async checkOrder({ subaddressIndex, amount, minConfirmations = 1 }) {
            return summarizeTransfers(rowsByIndex.get(subaddressIndex) || [], xmrToPico(amount), minConfirmations);
        },
    };
    return self;
}
const row = (amountPico, opts = {}) => ({ txid: (opts.id || 'tx') + '_' + amountPico, amountPico: BigInt(amountPico), confirmations: opts.confs ?? 10, inPool: !!opts.pool, locked: !!opts.locked });

(async () => {
    const ms = mockScanner();
    const paidCalls = [];
    const agent = createPaymentAgent({ scanner: ms, minConfirmations: 1, onPaid: (o) => { paidCalls.push(o.id); } });

    // create order → fresh per-order subaddress + birthday
    const o = await agent.createOrder({ id: 'ord_1', amount: '0.1' });
    ok('createOrder returns a per-order subaddress', o.address === 'sub_1' && o.index === 1, JSON.stringify(o));
    ok('new order starts pending, shortfall = full amount', o.status === 'pending' && o.shortfallXmr === '0.1');
    ok('order carries its birthday height', o.birthdayHeight === 1001);

    let r = await agent.check('ord_1');
    ok('check with no payment → pending', r.status === 'pending' && !r.paid);

    // first installment: 0.05 of 0.1
    ms.rowsByIndex.set(1, [row(50000000000, { id: 'a' })]);
    r = await agent.check('ord_1');
    ok('partial payment → partial, shortfall 0.05, not paid', r.status === 'partial' && r.shortfallXmr === '0.05' && !r.paid, r.shortfallXmr);
    ok('onPaid not fired on a partial', paidCalls.length === 0);

    // top-up: a SECOND installment 0.05 → sum 0.1 → paid
    ms.rowsByIndex.set(1, [row(50000000000, { id: 'a' }), row(50000000000, { id: 'b' })]);
    r = await agent.check('ord_1');
    ok('top-up completes the order (sum 0.1) → paid, shortfall 0', r.paid && r.status === 'paid' && r.shortfallXmr === '0', r.status);
    ok('onPaid fired exactly once on the pending→paid transition', paidCalls.length === 1 && paidCalls[0] === 'ord_1');

    // idempotent — re-checking a paid order does not double-fire
    r = await agent.check('ord_1');
    ok('re-check stays paid, onPaid NOT fired again', r.paid && paidCalls.length === 1);

    // poller hits only pending orders
    await agent.createOrder({ id: 'ord_2', amount: '0.2' });
    await agent.tick();
    ok('tick leaves an unpaid order pending', agent.get('ord_2').status === 'pending');
    ok('tick did not re-fire onPaid for the settled order', paidCalls.length === 1);
    ok('tick syncs the wallet ONCE per poll (not per order)', ms.syncs === 1, `synced ${ms.syncs}×`);

    // bind a SPECIFIC, UNUSED subaddress index (advanced/external management)
    const o3 = await agent.createOrder({ id: 'ord_3', amount: '0.05', index: 77 });
    ok('createOrder binds a specific UNUSED subaddress index', o3.index === 77 && o3.address === 'sub_77');
    r = await agent.check('ord_3');
    ok('a freshly-bound, unpaid subaddress is NOT paid', !r.paid && r.status === 'pending');

    // CRITICAL — one subaddress backs at most ONE order. binding an index already
    // held by another order is REJECTED; otherwise a single payment to it would
    // credit BOTH (double-credit). index 1 belongs to ord_1.
    let dbl = false;
    try { await agent.createOrder({ id: 'ord_dbl', amount: '0.05', index: 1 }); } catch { dbl = true; }
    ok('REJECTS reusing an in-use subaddress index (no double-credit)', dbl);

    // dedup + introspection
    let threw = false;
    try { await agent.createOrder({ id: 'ord_1', amount: '0.1' }); } catch { threw = true; }
    ok('duplicate order id is rejected', threw);
    ok('list returns all orders', agent.list().length === 3);
    ok('get returns the order by id', agent.get('ord_2').id === 'ord_2');
    ok('check on an unknown order → null', (await agent.check('nope')) === null);

    // amount sanitization: a bad/zero amount must be rejected BEFORE a subaddress
    // is allocated — never wedge the poller, never auto-pay a 0-amount order.
    const before = agent.list().length;
    const subBefore = ms.newSubCalls;
    for (const bad of ['0', '0.00', 'abc', '-1', '1e5', '1,5']) {
        let rej = false;
        try { await agent.createOrder({ amount: bad }); } catch { rej = true; }
        ok(`createOrder rejects bad amount ${JSON.stringify(bad)}`, rej);
    }
    ok('rejected amounts allocate NO subaddress + create NO order', agent.list().length === before && ms.newSubCalls === subBefore);

    agent.stop();

    // --- subaddress pool: pre-warm + instant handout + background refill ---
    const ms2 = mockScanner();
    const a2 = createPaymentAgent({ scanner: ms2, minConfirmations: 1, subaddressPool: 4, poolLabel: 'order', pollMs: 999999 });
    a2.start();                                       // pre-warms the pool
    await new Promise(r => setTimeout(r, 25));         // let fillPool resolve
    ok('pool pre-warms to N on start', a2.poolReady() === 4, `pool=${a2.poolReady()}`);
    ok('pool pre-created exactly N subaddresses upfront', ms2.newSubCalls === 4, `calls=${ms2.newSubCalls}`);

    const p1 = await a2.createOrder({ id: 'p1', amount: '0.1' });
    ok('createOrder hands out a POOLED subaddress (no live create)', p1.index === 1 && ms2.newSubCalls === 4, `idx=${p1.index} calls=${ms2.newSubCalls}`);
    ok('pooled order keeps its birthday height', p1.birthdayHeight === 1001);
    ok('pool shrank by one', a2.poolReady() === 3);

    // drain below the floor (2) → triggers a background top-up
    await a2.createOrder({ id: 'p2', amount: '0.1' });   // pool 3→2
    await a2.createOrder({ id: 'p3', amount: '0.1' });   // pool 2→1 (<floor) → refill
    await new Promise(r => setTimeout(r, 25));
    ok('pool refills in the background after dropping below floor', a2.poolReady() === 4, `pool=${a2.poolReady()}`);
    ok('refill created more subaddresses', ms2.newSubCalls === 7, `calls=${ms2.newSubCalls}`);
    a2.stop();

    // --- no pool (default): one subaddress created per order, on demand ---
    const ms3 = mockScanner();
    const a3 = createPaymentAgent({ scanner: ms3, minConfirmations: 1 });
    await a3.createOrder({ id: 'n1', amount: '0.1' });
    ok('without a pool, createOrder creates one subaddress on demand', ms3.newSubCalls === 1 && a3.poolReady() === 0);
    a3.stop();

    // --- reload/wallet-counter COLLISION: a lost wallet cache makes newSubaddress
    // re-issue low indices that overlap an order RELOADED from the store. the
    // fresh order must SKIP the collided index, never share a subaddress. ---
    const reloaded = new Map();
    reloaded.set('old', { id: 'old', amount: '0.02', address: 'sub_1', index: 1, status: 'pending', paid: false, receivedXmr: 0, shortfallXmr: '0.02', txids: [] });
    const msC = mockScanner();   // its counter starts at 0 → next newSubaddress = index 1 (collides!)
    const aC = createPaymentAgent({ scanner: msC, store: reloaded, minConfirmations: 1 });
    const fresh = await aC.createOrder({ id: 'fresh', amount: '0.02' });
    ok('fresh order SKIPS the reloaded order\'s index (no collision)', fresh.index !== 1, `got idx ${fresh.index}`);
    // and a payment to the reloaded order\'s subaddress credits ONLY it
    msC.rowsByIndex.set(1, [row(20000000000)]);   // 0.02 paid to index 1
    const rOld = await aC.check('old'); const rFresh = await aC.check('fresh');
    ok('payment to index 1 credits ONLY the order that owns it', rOld.paid === true && rFresh.paid === false);
    aC.stop();

    // CONCURRENCY: two simultaneous binds of the SAME explicit index must not both
    // win (a check-then-act TOCTOU around the addressAt await would double-credit).
    const msR = mockScanner();
    const aR = createPaymentAgent({ scanner: msR, minConfirmations: 1 });
    const race = await Promise.allSettled([
        aR.createOrder({ id: 'r1', amount: '0.02', index: 5 }),
        aR.createOrder({ id: 'r2', amount: '0.02', index: 5 }),
        aR.createOrder({ id: 'r3', amount: '0.02', index: 5 }),
    ]);
    ok('concurrent same-index binds → exactly ONE wins', race.filter(r => r.status === 'fulfilled').length === 1);
    ok('only one order ends up on the contested index', aR.list().filter(o => o.index === 5).length === 1);
    aR.stop();

    // ── BATCH tick: ONE checkOrders for ALL pending orders (the O(1) scale path) ──
    {
        let batchCalls = 0, n = 0; const paid = [];
        const ms = {
            async sync() {},
            async newSubaddress() { const i = ++n; return { address: 'b' + i, index: i, atHeight: 1000 }; },
            async checkOrder() { return { paid: false, status: 'pending', receivedXmr: 0, shortfallXmr: '0.1', confirmations: 0, txids: [] }; },
            async checkOrders(list) {
                batchCalls++; this._last = list;
                const out = new Map();
                for (const o of list) {
                    out.set(o.id, o.id === 'b2'
                        ? { paid: true, status: 'paid', receivedXmr: 0.1, receivedPico: '100000000000', shortfallXmr: '0', confirmations: 5, txids: ['tx'], overpaid: false, overpaidXmr: '0' }
                        : { paid: false, status: 'pending', receivedXmr: 0, shortfallXmr: String(o.amount), confirmations: 0, txids: [] });
                }
                return out;
            },
        };
        const a = createPaymentAgent({ scanner: ms, minConfirmations: 1, pollMs: 1e9, onPaid: o => paid.push(o.id) });
        await a.createOrder({ id: 'b1', amount: '0.1' });
        await a.createOrder({ id: 'b2', amount: '0.1' });
        await a.createOrder({ id: 'b3', amount: '0.1' });
        await a.tick();
        ok('batch tick calls checkOrders ONCE for all pending (O(1), not O(N))', batchCalls === 1, `${batchCalls} calls`);
        ok('batch result folded: b2 settled, b1/b3 still pending', a.get('b2').paid === true && !a.get('b1').paid && !a.get('b3').paid);
        ok('onPaid fired exactly once for the newly-paid order', paid.length === 1 && paid[0] === 'b2');
        await a.tick();
        ok('a settled order is NOT re-checked — the batch only gets the 2 still-pending', ms._last.length === 2 && !ms._last.find(x => x.id === 'b2'));
        a.stop();
    }

    console.log(`\n${fail === 0 ? 'ALL GREEN' : 'FAILED'}  ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('agent test error:', e); process.exit(2); });
