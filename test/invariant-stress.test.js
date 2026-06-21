'use strict';
// high-volume PROPERTY/INVARIANT stress for the canonical invoice state machine (src/state.js)
// AND the refund claim-link expiry (src/refund.js). Seeded-random ops; the invariants below must
// NEVER break. The PHP twin (xmr-pay-woocommerce/tests/invariant-stress.test.php) drives the SAME
// seed, op count and invariants so the two engines stay in lockstep.
//   node test/invariant-stress.test.js
//   OPS=5000000 SEED=0xC0FFEE node test/invariant-stress.test.js   (override volume/seed for a soak)

const {
    STATES, TERMINAL, toInvoiceState, canTransition, nextEvents,
} = require('../src/state');
const {
    DEFAULT_CLAIM_WINDOW_MS, resolveClaimWindow, claimExpiresAt, isClaimExpired,
} = require('../src/refund');

let pass = 0, fail = 0, firstFail = null;
function inv(name, cond, ctx) {
    if (cond) { pass++; return true; }
    fail++;
    if (!firstFail) firstFail = name + (ctx ? '  — ' + ctx : '');
    return false;
}

// ── seeded PRNG: mulberry32. identical algorithm in the PHP twin so a failing op # reproduces. ──
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const SEED = process.env.SEED ? (Number(process.env.SEED) >>> 0) : 0x9E3779B9;
const OPS = process.env.OPS ? Number(process.env.OPS) : 300000;   // suite-fast default; crank via OPS=
const rnd = mulberry32(SEED);
const pick = arr => arr[Math.floor(rnd() * arr.length)];
const randInt = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

const STATUSES = ['pending', 'mempool', 'unconfirmed', 'partial', 'underpaid', 'locked', 'paid', 'expired', 'invalid'];
const NON_TRANSITION = ['node-error', 'node-disagreement', 'replay', 'no-funds', 'bogus', ''];
const NEXT_CANDIDATES = STATES.concat(['whatever', 'CREATED', 'done', '']); // include illegal targets
const CLAIM_STATUSES = ['requested', 'address_provided', 'sent', 'expired', 'unknown', ''];

console.log(`invoice + claim invariant stress — seed=0x${SEED.toString(16)} ops=${OPS}`);

// =============================== STATE MACHINE ===============================
for (let i = 0; i < OPS; i++) {
    const prev = rnd() < 0.12 ? null : pick(STATES);
    const next = pick(NEXT_CANDIDATES);
    const legal = canTransition(prev, next);

    // I1: born `created` — from null the ONLY legal next is `created`.
    if (prev === null) {
        if (!inv('born-created', legal === (next === 'created'), `op#${i} null->${next} legal=${legal}`)) break;
    }
    // I2: `settled` LATCHES.
    if (prev === 'settled') {
        if (!inv('settled-terminal', legal === (next === 'settled'), `op#${i} settled->${next} legal=${legal}`)) break;
    }
    // I3: `expired` is FINAL.
    if (prev === 'expired') {
        if (!inv('expired-terminal', legal === (next === 'expired'), `op#${i} expired->${next} legal=${legal}`)) break;
    }
    // I4: TERMINAL never moves to a DIFFERENT state.
    if (prev !== null && TERMINAL.has(prev) && next !== prev) {
        if (!inv('terminal-never-moves', !legal, `op#${i} ${prev}->${next} legal=${legal}`)) break;
    }
    // I5: a non-canonical target is never legal.
    if (!STATES.includes(next)) {
        if (!inv('illegal-target-rejected', !legal, `op#${i} ${prev}->${next} legal=${legal}`)) break;
    }
    // I6: self-transition is always legal for a live state.
    if (prev !== null) {
        if (!inv('self-transition-legal', canTransition(prev, prev), `op#${i} ${prev}->${prev}`)) break;
    }
    // I7: a legal move never decreases lifecycle rank.
    const RANK = { created: 0, processing: 1, invalid: 1, settled: 2, expired: 2 };
    if (prev !== null && legal && next !== prev) {
        if (!inv('monotone-rank', RANK[next] >= RANK[prev], `op#${i} ${prev}(${RANK[prev]})->${next}(${RANK[next]})`)) break;
    }

    // ── events on a status-driven step ──
    const status = rnd() < 0.8 ? pick(STATUSES) : pick(NON_TRANSITION);
    const mapped = toInvoiceState(status);

    // I8: status maps to a canonical state or null (verify-only) — never junk.
    if (!inv('status-codomain', mapped === null || STATES.includes(mapped), `op#${i} status=${status} -> ${mapped}`)) break;
    // I9: verify-only statuses are NOT transitions (null).
    if (NON_TRANSITION.includes(status)) {
        if (!inv('verify-only-null', mapped === null, `op#${i} status=${status} -> ${mapped}`)) break;
    }

    if (mapped !== null) {
        const fundsUp = rnd() < 0.5;
        const events = nextEvents(prev, mapped, { receivedIncreased: fundsUp });

        // I10: a state CHANGE fires exactly one invoice.<next>; no change fires none.
        const invoiceEvents = events.filter(e => e.indexOf('invoice.') === 0);
        const changed = prev !== mapped;
        if (!inv('one-invoice-event-per-change',
            (changed && invoiceEvents.length === 1 && invoiceEvents[0] === 'invoice.' + mapped) ||
            (!changed && invoiceEvents.length === 0),
            `op#${i} ${prev}->${mapped} events=${JSON.stringify(events)}`)) break;

        // I11: payment.received fires ONLY when funds increased AND the step is non-final.
        const hasPR = events.indexOf('payment.received') !== -1;
        const finalish = (mapped === 'settled' || mapped === 'expired' || mapped === 'invalid');
        if (!inv('payment.received-rule', hasPR === (fundsUp && !finalish),
            `op#${i} ${prev}->${mapped} fundsUp=${fundsUp} events=${JSON.stringify(events)}`)) break;

        // I12: every emitted event is from the known taxonomy.
        const known = e => e === 'payment.received' || (e.indexOf('invoice.') === 0 && STATES.includes(e.slice(8)));
        if (!inv('events-known-taxonomy', events.every(known), `op#${i} events=${JSON.stringify(events)}`)) break;
    }
}
inv('state-machine: terminal set is exactly {settled,expired}',
    TERMINAL.size === 2 && TERMINAL.has('settled') && TERMINAL.has('expired'));

// =============================== CLAIM-LINK EXPIRY ===============================
const TIME_MAX = 5_000_000_000_000; // ample ms range
for (let i = 0; i < OPS; i++) {
    const status = pick(CLAIM_STATUSES);
    const openedAt = randInt(0, TIME_MAX);
    const windowMs = pick([null, 0, -1, -86400000, randInt(1, 30 * 86400000), randInt(1, 30 * 86400000)]);
    const now = randInt(0, TIME_MAX);

    const w = resolveClaimWindow(windowMs);
    const exp = claimExpiresAt(openedAt, windowMs);

    // C1: resolved window is a non-negative integer; null -> documented default.
    if (!inv('window-nonneg-int', Number.isInteger(w) && w >= 0, `op#${i} win=${windowMs} -> ${w}`)) break;
    if (windowMs == null && !inv('window-null-default', w === DEFAULT_CLAIM_WINDOW_MS, `op#${i} -> ${w}`)) break;

    // C2: window <= 0 means NEVER.
    if (w === 0) {
        if (!inv('never-expires-zero-exp', exp === 0, `op#${i} exp=${exp}`)) break;
        if (!inv('never-expires-status', isClaimExpired(status, openedAt, windowMs, now) === false, `op#${i} status=${status}`)) break;
    } else {
        // C3: expiresAt = opened + window, EXACTLY.
        if (!inv('exp-eq-opened-plus-window', exp === openedAt + w, `op#${i} ${openedAt}+${w} != ${exp}`)) break;
    }

    const expired = isClaimExpired(status, openedAt, windowMs, now);

    // C4: ONLY a `requested` claim can ever be expired.
    if (status !== 'requested') {
        if (!inv('only-requested-expires', expired === false, `op#${i} status=${status} expired=${expired}`)) break;
    } else if (w > 0) {
        // C5: requested with a real window — expired ⟺ now >= expiresAt.
        if (!inv('requested-boundary', expired === (now >= exp), `op#${i} now=${now} exp=${exp} expired=${expired}`)) break;
        // C6: MONOTONE in time.
        const later = now + randInt(0, TIME_MAX);
        if (expired && !inv('monotone-in-time', isClaimExpired(status, openedAt, windowMs, later), `op#${i} now=${now} later=${later}`)) break;
        const earlier = randInt(0, now);
        if (!expired && !inv('monotone-back', isClaimExpired(status, openedAt, windowMs, earlier) === false, `op#${i} now=${now} earlier=${earlier}`)) break;
    }
}

console.log(`\n${fail ? 'FAILED' : 'ALL GREEN'}  ${pass} invariant checks passed, ${fail} failed` +
    (firstFail ? `\n  first failure: ${firstFail}  (re-run with SEED=0x${SEED.toString(16)} OPS=${OPS})` : ''));
process.exit(fail ? 1 : 0);
