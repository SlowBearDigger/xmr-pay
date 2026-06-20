// adversarial stress — the UGLY sides. these tests are written to BREAK the money
// path, not to confirm the happy path. each block targets a property a payment
// processor must hold under hostile / churny / out-of-order input, and is designed
// to FAIL loudly if the property is violated (a real finding), not to pass quietly.
//
// focus: summarizeTransfers (the pure settlement verdict) under
//   - out-of-order rows (a money verdict must not depend on row order)
//   - the same txid surfacing twice (in+pool overlap) in any order
//   - in/pool/locked flapping across polls (reorg / mempool churn)
//   - byzantine duplicate rows that disagree on amount/confirmations
//   - dust floods that share txids
//   node test/adversarial-stress.test.js

const fc = require('fast-check');
const { summarizeTransfers } = require('../src/watch');
const { xmrToPico } = require('../src/verify');

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { (c ? pass++ : fail++); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`); };
function prop(name, arbs, pred, runs = 3000) {
    try { fc.assert(fc.property(...arbs, pred), { numRuns: runs }); pass++; console.log('PASS  ' + name); }
    catch (e) { fail++; console.log('FAIL  ' + name + '  — ' + (e && e.message ? String(e.message).split('\n').slice(0, 2).join(' | ') : String(e))); }
}

// project a summary onto the fields a caller actually settles on. order-independence
// and dedup must hold for ALL of these, not just `paid`.
const verdict = r => `${r.paid}|${r.status}|${r.receivedPico}|${r.shortfallXmr}|${r.confirmations}`;

// ── 1. ORDER INDEPENDENCE (the headline ugly side) ──
// a settlement verdict must be identical no matter what order the node/wallet
// happened to return the transfers in. monero-ts getTransfers gives NO ordering
// guarantee, so a first-wins dedup that keeps a pool copy over a confirmed copy
// would strand a real payment as "mempool". generate rows that include duplicate
// txids with differing pool/confirmation state and assert order can't change money.
const txidPool = ['t_a', 't_b', 't_c', ''];                 // small pool → forces collisions
const dupTransfer = fc.record({
    txid: fc.constantFrom(...txidPool),
    amountPico: fc.bigInt({ min: 0n, max: 10n ** 15n }),
    confirmations: fc.nat({ max: 30 }),
    inPool: fc.boolean(),
    locked: fc.boolean(),
});
const dupRows = fc.array(dupTransfer, { maxLength: 10 });

prop('order-independence: shuffling the rows never changes the verdict', [dupRows, fc.bigInt({ min: 1n, max: 10n ** 15n }), fc.integer({ min: 1, max: 10 })],
    (rows, exp, mc) => {
        const a = verdict(summarizeTransfers(rows, exp, mc));
        const b = verdict(summarizeTransfers([...rows].reverse(), exp, mc));
        return a === b;
    });

prop('order-independence: a full sort by confirmations cannot change the verdict', [dupRows, fc.bigInt({ min: 1n, max: 10n ** 15n }), fc.integer({ min: 1, max: 10 })],
    (rows, exp, mc) => {
        const a = verdict(summarizeTransfers(rows, exp, mc));
        const b = verdict(summarizeTransfers([...rows].sort((x, y) => x.confirmations - y.confirmations), exp, mc));
        return a === b;
    });

// ── 2. A CONFIRMED PAYMENT IS NEVER STRANDED BY A POOL DUPLICATE ──
// the exact bug a first-wins dedup hides: the SAME txid arrives as a pool row AND a
// confirmed row in one poll. whichever order they come in, the money is confirmed.
(() => {
    const conf = { txid: 't_x', amountPico: 5n, confirmations: 10, inPool: false, locked: false };
    const pool = { txid: 't_x', amountPico: 5n, confirmations: 0, inPool: true, locked: false };
    const a = summarizeTransfers([conf, pool], 5n, 1);   // confirmed-first (wallet-rpc order)
    const b = summarizeTransfers([pool, conf], 5n, 1);   // pool-first (no-guarantee order)
    ok('confirmed payment settles regardless of in/pool row order',
        a.paid === true && b.paid === true && a.receivedPico === '5' && b.receivedPico === '5',
        `confirmed-first: paid=${a.paid} recv=${a.receivedPico} | pool-first: paid=${b.paid} recv=${b.receivedPico}`);
})();

// ── 3. NEVER DOUBLE-CREDIT THE SAME TXID (false-paid guard) ──
// the in/pool overlap must be counted once. two confirmed copies of one txid must
// not sum to twice the money and trip an underpaid order into "paid".
(() => {
    const c1 = { txid: 't_y', amountPico: 5n, confirmations: 10, inPool: false, locked: false };
    const c2 = { txid: 't_y', amountPico: 5n, confirmations: 10, inPool: false, locked: false };
    const r = summarizeTransfers([c1, c2], 10n, 1);   // expects 10; only 5 truly arrived
    ok('duplicate confirmed txid is NOT summed twice (no false-paid)',
        r.paid === false && r.receivedPico === '5',
        `paid=${r.paid} recv=${r.receivedPico}`);
})();

// ── 4. BYZANTINE DUPLICATE: same txid, DIFFERENT amounts ──
// a buggy/hostile source reports the same txid with two different amounts. the
// verdict must be deterministic and must never let the larger bogus claim settle
// an order that wasn't actually paid.
(() => {
    const small = { txid: 't_z', amountPico: 1n, confirmations: 10, inPool: false, locked: false };
    const big = { txid: 't_z', amountPico: 999999n, confirmations: 10, inPool: false, locked: false };
    const a = verdict(summarizeTransfers([small, big], 1000n, 1));
    const b = verdict(summarizeTransfers([big, small], 1000n, 1));
    ok('byzantine same-txid different-amount: verdict is order-independent',
        a === b, `[small,big]=${a} | [big,small]=${b}`);
})();

// ── 5. IN/POOL/LOCKED FLAPPING ACROSS POLLS (reorg + mempool churn) ──
// model the same txid as the daemon view churns: pool → confirmed → (reorg) pool
// again. once truly confirmed-and-counted a later view can re-evaluate, but the
// verdict for each poll must be a function of THAT poll's rows only, never a
// double-count, and a still-pool tx must never read as paid.
(() => {
    const T = 't_flap';
    const poll1 = [{ txid: T, amountPico: 100n, confirmations: 0, inPool: true, locked: false }];
    const poll2 = [{ txid: T, amountPico: 100n, confirmations: 3, inPool: false, locked: false }];
    const poll3 = [{ txid: T, amountPico: 100n, confirmations: 0, inPool: true, locked: false }]; // orphaned back to pool
    const r1 = summarizeTransfers(poll1, 100n, 1);
    const r2 = summarizeTransfers(poll2, 100n, 1);
    const r3 = summarizeTransfers(poll3, 100n, 1);
    ok('flapping: pool poll is not paid', r1.paid === false && r1.status === 'mempool', `r1=${verdict(r1)}`);
    ok('flapping: confirmed poll is paid exactly once', r2.paid === true && r2.receivedPico === '100', `r2=${verdict(r2)}`);
    ok('flapping: re-orphaned poll is not paid again', r3.paid === false, `r3=${verdict(r3)}`);
})();

// ── 6. DUST FLOOD THAT SHARES TXIDS ──
// 5000 dust rows, many sharing a handful of txids (a spam scan), must summarize
// without error, without ever crediting a duplicate twice, in bounded time.
(() => {
    const rows = [];
    for (let i = 0; i < 5000; i++) {
        rows.push({ txid: 'dust_' + (i % 50), amountPico: 1n, confirmations: (i % 2) ? 10 : 0, inPool: !(i % 2), locked: false });
    }
    const r = summarizeTransfers(rows, 1000n, 1);
    // only 50 distinct txids exist; at most 50 pico can ever be credited, not 5000.
    ok('dust flood with shared txids: credited <= distinct-txid count, no blowup',
        BigInt(r.receivedPico) <= 50n, `recv=${r.receivedPico} (expected <= 50)`);
})();

// ── 7. FUZZ: credited money never exceeds the per-txid max confirmed total ──
// the core anti-false-paid invariant under random duplicate-heavy input: a txid is
// counted at most once, and at most the largest confirmed amount any copy claims —
// so neither double-counting nor an inflated duplicate can ever over-credit.
prop('fuzz: confirmedSum never exceeds the per-txid max confirmed total (no inflated/double credit)', [dupRows, fc.integer({ min: 1, max: 10 })],
    (rows, mc) => {
        const r = summarizeTransfers(rows, 1n, mc);
        const confAmt = t => {
            let a; try { a = (typeof t.amountPico === 'bigint') ? t.amountPico : BigInt(t.amountPico); } catch { return 0n; }
            if (a < 0n) return 0n;
            return (!t.locked && !t.inPool && (Number(t.confirmations) || 0) >= mc) ? a : 0n;
        };
        const maxByTxid = new Map();   // real txid -> largest confirmed-unlocked amount among its copies
        let bound = 0n;                // empty-txid rows are each their own payment
        for (const t of rows) {
            const c = confAmt(t);
            if (!t.txid) { bound += c; continue; }
            const prev = maxByTxid.get(t.txid) || 0n;
            if (c > prev) maxByTxid.set(t.txid, c);
        }
        for (const v of maxByTxid.values()) bound += v;
        return BigInt(r.receivedPico) <= bound;
    });

console.log(`\n${fail ? 'FAILED' : 'ALL GREEN'}  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
