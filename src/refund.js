'use strict';
/*
 * Refund claim-link expiry — the shared, configurable lifecycle semantics for a non-custodial
 * refund claim (the buyer-supplies-an-address flow). Pure, zero-dependency, time passed in as a
 * param so it stays deterministic and testable. The WooCommerce plugin mirrors this in PHP
 * (XmrPay_Util::claim_expires_at / claim_expired) so both engines agree on when a link is dead.
 *
 * A claim is `requested` -> `address_provided` -> `sent`. Expiry only gates the FIRST step: a
 * `requested` claim past its window becomes `expired` (the buyer can no longer submit an address;
 * the merchant reissues to reopen it). Once the address is captured, the link has done its job, so
 * expiry no longer applies. See docs/EVENTS.md for the cross-platform record shape.
 */

const DAY_MS = 86400000;

// the documented default a merchant gets if they configure nothing.
const DEFAULT_CLAIM_WINDOW_MS = 7 * DAY_MS;

/*
 * Normalise a configured window (ms). `null`/`undefined` -> the default; a non-positive or
 * non-finite value -> 0, which means "never expires" (the explicit opt-out). Always an integer.
 */
function resolveClaimWindow(windowMs) {
    if (windowMs == null) return DEFAULT_CLAIM_WINDOW_MS;
    const n = Number(windowMs);
    if (!Number.isFinite(n) || n <= 0) return 0;   // 0 = never expires
    return Math.floor(n);
}

// convenience: a window expressed in days -> ms (for human-facing config like the WP setting).
function claimWindowFromDays(days) {
    const d = Number(days);
    if (!Number.isFinite(d) || d <= 0) return 0;   // 0 days = never expires
    return Math.floor(d) * DAY_MS;
}

/*
 * The absolute expiry timestamp for a claim opened at `openedAt` with `windowMs`. Returns 0 when
 * the window means "never". The plugin SNAPSHOTS this at open time so a later settings change
 * never retroactively kills an already-issued link.
 */
function claimExpiresAt(openedAt, windowMs) {
    const w = resolveClaimWindow(windowMs);
    if (w === 0) return 0;
    return (Number(openedAt) || 0) + w;
}

/*
 * Is this claim's link dead? Only a still-`requested` claim can expire — once `address_provided`
 * (or `sent`), the link already did its job, so it's never "expired". `now` is supplied by the
 * caller (Date.now() in the agent, time()*1000 in any JS caller).
 */
function isClaimExpired(status, openedAt, windowMs, now) {
    if (status !== 'requested') return false;
    const exp = claimExpiresAt(openedAt, windowMs);
    if (exp === 0) return false;   // never expires
    return (Number(now) || 0) >= exp;
}

// the status a UI should act on: the stored status, overlaid with `expired` when the link is dead.
function effectiveClaimStatus(status, openedAt, windowMs, now) {
    return isClaimExpired(status, openedAt, windowMs, now) ? 'expired' : status;
}

module.exports = {
    DAY_MS,
    DEFAULT_CLAIM_WINDOW_MS,
    resolveClaimWindow,
    claimWindowFromDays,
    claimExpiresAt,
    isClaimExpired,
    effectiveClaimStatus,
};
