// src/refund.js — the shared, configurable claim-link expiry semantics (mirrored in PHP by
// XmrPay_Util::claim_expires_at / claim_expired). Pure; time is passed in. The numeric vectors
// at the bottom are the cross-engine conformance anchor.
//   node test/refund.test.js

const {
    DAY_MS, DEFAULT_CLAIM_WINDOW_MS,
    resolveClaimWindow, claimWindowFromDays, claimExpiresAt, isClaimExpired, effectiveClaimStatus,
} = require('../src/refund');

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { (c ? pass++ : fail++); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`); };

// resolveClaimWindow: default / opt-out / normalisation
ok('default window is 7 days', DEFAULT_CLAIM_WINDOW_MS === 7 * DAY_MS);
ok('null -> default', resolveClaimWindow(null) === DEFAULT_CLAIM_WINDOW_MS);
ok('undefined -> default', resolveClaimWindow(undefined) === DEFAULT_CLAIM_WINDOW_MS);
ok('0 -> never (0)', resolveClaimWindow(0) === 0);
ok('negative -> never (0)', resolveClaimWindow(-5) === 0);
ok('NaN -> never (0)', resolveClaimWindow('abc') === 0);
ok('positive floored', resolveClaimWindow(1234.9) === 1234);

// claimWindowFromDays
ok('7 days -> 7*DAY_MS', claimWindowFromDays(7) === 7 * DAY_MS);
ok('0 days -> never', claimWindowFromDays(0) === 0);
ok('fractional days floored', claimWindowFromDays(2.9) === 2 * DAY_MS);

// claimExpiresAt
ok('expiry = opened + window', claimExpiresAt(1000, 5000) === 6000);
ok('never window -> 0', claimExpiresAt(1000, 0) === 0);
ok('default window applied when omitted', claimExpiresAt(1000, null) === 1000 + DEFAULT_CLAIM_WINDOW_MS);

// isClaimExpired — only a `requested` claim can expire
const opened = 1_000_000;
const win = 7 * DAY_MS;
const exp = opened + win;
ok('requested, before expiry -> alive', isClaimExpired('requested', opened, win, exp - 1) === false);
ok('requested, exactly at expiry -> expired', isClaimExpired('requested', opened, win, exp) === true);
ok('requested, after expiry -> expired', isClaimExpired('requested', opened, win, exp + 1) === true);
ok('never window never expires', isClaimExpired('requested', opened, 0, exp + 1e12) === false);
ok('address_provided never expires', isClaimExpired('address_provided', opened, win, exp + 1e9) === false);
ok('sent never expires', isClaimExpired('sent', opened, win, exp + 1e9) === false);

// effectiveClaimStatus — the overlay a UI acts on
ok('alive requested stays requested', effectiveClaimStatus('requested', opened, win, exp - 1) === 'requested');
ok('dead requested -> expired', effectiveClaimStatus('requested', opened, win, exp + 1) === 'expired');
ok('address_provided unchanged past window', effectiveClaimStatus('address_provided', opened, win, exp + 1) === 'address_provided');

// ---- CONFORMANCE VECTORS (mirrored byte-for-byte in tests/refund.test.php; units are arbitrary
// integers so JS-ms and PHP-seconds share one formula: expiresAt = opened + window) ----
const VECTORS = [
    // [status, opened, window, now, expectedExpiresAt, expectedExpired]
    ['requested', 100, 50, 149, 150, false],
    ['requested', 100, 50, 150, 150, true],
    ['requested', 100, 50, 151, 150, true],
    ['requested', 100, 0, 999999, 0, false],   // never
    ['address_provided', 100, 50, 9999, 150, false],
    ['sent', 100, 50, 9999, 150, false],
];
for (const [st, op, w, now, eExp, eDead] of VECTORS) {
    ok(`vector ${st} opened=${op} win=${w} now=${now} -> expiresAt`, claimExpiresAt(op, w) === eExp, String(claimExpiresAt(op, w)));
    ok(`vector ${st} opened=${op} win=${w} now=${now} -> expired=${eDead}`, isClaimExpired(st, op, w, now) === eDead);
}

console.log(`\n${fail ? 'FAILED' : 'ALL GREEN'}  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
