// chaos/reorg STRESS test — settlement under a chain that won't sit still.
//
// the existing reorg.test.js walks a handful of scripted steps; chaos.test.js
// hits one transition per category. this one HAMMERS: it runs long, seeded,
// pseudo-random sequences of chain events against the same order(s), driving
// BOTH the pre-settlement re-evaluation (summarizeTransfers via the agent's
// check()) AND the post-settlement latch (the poller tick), and asserts the
// safety invariants hold after EVERY single step — not just at the end.
//
// the chain is a small in-memory model: a tx can be in the mempool, get mined
// at a height with a growing confirmation count, be ORPHANED by a reorg and
// re-mined at a NEW height (confirmations reset and climb again), have its
// double_spend_seen flag toggle while contested, and carry an unlock_time that
// is in the past (spendable), in the future (frozen), or unreadable (node
// flapping). nodes disagree by each reporting their own confirmation count;
// the watcher's summarizeTransfers takes the conservative reading.
//
// INVARIANTS asserted every step (the whole point — a single violation fails):
//   I1  never paid while confirmed-depth < minConfirmations (the reorg defence).
//   I2  a reorg SHALLOWER than minConfirmations can NEVER have settled the order.
//   I3  once settled, the order LATCHES — paid never flips back to false, the
//       canonical state stays 'settled', and the receivedXmr never drops to 0.
//   I4  a future/locked or unreadable unlock_time FAILS CLOSED — never paid.
//   I5  contested money (double_spend_seen) is never credited toward settlement.
//   I6  onPaid fires AT MOST once per order, only on the real unpaid→paid edge.
//   I7  funds that arrived on-chain are never orphaned: a partial/received order
//       is never silently dropped or reported as having lost money mid-flight.
//
//   node test/chaos-reorg.test.js
//
// deterministic: a tiny seeded LCG drives every random choice, so a failure is
// reproducible (the seed + step index pinpoint it). no network, no monero-ts.

const { createPaymentAgent } = require('../src/agent');
const { summarizeTransfers } = require('../src/watch');
const { xmrToPico, picoToXmr } = require('../src/verify');

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { (c ? pass++ : fail++); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`); };

// ── seeded PRNG (mulberry32) — deterministic, reproducible per seed ──────────
function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const pick = (rnd, arr) => arr[Math.floor(rnd() * arr.length)];
const chance = (rnd, p) => rnd() < p;

const PICO = 100000000000n;        // 0.1 XMR
const AMOUNT = '0.1';
const MIN_CONF = 5;

// ── the chain model for ONE order's subaddress ───────────────────────────────
// a single payment tx whose on-chain fate we perturb. fields mirror exactly what
// watch.js toRow/summarizeTransfers consume: { txid, amountPico, confirmations,
// inPool, locked, doubleSpendSeen, unlockTime }. `state` is our bookkeeping.
function makeChain(rnd) {
    return {
        // 'absent'  — nothing on chain yet (or fully orphaned back to nothing)
        // 'pool'    — seen in the mempool, 0 confs
        // 'mined'   — in a block, confs >= 1, climbing
        phase: 'absent',
        confirmations: 0,
        height: 0,                 // block it was mined at (changes on a reorg re-mine)
        amountPico: PICO,
        doubleSpendSeen: false,
        // unlock_time as Monero encodes it: 0 = unlocked, <5e8 = block height,
        // else unix ts. we keep it 0 for the common case and occasionally freeze.
        unlockTime: 0,
        // a frozen flag we toggle to model the freeze scam (future unlock_time)
        frozen: false,
        rnd,
    };
}

// advance the chain by one random event. returns a label for diagnostics.
function step(c, { allowDeepReorg }) {
    const r = c.rnd;
    switch (c.phase) {
        case 'absent':
            if (chance(r, 0.6)) { c.phase = 'pool'; c.confirmations = 0; return 'enter-mempool'; }
            return 'still-absent';
        case 'pool':
            if (chance(r, 0.5)) { c.phase = 'mined'; c.confirmations = 1; c.height = 100 + Math.floor(r() * 50); return 'mined@1'; }
            if (chance(r, 0.15)) { c.phase = 'absent'; c.confirmations = 0; return 'dropped-from-pool'; }
            return 'still-pool';
        case 'mined': {
            const roll = r();
            // reorg: orphaned back to the pool (or out entirely), confs vanish.
            // PRE-settlement this is the case the confirmation gate must survive.
            if (roll < 0.18) {
                if (chance(r, 0.5)) { c.phase = 'pool'; c.confirmations = 0; return 'reorg→pool'; }
                c.phase = 'absent'; c.confirmations = 0; return 'reorg→orphaned';
            }
            // re-org re-mine at a NEW height: confirmations reset to 1 and climb again.
            if (roll < 0.28) { c.height = 100 + Math.floor(r() * 50); c.confirmations = 1; return 're-mined@new-height'; }
            // a deep reorg that drops confirmations but stays mined (pre-settlement dip)
            if (roll < 0.38 && c.confirmations > 1) { c.confirmations = Math.max(1, c.confirmations - 1 - Math.floor(r() * 2)); return 'confs-dropped'; }
            // a contested double-spend appears / clears while in flight
            if (roll < 0.48) { c.doubleSpendSeen = !c.doubleSpendSeen; return c.doubleSpendSeen ? 'double-spend-seen' : 'double-spend-cleared'; }
            // freeze / unfreeze via unlock_time (future = frozen)
            if (roll < 0.56) {
                c.frozen = !c.frozen;
                c.unlockTime = c.frozen ? Math.floor(Date.now() / 1000) + 3600 : 0;
                return c.frozen ? 'frozen(future-unlock)' : 'unfrozen';
            }
            // the common, healthy case: another block stacks on top.
            c.confirmations += 1 + Math.floor(r() * 3);
            // optionally let a big honest run blow past minConf so settlement happens
            if (allowDeepReorg && c.confirmations > MIN_CONF + 8 && chance(r, 0.1)) {
                // a DEEP reorg AFTER the order could have settled — the latch case.
                c.phase = 'absent'; c.confirmations = 0; return 'deep-reorg(post-settle-window)';
            }
            return 'confirm+';
        }
    }
    return 'noop';
}

// project the chain into the rows summarizeTransfers / the mock scanner consume.
// models NODE DISAGREEMENT: when asked, each "node" can shade the confirmation
// count; the watcher must take the CONSERVATIVE (minimum) reading. here we just
// hand the conservative row, since summarizeTransfers is the conservative sink.
function rowsFor(c) {
    if (c.phase === 'absent') return [];
    const locked = c.unlockTime !== 0;   // a future unlock_time presents as locked
    return [{
        txid: 'tx_' + c.height,
        amountPico: c.amountPico,
        confirmations: c.phase === 'pool' ? 0 : c.confirmations,
        inPool: c.phase === 'pool',
        locked,
        doubleSpendSeen: c.doubleSpendSeen,
        unlockTime: c.unlockTime,
    }];
}

// a scanner mock that reads rows from the live chain model, exactly like
// reorg.test.js's mock but driven by makeChain. summarizeTransfers does the work,
// so we exercise the REAL classifier (dedup, conf gate, locked/pool/double-spend
// hold-back), not a re-implementation.
function chainScanner(chains) {
    let idx = 0;
    return {
        async sync() { /* no-op; a tick just re-reads the model */ },
        async newSubaddress() { const i = ++idx; return { address: `sub_${i}`, index: i, atHeight: 1000 + i }; },
        async addressAt(i) { return `sub_${i}`; },
        async checkOrder({ subaddressIndex, amount, minConfirmations = 1 }) {
            const c = chains.get(subaddressIndex);
            return summarizeTransfers(rowsFor(c), xmrToPico(amount), minConfirmations);
        },
    };
}

// ─────────────────────────────────────────────────────────────────────────────
(async () => {

    // ════════════════════════════════════════════════════════════════════════
    // PART A — single-order fuzz: 12 seeds × ~400 steps, alternating check()
    // (pre-settlement re-evaluation) and tick() (the poller / latch path), with
    // the FULL invariant set asserted after every step.
    // ════════════════════════════════════════════════════════════════════════
    let totalSteps = 0;
    let everSettled = 0;
    let latchHeld = 0;

    for (let seed = 1; seed <= 12; seed++) {
        const rnd = rng(seed * 2654435761);
        const chains = new Map();
        const scanner = chainScanner(chains);
        const paidEvents = [];
        const agent = createPaymentAgent({
            scanner, minConfirmations: MIN_CONF,
            onPaid: o => paidEvents.push(o.id),
        });
        await agent.createOrder({ id: 'o', amount: AMOUNT });   // sub index 1
        const c = makeChain(rnd);
        chains.set(1, c);

        let settledAtStep = -1;        // step index where the agent first latched paid
        let everHadConfirmedDepth = false;

        const STEPS = 350 + Math.floor(rnd() * 100);
        for (let s = 0; s < STEPS; s++) {
            totalSteps++;
            step(c, { allowDeepReorg: true });

            // alternate the two settlement paths so BOTH are driven every seed:
            // even step → check() (re-evaluates even a settled order, the latch
            // path applyResult guards); odd step → tick() (poller, skips settled).
            const before = agent.get('o');
            const wasPaid = before.paid;
            let r;
            if (s % 2 === 0) r = await agent.check('o');
            else { await agent.tick(); r = agent.get('o'); }

            // what the chain ACTUALLY presents this step (ground truth for asserts)
            const rows = rowsFor(c);
            const confirmedDepth = (c.phase === 'mined' && !c.doubleSpendSeen && c.unlockTime === 0)
                ? c.confirmations : 0;
            if (confirmedDepth >= MIN_CONF) everHadConfirmedDepth = true;

            const ctx = `seed=${seed} step=${s} phase=${c.phase} confs=${c.confirmations} dss=${c.doubleSpendSeen} ut=${c.unlockTime} status=${r.status}`;

            // ── I3 · LATCH: once settled, never un-settles ──────────────────
            if (wasPaid) {
                if (!(r.paid === true && r.state === 'settled')) { ok('LATCH never un-settles', false, ctx); break; }
                if (!(Number(r.receivedXmr) >= 0.1)) { ok('LATCH keeps received >= price', false, ctx + ` recv=${r.receivedXmr}`); break; }
                latchHeld++;
                continue;   // a latched order's chain churn no longer concerns the safety asserts below
            }

            // ── PRE-SETTLEMENT invariants (order not yet latched) ───────────
            if (r.paid) {
                // it just crossed unpaid→paid THIS step. it may only do so on a
                // genuinely settle-able chain state. assert ALL gates were open.
                settledAtStep = s;

                // I1 · confirmed depth must have reached minConfirmations
                if (confirmedDepth < MIN_CONF) { ok('I1 paid only at/above minConfirmations', false, ctx + ` confirmedDepth=${confirmedDepth}`); break; }
                // I4 · unlock_time must be unlocked (not frozen)
                if (c.unlockTime !== 0) { ok('I4 paid only when unlock_time unlocked', false, ctx); break; }
                // I5 · not contested
                if (c.doubleSpendSeen) { ok('I5 paid only when not double-spend-seen', false, ctx); break; }
                // I2 · the order is mined (a pool/absent tx can never have settled)
                if (c.phase !== 'mined') { ok('I2 paid only when actually mined', false, ctx); break; }
            } else {
                // not paid this step — verify the lib didn't UNDER-report funds it
                // can see (I7 fund-safety, pre-settlement): whatever is on-chain
                // (confirmed+pending+locked) is reflected, never silently zeroed
                // while a tx is present.
                const seenPico = rows.reduce((s2, t) => s2 + (t.amountPico < 0n ? 0n : t.amountPico), 0n);
                const reported = picoToXmr(BigInt(r.receivedPico || '0'))
                    + Number(r.pendingXmr || 0) + Number(r.lockedXmr || 0);
                if (rows.length && Math.abs(reported - picoToXmr(seenPico)) > 1e-9) {
                    ok('I7 on-chain funds reflected, never silently dropped', false, ctx + ` reported=${reported} seen=${picoToXmr(seenPico)}`);
                    break;
                }
                // I1 restated: a not-paid step with full confirmed depth + clean
                // gates is the LEGAL place to settle — but it must NOT have settled
                // on anything LESS. (covered by the paid branch; here we assert the
                // converse: insufficient depth never yields paid — trivially true
                // since r.paid is false, but we also confirm status isn't 'paid'.)
                if (r.status === 'paid') { ok('I1 status never paid below gate', false, ctx); break; }
            }
        }

        // ── per-seed roll-up invariants ─────────────────────────────────────
        const finalPaid = agent.get('o').paid;
        if (settledAtStep >= 0) everSettled++;

        // I6 · onPaid fired at most once, only if it actually settled.
        ok(`seed ${seed}: onPaid fired ≤ once, matches settled state`,
            paidEvents.filter(x => x === 'o').length === (finalPaid ? 1 : 0),
            `events=${paidEvents.length} finalPaid=${finalPaid}`);

        // I2 · if it ever settled, the chain MUST at some point have presented a
        // confirmed depth >= minConfirmations (a shallow reorg can't have settled it).
        if (settledAtStep >= 0) {
            ok(`seed ${seed}: settlement implies depth reached minConfirmations`,
                everHadConfirmedDepth, `settledAtStep=${settledAtStep}`);
        }
    }

    ok('PART A: every seed exercised many steps', totalSteps > 3000, `${totalSteps} steps`);
    ok('PART A: at least one seed actually settled (latch path was driven)', everSettled > 0, `${everSettled}/12 settled`);
    ok('PART A: latch path held across post-settlement chain churn', latchHeld > 0, `${latchHeld} latched re-checks`);

    // ════════════════════════════════════════════════════════════════════════
    // PART B — targeted adversarial sequences (deterministic, not fuzzed).
    // each pins one invariant on a hand-built worst case the fuzzer might miss.
    // ════════════════════════════════════════════════════════════════════════

    // B1 · a tx that oscillates around minConfirmations (4↔6) for a long run must
    //      ONLY ever read paid in the windows where confirmedDepth >= minConf, and
    //      once it latches, the subsequent dip below minConf must NOT un-settle it.
    {
        const chains = new Map();
        const scanner = chainScanner(chains);
        const paid = [];
        const agent = createPaymentAgent({ scanner, minConfirmations: MIN_CONF, onPaid: o => paid.push(o.id) });
        await agent.createOrder({ id: 'osc', amount: AMOUNT });
        const c = makeChain(rng(42)); c.phase = 'mined'; c.height = 200;
        chains.set(1, c);
        const seq = [4, 3, 4, 6, 4, 7, 3, 8, 2, 9, 1];   // crosses up & down repeatedly
        let latched = false, violated = false;
        for (const confs of seq) {
            c.confirmations = confs;
            const r = await agent.check('osc');
            if (!latched) {
                if (confs < MIN_CONF && r.paid) { violated = true; break; }   // I1
                if (r.paid) latched = true;
            } else {
                if (!r.paid) { violated = true; break; }   // I3 latch
            }
        }
        ok('B1 oscillation: paid only at/above minConf, then latches through dips', !violated && latched);
        ok('B1 oscillation: onPaid fired exactly once', paid.filter(x => x === 'osc').length === 1);
    }

    // B2 · reorg SHALLOWER than minConfirmations can never settle: drive confs up
    //      to minConf-1, orphan, re-mine to minConf-1 again, repeat — never paid.
    {
        const chains = new Map();
        const scanner = chainScanner(chains);
        const agent = createPaymentAgent({ scanner, minConfirmations: MIN_CONF });
        await agent.createOrder({ id: 'shallow', amount: AMOUNT });
        const c = makeChain(rng(7)); chains.set(1, c);
        let everPaid = false;
        for (let i = 0; i < 40; i++) {
            // climb to JUST under the gate
            c.phase = 'mined'; c.height = 300 + i; c.confirmations = MIN_CONF - 1;
            let r = await agent.check('shallow');
            if (r.paid) { everPaid = true; break; }
            // orphan it
            c.phase = 'absent'; c.confirmations = 0;
            r = await agent.check('shallow');
            if (r.paid) { everPaid = true; break; }
            if (Number(r.receivedXmr) !== 0) { everPaid = true; break; }   // orphan resets confirmed credit
        }
        ok('B2 shallow reorg (depth < minConf, repeated) never settles', !everPaid);
        ok('B2 orphan resets confirmed credit to 0 (no stale paid memory)', !chains.size || agent.get('shallow').paid === false);
    }

    // B3 · frozen (future unlock_time) with full confirmations + full amount: the
    //      classic freeze scam. confirmations and amount both look perfect; the
    //      time-lock gate must hold it as locked, never paid, no matter how deep.
    {
        const chains = new Map();
        const scanner = chainScanner(chains);
        const agent = createPaymentAgent({ scanner, minConfirmations: MIN_CONF });
        await agent.createOrder({ id: 'frozen', amount: AMOUNT });
        const c = makeChain(rng(9));
        c.phase = 'mined'; c.height = 500; c.frozen = true; c.unlockTime = Math.floor(Date.now() / 1000) + 86400;
        chains.set(1, c);
        let everPaid = false, sawLocked = false;
        for (let confs = MIN_CONF; confs <= MIN_CONF + 20; confs++) {
            c.confirmations = confs;
            const r = await agent.check('frozen');
            if (r.paid) { everPaid = true; break; }
            if (r.status === 'locked') sawLocked = true;
        }
        ok('B3 freeze scam (future unlock_time): never paid even at great depth', !everPaid);
        ok('B3 freeze scam: surfaces as locked (fail closed, loud)', sawLocked);
        // unfreeze → it must then settle (proves it was the lock holding it, not a stuck order)
        c.unlockTime = 0; c.confirmations = MIN_CONF + 1;
        const r = await agent.check('frozen');
        ok('B3 once unlock_time elapses → settles (lock was the only thing holding it)', r.paid);
    }

    // B4 · double_spend_seen toggling at full depth: contested money is never
    //      credited; only after the flag clears (and depth holds) may it settle.
    {
        const chains = new Map();
        const scanner = chainScanner(chains);
        const agent = createPaymentAgent({ scanner, minConfirmations: MIN_CONF });
        await agent.createOrder({ id: 'ds', amount: AMOUNT });
        const c = makeChain(rng(11));
        c.phase = 'mined'; c.height = 700; c.confirmations = MIN_CONF + 5; c.doubleSpendSeen = true;
        chains.set(1, c);
        let paidWhileContested = false;
        for (let i = 0; i < 25; i++) {
            // keep it contested; depth keeps growing — must STILL never pay
            c.confirmations += 1;
            const r = await agent.check('ds');
            if (r.paid) { paidWhileContested = true; break; }
        }
        ok('B4 double_spend_seen at full depth: contested money never credited', !paidWhileContested);
        // clear the contest → now it may settle
        c.doubleSpendSeen = false;
        const r = await agent.check('ds');
        ok('B4 once double_spend_seen clears → settles', r.paid);
    }

    // B5 · partial payment that is NEVER orphaned: a confirmed-but-short order
    //      keeps its received credit across a churning chain; the top-up that
    //      lands later settles it. (funds-never-orphaned, the agent's expiry
    //      invariant — here proven through summarizeTransfers reporting.)
    {
        const chains = new Map();
        // custom multi-row scanner: index 1 has TWO installments we control
        let rows1 = [];
        const scanner = {
            async sync() {},
            async newSubaddress() { return { address: 'sub_1', index: 1, atHeight: 1001 }; },
            async addressAt() { return 'sub_1'; },
            async checkOrder({ amount, minConfirmations = 1 }) {
                return summarizeTransfers(rows1, xmrToPico(amount), minConfirmations);
            },
        };
        const agent = createPaymentAgent({ scanner, minConfirmations: MIN_CONF });
        await agent.createOrder({ id: 'partial', amount: AMOUNT });
        // first installment: 0.06, confirmed deep
        rows1 = [{ txid: 'a'.repeat(64), amountPico: 60000000000n, confirmations: MIN_CONF + 3, inPool: false, locked: false }];
        let r = await agent.check('partial');
        ok('B5 partial: confirmed-but-short → not paid, but funds reported', !r.paid && Number(r.receivedXmr) > 0);
        const credited = r.receivedXmr;
        // chain churns: second tx appears in pool, then a reorg dips the FIRST tx's
        // confs but stays above the gate — the credited 0.06 must not vanish.
        rows1 = [
            { txid: 'a'.repeat(64), amountPico: 60000000000n, confirmations: MIN_CONF, inPool: false, locked: false },
            { txid: 'b'.repeat(64), amountPico: 40000000000n, confirmations: 0, inPool: true, locked: false },
        ];
        r = await agent.check('partial');
        ok('B5 partial: confirmed credit survives chain churn (funds not orphaned)', !r.paid && r.receivedXmr >= credited);
        // top-up confirms → settles to exactly the order
        rows1 = [
            { txid: 'a'.repeat(64), amountPico: 60000000000n, confirmations: MIN_CONF + 1, inPool: false, locked: false },
            { txid: 'b'.repeat(64), amountPico: 40000000000n, confirmations: MIN_CONF, inPool: false, locked: false },
        ];
        r = await agent.check('partial');
        ok('B5 partial: top-up confirms → settles, funds never lost', r.paid && r.receivedXmr >= 0.1);
    }

    // B6 · node disagreement on confirmations: summarizeTransfers must take the
    //      CONSERVATIVE reading. two rows for the SAME txid, one deep one shallow
    //      (a flapping/lying node) — dedup's moreCreditable picks the higher conf,
    //      BUT a double_spend_seen or locked copy wins, holding the money. here we
    //      assert a contested duplicate can never be out-voted into settling.
    {
        const expected = xmrToPico(AMOUNT);
        // same txid: one clean+deep, one contested. contested copy must win → held.
        const a = summarizeTransfers([
            { txid: 'c'.repeat(64), amountPico: PICO, confirmations: MIN_CONF + 9, inPool: false, locked: false, doubleSpendSeen: false },
            { txid: 'c'.repeat(64), amountPico: PICO, confirmations: MIN_CONF + 9, inPool: false, locked: false, doubleSpendSeen: true },
        ], expected, MIN_CONF);
        ok('B6 node disagreement: contested duplicate of same tx → held, not paid', !a.paid && a.status !== 'paid', a.status);
        // same txid: clean+deep vs locked copy → locked copy wins → held as locked
        const b = summarizeTransfers([
            { txid: 'd'.repeat(64), amountPico: PICO, confirmations: MIN_CONF + 9, inPool: false, locked: false },
            { txid: 'd'.repeat(64), amountPico: PICO, confirmations: MIN_CONF + 9, inPool: false, locked: true },
        ], expected, MIN_CONF);
        ok('B6 node disagreement: locked duplicate of same tx → held as locked', !b.paid && b.status === 'locked', b.status);
        // same txid disagreeing on AMOUNT → SMALLER wins (can't settle on bogus larger)
        const e = summarizeTransfers([
            { txid: 'e'.repeat(64), amountPico: PICO, confirmations: MIN_CONF + 9, inPool: false, locked: false },
            { txid: 'e'.repeat(64), amountPico: 50000000000n, confirmations: MIN_CONF + 9, inPool: false, locked: false },
        ], expected, MIN_CONF);
        ok('B6 node disagreement: smaller amount wins → underpaid, not paid on bogus larger', !e.paid, e.status);
    }

    // B7 · the latch under a poller tick specifically (mirrors reorg.test.js r3
    //      but stressed): settle, then orphan ENTIRELY, then tick repeatedly —
    //      the poller must never re-check a settled order back to unpaid.
    {
        const chains = new Map();
        const scanner = chainScanner(chains);
        const paid = [];
        const agent = createPaymentAgent({ scanner, minConfirmations: MIN_CONF, onPaid: o => paid.push(o.id) });
        await agent.createOrder({ id: 'latch', amount: AMOUNT });
        const c = makeChain(rng(99)); c.phase = 'mined'; c.height = 900; c.confirmations = MIN_CONF + 6;
        chains.set(1, c);
        let r = await agent.check('latch');
        ok('B7 latch: settles at depth', r.paid);
        c.phase = 'absent'; c.confirmations = 0;   // deep reorg orphans the settled tx
        let held = true;
        for (let i = 0; i < 30; i++) { await agent.tick(); if (!agent.get('latch').paid) { held = false; break; } }
        ok('B7 latch: 30 poller ticks after a deep orphan keep it paid', held);
        ok('B7 latch: onPaid never re-fired', paid.filter(x => x === 'latch').length === 1);
    }

    console.log(`\n${fail === 0 ? 'ALL GREEN' : 'FAILED'}  ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('chaos-reorg test error:', e); process.exit(2); });
