// property-based tests (fast-check) for the money-critical PURE logic. these
// explore the input space instead of a handful of examples — the kind of depth
// that catches the "edge case at transaction #100k" a happy-path suite misses.
//   node test/property.test.js

const fc = require('fast-check');
const { summarizeTransfers } = require('../src/watch');
const { creditableRows } = require('../src/scanner');
const { xmrToPico, picoToXmrString } = require('../src/verify');

let pass = 0, fail = 0;
function prop(name, arbs, pred, runs = 2000) {
    try { fc.assert(fc.property(...arbs, pred), { numRuns: runs }); pass++; console.log('PASS  ' + name); }
    catch (e) {
        fail++;
        const head = (e && e.message ? String(e.message).split('\n').slice(0, 3).join(' | ') : String(e));
        console.log('FAIL  ' + name + '  — ' + head);
    }
}

// piconero amounts up to ~1,000,000 XMR
const pico = fc.bigInt({ min: 0n, max: 10n ** 18n });
const posPico = fc.bigInt({ min: 1n, max: 10n ** 18n });
const txid = fc.string({ maxLength: 8 });
const transfer = fc.record({
    txid,
    amountPico: pico,
    confirmations: fc.nat({ max: 120 }),
    inPool: fc.boolean(),
    locked: fc.boolean(),
});
// real on-chain rows carry UNIQUE txids (one aggregated transfer per tx+subaddress),
// so the generic sum/shortfall invariants below are exercised on realistic data.
// the dedup-by-txid behaviour itself is covered by the dedicated tests further down.
const transfers = fc.array(transfer, { maxLength: 12 }).map(rs => rs.map((t, i) => ({ ...t, txid: t.txid + '#' + i })));
const minConf = fc.integer({ min: 1, max: 20 });

// independent re-derivation of the bucketing (mirror of summarizeTransfers)
const confirmedOf = (rs, mc) => rs.reduce((s, t) => s + ((!t.locked && !t.inPool && t.confirmations >= mc) ? t.amountPico : 0n), 0n);
const seenOf = rs => rs.reduce((s, t) => s + t.amountPico, 0n);

// ── the core money invariant: exact pico round-trip (no float, ever) ──
prop('pico: xmrToPico(picoToXmrString(p)) === p, exactly', [pico],
    p => xmrToPico(picoToXmrString(p)) === p, 5000);

// ── summarizeTransfers ──
prop('summarize: never throws on arbitrary transfers', [transfers, posPico, minConf],
    (rs, exp, mc) => { summarizeTransfers(rs, exp, mc); return true; });

prop('summarize: every transfer txid is preserved', [transfers, posPico, minConf],
    (rs, exp, mc) => summarizeTransfers(rs, exp, mc).txids.length === rs.length);

prop('summarize: status is always one of the five valid states', [transfers, posPico, minConf],
    (rs, exp, mc) => ['paid', 'locked', 'mempool', 'partial', 'pending'].includes(summarizeTransfers(rs, exp, mc).status));

prop('summarize: paid  ⟺  confirmedSum >= expected', [transfers, posPico, minConf],
    (rs, exp, mc) => summarizeTransfers(rs, exp, mc).paid === (confirmedOf(rs, mc) >= exp));

prop('summarize: shortfall === max(0, expected - seen), exact pico', [transfers, posPico, minConf],
    (rs, exp, mc) => {
        const want = seenOf(rs) >= exp ? 0n : exp - seenOf(rs);
        return xmrToPico(summarizeTransfers(rs, exp, mc).shortfallXmr) === want;
    });

prop('summarize: paid  ⟹  shortfall is 0 (never asks a paid buyer for more)', [transfers, posPico, minConf],
    (rs, exp, mc) => { const r = summarizeTransfers(rs, exp, mc); return !r.paid || xmrToPico(r.shortfallXmr) === 0n; });

prop('summarize: adding ANY transfer never increases the shortfall', [transfers, transfer, posPico, minConf],
    (rs, x, exp, mc) =>
        xmrToPico(summarizeTransfers(rs.concat([x]), exp, mc).shortfallXmr)
        <= xmrToPico(summarizeTransfers(rs, exp, mc).shortfallXmr));

prop('summarize: confirmations is the MIN over confirmed transfers (or 0)', [transfers, posPico, minConf],
    (rs, exp, mc) => {
        const confs = rs.filter(t => !t.locked && !t.inPool && t.confirmations >= mc).map(t => t.confirmations);
        const want = confs.length ? Math.min(...confs) : 0;
        return summarizeTransfers(rs, exp, mc).confirmations === want;
    });

// ── dedup by txid (the false-paid defence summarizeTransfers must hold) ──
function check(name, ok, extra = '') {
    if (ok) { pass++; console.log('PASS  ' + name); }
    else { fail++; console.log('FAIL  ' + name + (extra ? '  — ' + extra : '')); }
}

// the SAME real txid in both the confirmed (`in`) and pool lists — a daemon
// mid-update overlap — must be counted ONCE. double-counting it would mark an
// order paid on half the money: the one thing watch mode must never do.
(() => {
    const rows = [
        { txid: 'a1b2c3', amountPico: 5n, confirmations: 10, inPool: false, locked: false },
        { txid: 'a1b2c3', amountPico: 5n, confirmations: 0, inPool: true, locked: false },
    ];
    const r = summarizeTransfers(rows, 10n, 1);  // expects 10; only 5 truly arrived
    check('summarize: duplicate txid (in+pool overlap) counted once',
        r.receivedPico === '5' && r.paid === false && r.txids.length === 1,
        `received=${r.receivedPico} paid=${r.paid} txids=${r.txids.length}`);
})();

// empty/missing txids are NOT real identifiers, so distinct rows that happen to
// carry one must each still count (the `!= null` bug collapsed them into one).
(() => {
    const rows = [
        { txid: '', amountPico: 3n, confirmations: 10, inPool: false, locked: false },
        { txid: '', amountPico: 4n, confirmations: 10, inPool: false, locked: false },
    ];
    const r = summarizeTransfers(rows, 7n, 1);  // both must count → 7, paid
    check('summarize: empty txids are NOT treated as duplicates',
        r.receivedPico === '7' && r.paid === true,
        `received=${r.receivedPico} paid=${r.paid}`);
})();

// ── creditableRows (birthday binding — the false-instant-paid defence) ──
const GRACE = 3;
const heightRow = fc.record({ txid: fc.string({ maxLength: 6 }), height: fc.nat({ max: 5_000_000 }) });
const heightRows = fc.array(heightRow, { maxLength: 12 });
const someHeight = fc.nat({ max: 5_000_000 });

prop('creditable: result is a subset of the input', [heightRows, fc.option(someHeight, { nil: null })],
    (rs, h) => creditableRows(rs, h).every(r => rs.includes(r)));

prop('creditable: minHeight null → identity (everything kept)', [heightRows],
    rs => creditableRows(rs, null) === rs);

prop('creditable: every kept row passes (!height || height >= minHeight - grace)', [heightRows, someHeight],
    (rs, h) => creditableRows(rs, h).every(r => !r.height || r.height >= h - GRACE));

prop('creditable: a row at/above minHeight is ALWAYS kept', [heightRows, someHeight],
    (rs, h) => rs.filter(r => r.height >= h).every(r => creditableRows(rs, h).includes(r)));

prop('creditable: a confirmed row below (minHeight - grace) is ALWAYS dropped', [heightRows, someHeight],
    (rs, h) => rs.filter(r => r.height && r.height < h - GRACE).every(r => !creditableRows(rs, h).includes(r)));

prop('creditable: idempotent', [heightRows, someHeight],
    (rs, h) => { const a = creditableRows(rs, h), b = creditableRows(a, h); return a.length === b.length && a.every((r, i) => r === b[i]); });

console.log(`\n${fail === 0 ? 'ALL GREEN' : 'FAILED'}  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
