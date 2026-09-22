// Track refund requests without sending funds.
'use strict';

const DAY_MS = 86400000;

const DEFAULT_CLAIM_WINDOW_MS = 7 * DAY_MS;

function resolveClaimWindow(windowMs) {
    if (windowMs == null) return DEFAULT_CLAIM_WINDOW_MS;
    const n = Number(windowMs);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.floor(n);
}

function claimWindowFromDays(days) {
    const d = Number(days);
    if (!Number.isFinite(d) || d <= 0) return 0;
    return Math.floor(d) * DAY_MS;
}

function claimExpiresAt(openedAt, windowMs) {
    const w = resolveClaimWindow(windowMs);
    if (w === 0) return 0;
    return (Number(openedAt) || 0) + w;
}

function isClaimExpired(status, openedAt, windowMs, now) {
    if (status !== 'requested') return false;
    const exp = claimExpiresAt(openedAt, windowMs);
    if (exp === 0) return false;
    return (Number(now) || 0) >= exp;
}

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
