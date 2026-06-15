// "break it" — adversarial + scaling stress that goes after the failure modes a
// happy-path suite misses: per-tick I/O cost at scale, extreme amounts, overpay
// after settlement, pool exhaustion under burst, and dust floods.
//   node test/break.test.js

const { createPaymentAgent } = require('../src/agent');
const { summarizeTransfers } = require('../src/watch');
const { xmrToPico, picoToXmrString } = require('../src/verify');

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { (c ? pass++ : fail++); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`); };

function mockScanner() {
    let idx = 0; const rows = new Map();
    const self = {
        rows, syncs: 0,
        async sync() { self.syncs++; },
        async newSubaddress() { const i = ++idx; return { address: 's' + i, index: i, atHeight: 1000 + i }; },
        async addressAt(i) { return 's' + i; },
        async checkOrder({ subaddressIndex, amount, minConfirmations = 1 }) {
            return summarizeTransfers(rows.get(subaddressIndex) || [], xmrToPico(amount), minConfirmations);
        },
    };
    return self;
}
let seq = 0;
const row = (pico, confs = 10) => ({ txid: 't' + pico + '_' + (++seq), amountPico: BigInt(pico), confirmations: confs, inPool: false, locked: false });

(async () => {
    // ── SCALING: onUpdate fires once PER pending order PER tick. if the caller
    //    wires it to "write the whole ledger", that's O(N) blocking writes/tick. ──
    {
        const ms = mockScanner(); let updates = 0;
        const agent = createPaymentAgent({ scanner: ms, minConfirmations: 1, onUpdate: () => { updates++; }, pollMs: 1e9 });
        const N = 2000;
        for (let i = 0; i < N; i++) { const o = await agent.createOrder({ amount: '0.1' }); ms.rows.set(o.index, [row('50000000000')]); }
        updates = 0;
        const t0 = Date.now(); await agent.tick(); const dt = Date.now() - t0;
        ok(`tick over ${N} pending orders → onUpdate fires once each (O(N))`, updates === N, `${updates} updates / ${dt}ms`);
        console.log(`    ⚠ if onUpdate writes the full ledger, that is ${N} blocking writes per ${dt}ms tick — COALESCE the save.`);
    }

    // ── the FIX pattern: a coalescing/debounced saver collapses a burst into 1 ──
    {
        let writes = 0, timer = null, dirty = false;
        const markDirty = () => { dirty = true; if (timer) return; timer = setTimeout(() => { timer = null; if (dirty) { dirty = false; writes++; } }, 10); };
        for (let i = 0; i < 5000; i++) markDirty();
        await new Promise(r => setTimeout(r, 40));
        ok('coalescing saver: 5000 dirty-marks → exactly 1 write', writes === 1, `${writes} writes`);
    }

    // ── extreme amounts: exactness near Monero's ~18.4M-XMR supply (2^64-1 pico) ──
    {
        const big = '18446744.073709551615';
        const p = xmrToPico(big);
        ok('extreme amount round-trips exact (no float overflow)', picoToXmrString(p) === big && xmrToPico(picoToXmrString(p)) === p, picoToXmrString(p));
        const exact = summarizeTransfers([row(String(p))], p, 1);
        ok('extreme exact-pay → paid, shortfall 0', exact.paid && xmrToPico(exact.shortfallXmr) === 0n);
        const off = summarizeTransfers([row(String(p - 1n))], p, 1);
        ok('extreme off-by-1-pico → underpaid (shortfall exactly 1 pico)', !off.paid && xmrToPico(off.shortfallXmr) === 1n);
    }

    // ── overpay AFTER settlement: stays paid (latch), onPaid still once ──
    {
        const ms = mockScanner(); const paid = [];
        const a = createPaymentAgent({ scanner: ms, minConfirmations: 1, onPaid: o => paid.push(o.id) });
        const o = await a.createOrder({ id: 'op', amount: '0.1' });
        ms.rows.set(o.index, [row('100000000000')]);
        let r = await a.check('op'); ok('order settles', r.paid);
        ms.rows.set(o.index, [row('100000000000'), row('500000000000')]); // a big overpay lands later
        await a.tick();
        ok('overpay after settlement: stays paid, onPaid fired exactly once', a.get('op').paid === true && paid.length === 1);
    }

    // ── pool exhaustion under burst: 200 concurrent orders, pool=8 → no reuse ──
    {
        const ms = mockScanner();
        const a = createPaymentAgent({ scanner: ms, minConfirmations: 1, subaddressPool: 8, poolLabel: 'o', pollMs: 1e9 });
        const os = await Promise.all(Array.from({ length: 200 }, (_, i) => a.createOrder({ id: 'b' + i, amount: '0.1' })));
        const idxs = os.map(o => o.index);
        ok('200-order burst (pool 8): every subaddress index unique, none reused', new Set(idxs).size === 200, `${new Set(idxs).size}/200 unique`);
    }

    // ── dust flood: 50k tiny transfers to one subaddress, no choke / no overflow ──
    {
        const dust = Array.from({ length: 50000 }, () => row('1000'));   // 50000 × 1000 pico = 0.00005 XMR
        const t0 = Date.now();
        const r = summarizeTransfers(dust, xmrToPico('0.00005'), 1);
        const dt = Date.now() - t0;
        ok('50k dust transfers: summed exactly, paid, no overflow', r.paid && xmrToPico(r.shortfallXmr) === 0n && r.txids.length === 50000, `${dt}ms`);
    }

    console.log(`\n${fail === 0 ? 'ALL GREEN' : 'FAILED'}  ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
})();
