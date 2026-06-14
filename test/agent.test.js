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
        async sync() { self.syncs++; },
        async newSubaddress(label) { const i = ++idx; return { address: `sub_${i}`, index: i, atHeight: 1000 + i }; },
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

    // bind an EXISTING subaddress index (e.g. a re-registered order after restart)
    const o3 = await agent.createOrder({ id: 'ord_3', amount: '0.05', index: 1 });
    ok('createOrder can bind an existing subaddress index', o3.index === 1 && o3.address === 'sub_1');
    r = await agent.check('ord_3');
    ok('bound order sees the same chain payments (0.1) → paid for 0.05', r.paid && r.status === 'paid');

    // dedup + introspection
    let threw = false;
    try { await agent.createOrder({ id: 'ord_1', amount: '0.1' }); } catch { threw = true; }
    ok('duplicate order id is rejected', threw);
    ok('list returns all orders', agent.list().length === 3);
    ok('get returns the order by id', agent.get('ord_2').id === 'ord_2');
    ok('check on an unknown order → null', (await agent.check('nope')) === null);

    agent.stop();
    console.log(`\n${fail === 0 ? 'ALL GREEN' : 'FAILED'}  ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('agent test error:', e); process.exit(2); });
