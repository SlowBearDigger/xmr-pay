// HIGH-LOAD / THROUGHPUT stress test — offline, MOCK scanner, no framework.
// drives the real createPaymentAgent + the real summarizeTransfers at volume to
// prove the scale invariants the unit suite (agent.test.js) doesn't exercise:
//   - a tick is O(1) in NODE QUERIES regardless of order count (ONE sync + ONE
//     checkOrders batch per poll, never one query per order),
//   - settlement is correct under volume (every order that received >= price is
//     paid exactly once, nothing under price is paid, no order is mis-credited),
//   - per-tick LOCALS don't grow unboundedly (the batch hands the scanner exactly
//     the still-pending set; settled/expired orders fall out),
//   - summarizeTransfers stays correct on very large row sets, long installment
//     chains, and adversarial-at-scale rows (amounts near the 2^53 / uint64
//     boundary, many same-output-key duplicates for burning-bug dedup, and
//     double-spend-seen storms),
//   - timing stays sane (a large tick completes well under a generous budget).
// fully DETERMINISTIC: a seeded PRNG, an injected `now`, no Date.now/Math.random
// in any assertion.
//   node test/agent.load.test.js

const { createPaymentAgent } = require('../src/agent');
const { summarizeTransfers } = require('../src/watch');
const { xmrToPico, picoToXmrString } = require('../src/verify');

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { (c ? pass++ : fail++); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`); };

// scale knob — kept at the low end of the requested 5k–50k band so the test runs
// in CI in a couple of seconds. bump via env for a heavier soak (LOAD_N=50000).
const N = Number(process.env.LOAD_N) || 8000;

// deterministic PRNG (mulberry32) — seeded, so the workload + assertions never
// depend on Date.now/Math.random. same seed => same orders, payments, results.
function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// an injected clock the agent reads via `now` — advanced by hand, never wall-time.
function fakeClock(start = 1_000_000_000_000) { let t = start; return { now: () => t, advance: (ms) => { t += ms; } }; }

const r0 = (amountPico, opts = {}) => ({
    txid: (opts.id || 'tx') + '_' + amountPico,
    amountPico: BigInt(amountPico),
    confirmations: opts.confs ?? 10,
    inPool: !!opts.pool,
    locked: !!opts.locked,
    doubleSpendSeen: !!opts.dss,
    ...(opts.outKey ? { outKey: opts.outKey } : {}),
});

// ── a BATCH scanner mock that COUNTS node queries ──────────────────────────────
// exposes checkOrders (the O(1) scale path the agent prefers). rowsByIndex feeds
// the REAL summarizeTransfers, so the summing/settlement under load is the real
// one. it also records the max batch size it was ever handed (to prove per-tick
// locals track the pending set, not the full order count) and the deterministic
// height it sits at (no Date.now).
function batchScanner() {
    let idx = 0;
    const rowsByIndex = new Map();
    const self = {
        rowsByIndex,
        syncs: 0,
        checkOrderCalls: 0,   // per-order path — must stay 0 when batch is used
        checkOrdersCalls: 0,  // batch path — must be exactly 1 per tick
        rowsScanned: 0,       // total rows summarized across the run
        maxBatch: 0,          // largest list ever handed to checkOrders
        newSubCalls: 0,
        async sync() { self.syncs++; },
        async newSubaddress() { self.newSubCalls++; const i = ++idx; return { address: `sub_${i}`, index: i, atHeight: 1000 + i }; },
        async addressAt(i) { return `sub_${i}`; },
        async checkOrder({ subaddressIndex, amount, minConfirmations = 1, toleranceXmr = '0' }) {
            self.checkOrderCalls++;
            const tol = toleranceXmr && toleranceXmr !== '0' ? xmrToPico(toleranceXmr) : 0n;
            return summarizeTransfers(rowsByIndex.get(subaddressIndex) || [], xmrToPico(amount), minConfirmations, tol);
        },
        // ONE account-wide scan distributed across every pending order. in the real
        // scanner this is a single getTransfers; here we just route each order's
        // rows through summarizeTransfers and tally how much work the tick induced.
        async checkOrders(list, { minConfirmations = 1, toleranceXmr = '0' } = {}) {
            self.checkOrdersCalls++;
            if (list.length > self.maxBatch) self.maxBatch = list.length;
            const tol = toleranceXmr && toleranceXmr !== '0' ? xmrToPico(toleranceXmr) : 0n;
            const out = new Map();
            for (const o of list) {
                const rows = rowsByIndex.get(o.index) || [];
                self.rowsScanned += rows.length;
                out.set(o.id, summarizeTransfers(rows, xmrToPico(o.amount), minConfirmations, tol));
            }
            return out;
        },
    };
    return self;
}

(async () => {
    // ════════════════════════════════════════════════════════════════════════
    // PART 1 — summarizeTransfers under VOLUME + adversarial-at-scale rows
    // (pure, no agent — isolates the summing classifier's scale behaviour)
    // ════════════════════════════════════════════════════════════════════════

    // 1a. a LONG installment chain: PRICE paid as `parts` separate confirmed
    //     transfers must sum to exactly paid (a buyer dripping in small amounts).
    {
        const parts = 5000;
        const per = 200000n;                       // 0.0000002 XMR each
        const price = per * BigInt(parts);         // exact
        const rows = [];
        for (let i = 0; i < parts; i++) rows.push(r0(per, { id: 'inst' + i }));
        const t0 = process.hrtime.bigint();
        const s = summarizeTransfers(rows, price, 1);
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        ok(`installment chain of ${parts} confirmed transfers sums to paid, shortfall 0`,
            s.paid && s.status === 'paid' && s.shortfallXmr === '0', `recv=${s.receivedPico} in ${ms.toFixed(1)}ms`);
        ok('a long chain summarizes fast (<200ms)', ms < 200, `${ms.toFixed(1)}ms`);
    }

    // 1b. ONE missing piconero across a long chain => NOT paid, exact 1-pico shortfall.
    {
        const parts = 4000, per = 250000n, price = per * BigInt(parts);
        const rows = [];
        for (let i = 0; i < parts; i++) rows.push(r0(per, { id: 'm' + i }));
        rows[0] = r0(per - 1n, { id: 'm0' });      // short by exactly one piconero
        const s = summarizeTransfers(rows, price, 1);
        ok('one piconero short across a long chain => not paid, 1-pico shortfall',
            !s.paid && s.status === 'partial' && s.shortfallXmr === picoToXmrString(1n), s.shortfallXmr);
    }

    // 1c. BURNING-BUG dedup at scale: many rows that SHARE one output key are at most
    //     ONE spendable output — summing them all would credit one payment thousands
    //     of times. dedup must collapse them to a single credit (price NOT met).
    {
        const dupes = 6000;
        const price = xmrToPico('1');              // 1 XMR
        const rows = [];
        for (let i = 0; i < dupes; i++) rows.push(r0(xmrToPico('0.5'), { id: 'burn' + i, outKey: 'SHARED_OUTPUT_KEY' }));
        const s = summarizeTransfers(rows, price, 1);
        ok(`${dupes} rows sharing ONE output key credit ONCE (burning-bug dedup) => not paid`,
            !s.paid && s.receivedPico === xmrToPico('0.5').toString(), `recv=${s.receivedPico}`);
        // and the dedup is order-independent: shuffle (seeded) and re-summarize => same verdict.
        const rnd = rng(0xBADF00D);
        const shuf = rows.slice();
        for (let i = shuf.length - 1; i > 0; i--) { const j = (rnd() * (i + 1)) | 0; const tmp = shuf[i]; shuf[i] = shuf[j]; shuf[j] = tmp; }
        const s2 = summarizeTransfers(shuf, price, 1);
        ok('burning-bug dedup is order-independent at scale', s2.receivedPico === s.receivedPico && s2.paid === s.paid);
    }

    // 1d. DOUBLE-SPEND-SEEN storm: a flood of contested (double_spend_seen) copies of
    //     a confirmed payment must be held as pending — NEVER credited — even though
    //     the amount would otherwise cover the price.
    {
        const storm = 6000;
        const price = xmrToPico('2');
        const rows = [r0(xmrToPico('2'), { id: 'real', confs: 100, outKey: 'OUT_REAL' })];   // a clean confirmed copy...
        for (let i = 0; i < storm; i++) rows.push(r0(xmrToPico('2'), { id: 'real', confs: 100, dss: true, outKey: 'OUT_REAL' }));  // ...flooded by contested copies of the SAME output
        const s = summarizeTransfers(rows, price, 1);
        // moreCreditable: a double-spend-seen copy WINS the dedup => the output is held as pending.
        ok('double-spend-seen storm holds the contested output as pending, never paid',
            !s.paid && s.receivedPico === '0', `recv=${s.receivedPico} status=${s.status}`);
    }

    // 1e. WHALE near the 2^53 / uint64 boundary: BigInt summing must stay EXACT where
    //     a float (Number) would lose precision. two transfers just above 2^53 pico
    //     each, summed, settle a price set to their exact total.
    {
        const big = (1n << 53n) + 12345n;          // ~9007.2 XMR, just past JS safe-int in PICO
        const price = big * 2n;                    // exact total, well under MAX_PICO (uint64)
        const rows = [r0(big, { id: 'whale1', outKey: 'W1' }), r0(big, { id: 'whale2', outKey: 'W2' })];
        const s = summarizeTransfers(rows, price, 1);
        ok('two whale transfers past 2^53 pico sum EXACTLY (BigInt, not float) => paid',
            s.paid && s.receivedPico === price.toString() && s.shortfallXmr === '0', `recv=${s.receivedPico}`);
        // one piconero short of that whale total must NOT settle (float math would round it to paid).
        const s2 = summarizeTransfers([r0(big, { id: 'w1', outKey: 'W1' }), r0(big - 1n, { id: 'w2', outKey: 'W2' })], price, 1);
        ok('whale total short by ONE piconero is NOT paid (no float rounding to paid)',
            !s2.paid && s2.shortfallXmr === picoToXmrString(1n), s2.shortfallXmr);
    }

    // 1f. malformed-row resilience at scale: a heavy mix of nulls, non-objects, bad
    //     amounts, and negatives interleaved with real transfers must not crash and
    //     must credit ONLY the valid confirmed rows.
    {
        const price = xmrToPico('0.3');
        const rows = [];
        for (let i = 0; i < 3000; i++) {
            rows.push(null, 'garbage', { amountPico: 'not-a-number', txid: 'b' + i }, r0(-5n, { id: 'neg' + i }));
            rows.push(r0(xmrToPico('0.0001'), { id: 'good' + i }));   // 3000 * 0.0001 = 0.3
        }
        let threw = false; let s;
        try { s = summarizeTransfers(rows, price, 1); } catch { threw = true; }
        ok('a heavy malformed-row mix never throws; credits only valid confirmed rows => paid',
            !threw && s.paid && s.receivedPico === xmrToPico('0.3').toString(), threw ? 'threw' : `recv=${s.receivedPico}`);
    }

    // ════════════════════════════════════════════════════════════════════════
    // PART 2 — createPaymentAgent at VOLUME: O(1) queries/tick, correct settlement,
    // no mis-credit, bounded per-tick locals.
    // ════════════════════════════════════════════════════════════════════════

    const clk = fakeClock();
    const ms = batchScanner();
    const paid = [];                 // ids onPaid fired for (push order — assert exactly once each)
    const paidCount = new Map();     // id -> times onPaid fired (must never exceed 1)
    const agent = createPaymentAgent({
        scanner: ms,
        minConfirmations: 1,
        pollMs: 1e9, activePollMs: 1e9,           // manual ticks only — no background timer races
        now: clk.now,
        onPaid: (o) => { paid.push(o.id); paidCount.set(o.id, (paidCount.get(o.id) || 0) + 1); },
    });

    // create N orders. a seeded PRNG assigns each a deterministic "plan": ~half will
    // be paid in full, ~quarter partially, ~quarter never. price varies per order.
    const rnd = rng(0xC0FFEE);
    const PRICE_POOL = ['0.001', '0.01', '0.1', '0.25', '1', '2.5'];
    const plan = new Map();          // id -> { price, kind } ; kind: 'full' | 'partial' | 'none'
    const tCreate0 = process.hrtime.bigint();
    for (let i = 0; i < N; i++) {
        const price = PRICE_POOL[(rnd() * PRICE_POOL.length) | 0];
        const u = rnd();
        const kind = u < 0.5 ? 'full' : u < 0.75 ? 'partial' : 'none';
        const o = await agent.createOrder({ id: 'L' + i, amount: price });
        plan.set(o.id, { price, kind, index: o.index });
    }
    const createMs = Number(process.hrtime.bigint() - tCreate0) / 1e6;
    ok(`created ${N} orders`, agent.list().length === N, `${agent.list().length} orders in ${createMs.toFixed(0)}ms`);
    ok('one subaddress created per order (no double allocation)', ms.newSubCalls === N, `${ms.newSubCalls} subs`);

    // every order's subaddress index is UNIQUE — a shared index would double-credit.
    {
        const seen = new Set(); let dup = false;
        for (const o of agent.list()) { if (seen.has(o.index)) { dup = true; break; } seen.add(o.index); }
        ok('every order has a UNIQUE subaddress index (no mis-credit possible)', !dup);
    }

    // EMPTY tick (no payments yet): exactly ONE sync + ONE checkOrders for ALL pending,
    // and the per-order path is never touched. THIS is the O(1)-queries invariant.
    await agent.tick();
    ok('tick syncs exactly ONCE regardless of order count (O(1) sync)', ms.syncs === 1, `${ms.syncs} syncs`);
    ok('tick calls checkOrders exactly ONCE for ALL pending (O(1) queries, not O(N))', ms.checkOrdersCalls === 1, `${ms.checkOrdersCalls} batch calls`);
    ok('tick never falls back to the per-order checkOrder path', ms.checkOrderCalls === 0, `${ms.checkOrderCalls} per-order calls`);
    ok('the batch was handed every pending order exactly once', ms.maxBatch === N, `maxBatch=${ms.maxBatch}`);
    ok('no order paid before any funds arrive', paid.length === 0);

    // fund the orders per plan. full => exact price (sometimes split into installments);
    // partial => half price; none => nothing. all rows carry an outKey (burning-safe).
    let expectedPaid = 0;
    for (const [id, p] of plan) {
        const idx = p.index;
        const price = xmrToPico(p.price);
        if (p.kind === 'full') {
            expectedPaid++;
            // ~30% of full payers drip the price across 3 installments (long-chain at order scale)
            if (rnd() < 0.3) {
                const a = price / 3n, b = price / 3n, c = price - a - b;   // exact split, no lost pico
                ms.rowsByIndex.set(idx, [
                    r0(a, { id: id + '_1', outKey: id + '_k1' }),
                    r0(b, { id: id + '_2', outKey: id + '_k2' }),
                    r0(c, { id: id + '_3', outKey: id + '_k3' }),
                ]);
            } else {
                ms.rowsByIndex.set(idx, [r0(price, { id: id + '_1', outKey: id + '_k1' })]);
            }
        } else if (p.kind === 'partial') {
            ms.rowsByIndex.set(idx, [r0(price / 2n, { id: id + '_p', outKey: id + '_kp' })]);
        }
        // 'none' => no rows
    }

    // run several ticks (settlement should complete on the first funded tick; extra
    // ticks prove idempotency + that settled orders fall OUT of the batch).
    const tTick0 = process.hrtime.bigint();
    await agent.tick();
    const tick1Ms = Number(process.hrtime.bigint() - tTick0) / 1e6;
    const afterFirstFundedBatch = ms.checkOrdersCalls;   // = 2 (the empty tick + this one)

    ok('a fully-funded tick over all orders completes under budget (<2000ms)', tick1Ms < 2000, `${tick1Ms.toFixed(0)}ms`);
    ok('still exactly ONE batch query for the funded tick (O(1) under volume)', afterFirstFundedBatch === 2, `${afterFirstFundedBatch} total batch calls`);

    // settlement correctness: exactly the 'full' orders are paid; nothing else.
    {
        let wrongPaid = 0, missedPaid = 0;
        for (const [id, p] of plan) {
            const o = agent.get(id);
            const shouldBePaid = p.kind === 'full';
            if (o.paid !== shouldBePaid) { if (o.paid) wrongPaid++; else missedPaid++; }
        }
        ok('every full-payment order settled, nothing else did (no mis-credit, no miss)',
            wrongPaid === 0 && missedPaid === 0 && paid.length === expectedPaid,
            `paidEvents=${paid.length} expected=${expectedPaid} wrongPaid=${wrongPaid} missedPaid=${missedPaid}`);
    }
    // partial orders are 'partial' with a non-zero shortfall; none orders stay 'pending'.
    {
        let partialOk = true, noneOk = true;
        for (const [id, p] of plan) {
            const o = agent.get(id);
            if (p.kind === 'partial' && !(o.status === 'partial' && o.shortfallXmr !== '0' && !o.paid)) partialOk = false;
            if (p.kind === 'none' && !(o.status === 'pending' && !o.paid)) noneOk = false;
        }
        ok('every partial order is partial with a non-zero shortfall', partialOk);
        ok('every unfunded order stays pending', noneOk);
    }

    // onPaid fired EXACTLY ONCE per settled order (no double-credit on the event side).
    {
        let over = 0; for (const v of paidCount.values()) if (v > 1) over++;
        ok('onPaid fired at most once per order (no double-fire under volume)', over === 0, `${over} double-fires`);
        ok('settled-order count equals distinct onPaid ids', paidCount.size === expectedPaid);
    }

    // IDEMPOTENCY + bounded locals: re-tick. settled orders must DROP OUT of the batch
    // (per-tick locals track the still-pending set, not the full order count) and no
    // onPaid re-fires.
    const stillPending = [...plan.values()].filter(p => p.kind !== 'full').length;
    const paidBeforeRetick = paid.length;
    ms.maxBatch = 0;                                  // reset the high-water mark
    await agent.tick();
    ok('after settlement the batch shrinks to ONLY the still-pending orders (locals bounded by pending, not total)',
        ms.maxBatch === stillPending, `batch=${ms.maxBatch} pending=${stillPending} total=${N}`);
    ok('re-tick re-fires onPaid for nobody (settled latches)', paid.length === paidBeforeRetick);
    ok('still exactly one batch call per tick after settlement', ms.checkOrdersCalls === 3);

    // O(1) PROOF across order count: rows scanned in the post-settlement tick is bounded
    // by pending orders' rows, and sync stayed 1-per-tick the whole run.
    ok('sync count equals tick count (always one sync per poll)', ms.syncs === 3, `${ms.syncs} syncs / 3 ticks`);

    // ════════════════════════════════════════════════════════════════════════
    // PART 3 — adversarial orders run THROUGH the agent at the boundary + a
    // double-spend-seen storm against a real order (settlement must hold).
    // ════════════════════════════════════════════════════════════════════════
    {
        const clk2 = fakeClock();
        const ms2 = batchScanner();
        const fired = [];
        const a = createPaymentAgent({ scanner: ms2, minConfirmations: 1, pollMs: 1e9, activePollMs: 1e9, now: clk2.now, onPaid: o => fired.push(o.id) });

        // a whale order priced just past 2^53 pico, paid exactly => settles via the agent.
        const big = (1n << 53n) + 999n;
        const whale = await a.createOrder({ id: 'WHALE', amount: picoToXmrString(big) });
        ms2.rowsByIndex.set(whale.index, [r0(big, { id: 'wpay', outKey: 'WK' })]);

        // a contested order: the right amount arrives but every copy is double_spend_seen
        // (a storm) => held pending, NEVER settles, even though the amount covers price.
        const contested = await a.createOrder({ id: 'CONTESTED', amount: '1' });
        const cRows = [];
        for (let i = 0; i < 3000; i++) cRows.push(r0(xmrToPico('1'), { id: 'cpay', confs: 50, dss: true, outKey: 'CK' }));
        ms2.rowsByIndex.set(contested.index, cRows);

        // a burning-bug order: thousands of copies of ONE output, each half the price =>
        // credited ONCE (half) => stays partial, never settles on the duplicate flood.
        const burn = await a.createOrder({ id: 'BURN', amount: '1' });
        const bRows = [];
        for (let i = 0; i < 5000; i++) bRows.push(r0(xmrToPico('0.5'), { id: 'bpay', outKey: 'BK' }));
        ms2.rowsByIndex.set(burn.index, bRows);

        await a.tick();
        ok('agent settles a whale order at the 2^53 pico boundary (exact BigInt)', a.get('WHALE').paid === true && fired.includes('WHALE'));
        ok('agent NEVER settles a double-spend-seen storm (contested held pending)', a.get('CONTESTED').paid === false && !fired.includes('CONTESTED'));
        ok('agent NEVER settles a burning-bug duplicate flood (credited once => partial)', a.get('BURN').paid === false && a.get('BURN').status === 'partial');
        ok('still exactly one batch query despite tens of thousands of adversarial rows', ms2.checkOrdersCalls === 1, `${ms2.checkOrdersCalls} batch calls, ${ms2.rowsScanned} rows scanned`);
        a.stop();
    }

    // ════════════════════════════════════════════════════════════════════════
    // PART 4 — many poll ticks: query count must stay LINEAR IN TICKS, not in
    // (ticks × orders). drives 200 ticks over a steady pending population and
    // asserts exactly one sync + one batch per tick, and per-tick time stays sane.
    // ════════════════════════════════════════════════════════════════════════
    {
        const clk3 = fakeClock();
        const ms3 = batchScanner();
        const a = createPaymentAgent({ scanner: ms3, minConfirmations: 1, pollMs: 1e9, activePollMs: 1e9, now: clk3.now });
        const M = 2000, TICKS = 200;
        for (let i = 0; i < M; i++) await a.createOrder({ id: 'T' + i, amount: '0.1' });   // all stay unpaid (no rows)
        const t0 = process.hrtime.bigint();
        for (let k = 0; k < TICKS; k++) { clk3.advance(15000); await a.tick(); }
        const totalMs = Number(process.hrtime.bigint() - t0) / 1e6;
        ok(`${TICKS} ticks over ${M} pending orders => exactly ${TICKS} syncs (linear in ticks, not ticks×orders)`, ms3.syncs === TICKS, `${ms3.syncs} syncs`);
        ok(`${TICKS} ticks => exactly ${TICKS} batch queries (one per tick)`, ms3.checkOrdersCalls === TICKS, `${ms3.checkOrdersCalls} batch calls`);
        ok('per-order checkOrder never used across all ticks', ms3.checkOrderCalls === 0);
        ok('mean tick time stays sane (<50ms/tick on 2000 pending orders)', (totalMs / TICKS) < 50, `${(totalMs / TICKS).toFixed(2)}ms/tick`);
        a.stop();
    }

    agent.stop();
    console.log(`\n${fail === 0 ? 'ALL GREEN' : 'FAILED'}  ${pass} passed, ${fail} failed  (N=${N})`);
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('load test error:', e); process.exit(2); });
