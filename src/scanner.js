// Scan incoming Monero payments with a view-only wallet.
const { xmrToPico } = require('./verify');
const { summarizeTransfers } = require('./watch');
const { normalizeNodes, publicNodes } = require('./nodes');
const { requestNode, createNodeBridge } = require('./node-transport');

let monerojs = null;
function lazyMonero() { if (!monerojs) monerojs = require('monero-ts'); return monerojs; }

async function fetchDaemonHeight(nodes) {
    for (const node of nodes) {
        try {
            const response = await requestNode(node, { path: '/get_height', timeoutMs: 8000, maxResponseBytes: 1024 * 1024 });
            const j = response.json;
            const h = Number(j && j.height);
            if (Number.isFinite(h) && h > 0) return h;
        } catch {   }
    }
    return null;
}

const big = (v) => BigInt((v == null ? 0 : (v.toString ? v.toString() : v)));
const call = (o, m, p) => (o && typeof o[m] === 'function') ? o[m]() : (o ? o[p] : undefined);

function toRow(t) {
    const tx = (typeof t.getTx === 'function') ? t.getTx() : (t.tx || {});
    const confirmations = Number(call(tx, 'getNumConfirmations', 'numConfirmations') ?? 0) || 0;
    const isConfirmed = !!call(tx, 'getIsConfirmed', 'isConfirmed');
    const inPool = !isConfirmed || !!call(tx, 'getInTxPool', 'inTxPool');

    let unlockTime = 0n;
    const u = call(tx, 'getUnlockTime', 'unlockTime');
    if (u != null) {
        if (!/^\d+$/.test(String(u))) throw new Error('invalid transaction unlock time');
        unlockTime = BigInt(String(u));
    }
    const txid = call(tx, 'getHash', 'hash') || call(t, 'getTxHash', 'txHash') || null;
    const amountPico = big(call(t, 'getAmount', 'amount') ?? 0n);

    const doubleSpendSeen = !!call(tx, 'getIsDoubleSpendSeen', 'isDoubleSpendSeen');

    const height = Number(call(tx, 'getHeight', 'height') ?? 0) || 0;

    let locked = false;
    if (unlockTime > 0n) {
        if (unlockTime < 500000000n) {
            const currentHeight = BigInt(height > 0 ? height + confirmations - 1 : 0);
            locked = currentHeight < unlockTime;
        } else {
            locked = BigInt(Math.floor(Date.now() / 1000)) < unlockTime;
        }
    }

    const si = Number(call(t, 'getSubaddressIndex', 'subaddressIndex'));
    const subaddressIndex = Number.isFinite(si) ? si : null;
    return { txid, amountPico, confirmations, inPool, locked, height, doubleSpendSeen, subaddressIndex };
}

const BIRTHDAY_GRACE = 3;
function creditableRows(rows, minHeight, grace = BIRTHDAY_GRACE) {
    if (minHeight == null) return rows;
    const floor = minHeight - grace;
    return rows.filter(r => !r.height || r.height >= floor);
}

async function createScanner({ primaryAddress, privateViewKey, networkType = 'mainnet', nodes = [], restoreHeight, path, password = '', accountIndex = 0, syncTimeoutMs = 120000, monero } = {}) {
    if (!primaryAddress || !privateViewKey) throw new Error('primaryAddress and privateViewKey are required (view-only)');
    const normalizedNodes = normalizeNodes(nodes);
    const m = monero || lazyMonero();

    const opening = !!(path && require('fs').existsSync(path + '.keys'));

    let birthday = restoreHeight;
    if (!opening && birthday == null) {
        birthday = await fetchDaemonHeight(normalizedNodes);
        if (birthday == null) throw new Error('could not read the chain tip to start at "now" — pass restoreHeight, or check your nodes');
    }

    let wallet;
    if (opening) {
        wallet = await m.openWalletFull({ path, password, networkType });
    } else {
        const opts = { networkType, primaryAddress, privateViewKey, restoreHeight: birthday };
        if (path) { opts.path = path; opts.password = password; }
        wallet = await m.createWalletFull(opts);
    }

    const bridges = [];
    const walletConnections = [];
    try {
        for (const node of normalizedNodes) {
            if (node.auth === 'none') {
                walletConnections.push(node.url);
                continue;
            }
            const bridge = await createNodeBridge(node, { timeoutMs: syncTimeoutMs });
            bridges.push(bridge);
            walletConnections.push(bridge.url);
        }
    } catch (error) {
        try { await wallet.close(false); } catch {   }
        await Promise.allSettled(bridges.map(bridge => bridge.close()));
        throw error;
    }

    let connected = null, nodeIdx = -1;
    for (let i = 0; i < normalizedNodes.length; i++) {
        try { await wallet.setDaemonConnection(walletConnections[i]); if (await wallet.isConnectedToDaemon()) { connected = normalizedNodes[i]; nodeIdx = i; break; } } catch {   }
    }
    if (!connected) {
        try { await wallet.close(false); } catch {   }
        await Promise.allSettled(bridges.map(bridge => bridge.close()));
        throw new Error('no node reachable: ' + JSON.stringify(publicNodes(normalizedNodes)));
    }

    async function rotateNode() {
        for (let k = 1; k <= normalizedNodes.length; k++) {
            const i = (nodeIdx + k) % normalizedNodes.length;
            try { await wallet.setDaemonConnection(walletConnections[i]); if (await wallet.isConnectedToDaemon()) { connected = normalizedNodes[i]; nodeIdx = i; return normalizedNodes[i]; } } catch {   }
        }
        return null;
    }

    if (birthday == null) { try { birthday = Number(await wallet.getHeight()); } catch { birthday = 0; } }

    let viewOnly = false;
    try { viewOnly = await wallet.isViewOnly() === true; } catch { viewOnly = false; }

    const startH = () => (birthday != null ? birthday : undefined);
    async function syncOnce() {
        let to; const timer = new Promise((_, rej) => { to = setTimeout(() => rej(new Error(`wallet sync timed out after ${syncTimeoutMs}ms`)), syncTimeoutMs); if (to.unref) to.unref(); });
        try { await Promise.race([wallet.sync(startH()), timer]); } finally { clearTimeout(to); }
    }
    async function doSync() {
        try { await syncOnce(); }
        catch (e) {
            if (normalizedNodes.length > 1 && await rotateNode()) { await syncOnce(); return; }
            throw e;
        }
    }

    let closed = false;
    return {
        get node() { return connected.url; },
        get nodes() { return publicNodes(normalizedNodes); },
        viewOnly,
        birthdayHeight: birthday,
        async newSubaddress(label = '') {
            const sub = await wallet.createSubaddress(accountIndex, label);

            let atHeight = null;
            try { atHeight = Number(await wallet.getDaemonHeight()); } catch {   }
            return { address: call(sub, 'getAddress', 'address'), index: Number(call(sub, 'getIndex', 'index')), atHeight };
        },
        async addressAt(index) { return await wallet.getAddress(accountIndex, index); },
        async checkOrder({ subaddressIndex, amount, minConfirmations = 1, minHeight = null, sync = true, toleranceXmr = '0' }) {
            if (sync) await doSync();

            try { await wallet.getAddress(accountIndex, subaddressIndex); } catch {   }
            const transfers = await wallet.getTransfers({ accountIndex, subaddressIndex, isIncoming: true });

            const rows = creditableRows(transfers.map(toRow), minHeight);
            return summarizeTransfers(rows, xmrToPico(amount), minConfirmations, xmrToPico(toleranceXmr || '0'));
        },

        async checkOrders(list, { minConfirmations = 1, toleranceXmr = '0', sync = true } = {}) {
            if (sync) await doSync();
            const out = new Map();
            if (!Array.isArray(list) || list.length === 0) return out;

            let minHeight = Infinity;
            for (const o of list) { const b = Number(o.birthdayHeight); if (Number.isFinite(b) && b < minHeight) minHeight = b; }
            let transfers;
            try {
                transfers = (Number.isFinite(minHeight) && minHeight > 0)
                    ? await wallet.getTransfers({ accountIndex, isIncoming: true, txQuery: { minHeight } })
                    : await wallet.getTransfers({ accountIndex, isIncoming: true });
            } catch { transfers = await wallet.getTransfers({ accountIndex, isIncoming: true }); }
            const byIndex = new Map();
            for (const t of transfers) {
                const row = toRow(t);
                if (row.subaddressIndex == null) continue;
                let arr = byIndex.get(row.subaddressIndex);
                if (!arr) { arr = []; byIndex.set(row.subaddressIndex, arr); }
                arr.push(row);
            }
            const tolPico = xmrToPico(toleranceXmr || '0');
            for (const o of list) {
                const rows = creditableRows(byIndex.get(o.index) || [], o.birthdayHeight != null ? o.birthdayHeight : null);
                out.set(o.id, summarizeTransfers(rows, xmrToPico(o.amount), minConfirmations, tolPico));
            }
            return out;
        },

        async txProof(txid, subaddressIndex, message = '') {
            const address = await wallet.getAddress(accountIndex, subaddressIndex);
            const signature = await wallet.getTxProof(String(txid).trim().toLowerCase(), address, message);
            return { txid: String(txid).trim().toLowerCase(), address, message, signature };
        },
        async sync() { await doSync(); },
        async tipHeight() {
            const activeFirst = [connected, ...normalizedNodes.filter(node => node !== connected)];
            return await fetchDaemonHeight(activeFirst);
        },
        async height() { return Number(await wallet.getHeight()); },
        async daemonHeight() { return Number(await wallet.getDaemonHeight()); },
        async save() { if (path) await wallet.save(); },
        async close(save = false) {
            if (closed) return;
            closed = true;
            try { await wallet.close(!!save && !!path); } catch {   }
            await Promise.allSettled(bridges.map(bridge => bridge.close()));
        },
    };
}

module.exports = { createScanner, fetchDaemonHeight, toRow, creditableRows };
