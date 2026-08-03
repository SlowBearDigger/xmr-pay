'use strict';

function positiveHeight(value) {
    const height = Number(value);
    return Number.isFinite(height) && height > 0 ? height : null;
}

function createProbe(readHeight, cacheMs, now) {
    let lastHeight = null;
    let lastUpdatedAt = null;
    let inflight = null;

    async function read() {
        const readAt = now();
        if (lastHeight != null && lastUpdatedAt != null && readAt - lastUpdatedAt < cacheMs) {
            return { available: true, height: lastHeight };
        }
        if (inflight) return inflight;

        inflight = (async () => {
            try {
                const height = positiveHeight(await readHeight());
                if (height == null) return { available: false, height: null };
                lastHeight = height;
                lastUpdatedAt = now();
                return { available: true, height };
            } catch {
                return { available: false, height: null };
            } finally {
                inflight = null;
            }
        })();
        return inflight;
    }

    return {
        read,
        last: () => ({ height: lastHeight, updatedAt: lastUpdatedAt }),
    };
}

function createAgentHealthMonitor({
    readDaemonHeight,
    readWalletHeight,
    daemonCacheMs = 5_000,
    walletCacheMs = 3_000,
    syncGap = 2,
    now = Date.now,
} = {}) {
    if (typeof readDaemonHeight !== 'function') throw new TypeError('readDaemonHeight is required');
    if (typeof readWalletHeight !== 'function') throw new TypeError('readWalletHeight is required');

    const daemon = createProbe(readDaemonHeight, Math.max(0, daemonCacheMs), now);
    const wallet = createProbe(readWalletHeight, Math.max(0, walletCacheMs), now);

    async function snapshot() {
        const [daemonCurrent, walletCurrent] = await Promise.all([daemon.read(), wallet.read()]);
        const daemonLast = daemon.last();
        const walletLast = wallet.last();
        const synced = daemonCurrent.available && walletCurrent.available
            ? Math.abs(daemonCurrent.height - walletCurrent.height) <= syncGap
            : null;
        const state = !daemonCurrent.available ? 'node-unavailable'
            : !walletCurrent.available ? 'wallet-unavailable'
                : synced ? 'ready' : 'syncing';

        return {
            state,
            synced,
            nodeReachable: daemonCurrent.available,
            walletReadable: walletCurrent.available,
            daemonHeight: daemonCurrent.height,
            walletHeight: walletCurrent.height,
            lastDaemonHeight: daemonLast.height,
            lastWalletHeight: walletLast.height,
            daemonHeightUpdatedAt: daemonLast.updatedAt,
            walletHeightUpdatedAt: walletLast.updatedAt,
        };
    }

    return { snapshot };
}

module.exports = { createAgentHealthMonitor };
