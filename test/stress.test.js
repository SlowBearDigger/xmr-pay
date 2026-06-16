// STRESS + adversarial tests — push the agent, the pool, and the summing
// classifier hard to surface concurrency races, exhaustion bugs, and math edge
// cases the unit tests don't reach. offline (mock scanner), so it's CI-safe.
//   node test/stress.test.js

const { createPaymentAgent } = require('../src/agent');
const { summarizeTransfers } = require('../src/watch');
const { creditableRows } = require('../src/scanner');
const { xmrToPico, picoToXmrString } = require('../src/verify');

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { (c ? pass++ : fail++); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`); };

function mockScanner() {
    let idx = 0;
    const rowsByIndex = new Map();
    const self = {
        rowsByIndex, newSubCalls: 0, syncs: 0,
        async sync() { self.syncs++; },
        async newSubaddress() { self.newSubCalls++; const i = ++idx; return { address: `sub_${i}`, index: i, atHeight: 1000 + i }; },
        async addressAt(i) { return `sub_${i}`; },
        async checkOrder({ subaddressIndex, amount, minConfirmations = 1 }) {
            return summarizeTransfers(rowsByIndex.get(subaddressIndex) || [], xmrToPico(amount), minConfirmations);
        },
    };
    return self;
}
const row = (pico, o = {}) => ({ txid: (o.id || 't') + '_' + pico, amountPico: BigInt(pico), confirmations: o.confs ?? 10, inPool: !!o.pool, locked: !!o.locked, height: o.height ?? 5000 });

(async () => {
    // ---------- 1. high-volume concurrent createOrder (auto ids, no pool) ----------
    {
        const ms = mockScanner();
        const agent = createPaymentAgent({ scanner: ms, minConfirmations: 1 });
        const N = 300;
        const orders = await Promise.all(Array.from({ length: N }, () => agent.createOrder({ amount: '0.01' })));
        const ids = new Set(orders.map(o => o.id));
        const subs = new Set(orders.map(o => o.address));
        ok('300 concurrent orders → all ids unique', ids.size === N, `${ids.size}/${N}`);
        ok('300 concurrent orders → all subaddresses unique', subs.size === N, `${subs.size}/${N}`);
        ok('agent.list reflects all', agent.list().length === N);
        agent.stop();
    }

    // ---------- 2. duplicate explicit id under concurrency ----------
    {
        const ms = mockScanner();
        const agent = createPaymentAgent({ scanner: ms });
        const results = await Promise.allSettled([
            agent.createOrder({ id: 'dup', amount: '0.1' }),
            agent.createOrder({ id: 'dup', amount: '0.1' }),
            agent.createOrder({ id: 'dup', amount: '0.1' }),
        ]);
        const okCount = results.filter(r => r.status === 'fulfilled').length;
        const rejCount = results.filter(r => r.status === 'rejected').length;
        ok('concurrent duplicate id → exactly ONE succeeds, rest rejected', okCount === 1 && rejCount === 2, `${okCount} ok / ${rejCount} rejected`);
        ok('only one order stored for the duplicate id', agent.list().filter(o => o.id === 'dup').length === 1);
        agent.stop();
    }

    // ---------- 3. onPaid fires exactly ONCE under concurrent checks ----------
    {
        const ms = mockScanner();
        let paid = 0;
        const agent = createPaymentAgent({ scanner: ms, minConfirmations: 1, onPaid: () => { paid++; } });
        const o = await agent.createOrder({ id: 'p', amount: '0.1' });
        ms.rowsByIndex.set(o.index, [row(100000000000)]); // exactly 0.1, confirmed
        await Promise.all([agent.check('p'), agent.check('p'), agent.check('p'), agent.check('p')]);
        ok('onPaid fires exactly once despite 4 concurrent checks', paid === 1, `fired ${paid}×`);
        agent.stop();
    }

    // ---------- 4. pool exhaustion + background refill under burst ----------
    {
        const ms = mockScanner();
        const agent = createPaymentAgent({ scanner: ms, subaddressPool: 8, poolLabel: 'x', pollMs: 1e9 });
        agent.start();
        await new Promise(r => setTimeout(r, 30));
        const burst = await Promise.all(Array.from({ length: 50 }, (_, i) => agent.createOrder({ id: 'b' + i, amount: '0.01' })));
        const subs = new Set(burst.map(o => o.address));
        ok('50-order burst (pool 8) → all subaddresses unique (no reuse)', subs.size === 50, `${subs.size}/50`);
        ok('burst orders all have a birthday height', burst.every(o => o.birthdayHeight != null));
        await new Promise(r => setTimeout(r, 50));
        ok('pool refills back toward target after the burst', agent.poolReady() >= 1, `pool=${agent.poolReady()}`);
        agent.stop();
    }

    // ---------- 5. summarizeTransfers — adversarial mixes ----------
    {
        const req = xmrToPico('1.0'); // 1 XMR
        // 1000 dust transfers that sum to exactly the amount
        const dust = Array.from({ length: 1000 }, (_, i) => row(1000000000, { id: 'd' + i })); // 0.001 each ×1000 = 1.0
        const s1 = summarizeTransfers(dust, req, 1);
        ok('1000 dust installments summing to 1.0 → paid', s1.paid && s1.status === 'paid', `${s1.receivedXmr}`);

        // one giant overpay — paid, and flagged overpaid with the EXACT excess
        const s2 = summarizeTransfers([row(50000000000000)], req, 1); // 50 XMR for a 1 XMR order
        ok('massive overpay → paid (received 50)', s2.paid && Number(s2.receivedXmr) === 50);
        ok('overpay → flagged overpaid, exact excess', s2.overpaid === true && s2.overpaidXmr === '49');
        // exact payment is NOT flagged overpaid
        const s2e = summarizeTransfers([row(1000000000000)], req, 1); // exactly 1 XMR
        ok('exact pay → not overpaid, excess 0', s2e.paid && s2e.overpaid === false && s2e.overpaidXmr === '0');
        // defense in depth: expected 0 must NEVER summarize as paid (0 >= 0)
        const s2z = summarizeTransfers([row(0)], 0n, 1);
        ok('expected 0 → NOT paid (no false-paid on a zero-amount order)', s2z.paid === false && s2z.status === 'invalid');

        // all in mempool (0-conf) → not paid yet
        const s3 = summarizeTransfers([row(2000000000000, { pool: true, confs: 0 })], req, 1);
        ok('confirmed-amount but all in mempool → not paid (mempool)', !s3.paid && s3.status === 'mempool', s3.status);

        // double_spend_seen: a CONFIRMED, sufficient payment is still NOT credited
        // while the daemon flags it as double-spent (contested) — stricter than
        // MoneroPay/BTCPay, which don't gate on this.
        const ds = { ...row(1000000000000, { confs: 50 }), doubleSpendSeen: true };
        const s3d = summarizeTransfers([ds], req, 1);
        ok('double_spend_seen confirmed payment → NOT paid (held until flag clears)', !s3d.paid, s3d.status);
        // once the flag clears, the same payment settles normally
        const s3dc = summarizeTransfers([{ ...ds, doubleSpendSeen: false }], req, 1);
        ok('cleared double_spend_seen → paid', s3dc.paid && s3dc.status === 'paid');

        // payment tolerance: within tolerancePico of the price still completes (dust/
        // fee/rounding), shortfall 0, not overpaid; but tolerance can NEVER reach the
        // price (no false-pay on ~nothing).
        const tol = 200000000000n; // 0.2 XMR
        const tOk = summarizeTransfers([row(900000000000)], req, 1, tol); // 0.9, threshold 0.8 → paid
        ok('within tolerance → paid (not stuck underpaid), shortfall 0, not overpaid', tOk.paid && tOk.shortfallXmr === '0' && tOk.overpaid === false);
        const tNo = summarizeTransfers([row(700000000000)], req, 1, tol); // 0.7 < 0.8 → not paid
        ok('below (price − tolerance) → still not paid', !tNo.paid);
        const tGuard = summarizeTransfers([row(1)], req, 1, 2000000000000n); // tol >= price → no false-pay
        ok('tolerance >= price never false-pays', !tGuard.paid);
        const tExact = summarizeTransfers([row(1000000000000)], req, 1, tol); // exact pay with tolerance set → not overpaid
        ok('exact pay with tolerance set → paid, not overpaid', tExact.paid && tExact.overpaid === false);

        // all explicitly locked (time-lock) → held, not paid
        const s4 = summarizeTransfers([row(2000000000000, { locked: true })], req, 1);
        ok('time-locked funds → not paid (locked)', !s4.paid, s4.status);

        // exactly at the threshold (1 piconero under, then exact)
        const under = summarizeTransfers([row(Number(req) - 1 + '')], req, 1); // 1 pico short
        ok('1 piconero short → NOT paid', under.paid === false, `short=${under.shortfallXmr}`);
        const exact = summarizeTransfers([row(req.toString())], req, 1);
        ok('exact to the piconero → paid, shortfall 0', exact.paid && exact.shortfallXmr === '0');
    }

    // ---------- 6. pico round-trip fuzz (money math, no float drift) ----------
    {
        let bad = 0;
        for (let i = 0; i < 20000; i++) {
            const pico = BigInt(Math.floor(Math.random() * 1e15));   // up to 1000 XMR in pico
            const s = picoToXmrString(pico);
            if (xmrToPico(s) !== pico) { bad++; if (bad <= 3) console.log('   drift:', pico.toString(), '->', s, '->', xmrToPico(s).toString()); }
        }
        ok('20000 pico→string→pico round-trips are EXACT (no drift)', bad === 0, `${bad} drifted`);
    }

    // ---------- 7. creditableRows boundary fuzz ----------
    {
        let leaked = 0, dropped = 0;
        for (let i = 0; i < 5000; i++) {
            const birthday = 1000 + Math.floor(Math.random() * 1e6);
            const h = birthday + Math.floor(Math.random() * 20) - 10; // ±10 around birthday
            const kept = creditableRows([{ height: h, amountPico: 1n, inPool: false }], birthday);
            if (h < birthday - 3 && kept.length) leaked++;          // stale should be dropped
            if (h >= birthday && !kept.length) dropped++;           // valid must be kept
        }
        ok('creditableRows never credits clearly-stale heights', leaked === 0, `${leaked} leaked`);
        ok('creditableRows never drops at/after birthday', dropped === 0, `${dropped} dropped`);
    }

    console.log(`\n${fail === 0 ? 'ALL GREEN' : 'FAILED'}  ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('stress test error:', e); process.exit(2); });
