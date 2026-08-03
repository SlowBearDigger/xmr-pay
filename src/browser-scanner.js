'use strict';

const { isValidAddress, xmrToPico } = require('./verify');
const { summarizeTransfers } = require('./watch');
const { creditableRows, read, toRow } = require('./scanner-common');

let monerojs = null;
function lazyMonero() {
    if (!monerojs) monerojs = require('monero-ts');
    return monerojs;
}

const NETWORK_PREFIXES = {
    '4': 'mainnet',
    '5': 'stagenet',
    '9': 'testnet',
};

const SUBADDRESS_PREFIXES = new Set(['8', '7', 'A', 'B']);

function inferNetworkType(primaryAddress) {
    const address = String(primaryAddress == null ? '' : primaryAddress).trim();
    if (SUBADDRESS_PREFIXES.has(address[0])) throw new Error('a primary standard address is required, not a subaddress');
    const networkType = NETWORK_PREFIXES[address[0]];
    if (!networkType || !isValidAddress(address, networkType)) {
        throw new Error('cannot infer network from the primary address');
    }
    return networkType;
}

function normalizeNetworkType(value, inferred) {
    if (value == null || String(value).trim() === '') return inferred;
    const networkType = String(value).trim().toLowerCase();
    if (!['mainnet', 'stagenet', 'testnet'].includes(networkType)) {
        throw new Error('networkType must be mainnet, stagenet, or testnet');
    }
    if (networkType !== inferred) throw new Error('networkType does not match the primary address');
    return networkType;
}

function normalizeBrowserNode(value) {
    const row = typeof value === 'string' ? { url: value } : value;
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('a node URL is required');

    const auth = String(row.auth == null ? 'none' : row.auth).trim().toLowerCase();
    if (auth !== 'none' || row.username || row.password) {
        throw new Error('node authentication is not supported in browser view mode');
    }

    const raw = String(row.url == null ? '' : row.url).trim();
    if (!raw || /[\s\\]/.test(raw)) throw new Error('invalid node URL');
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) throw new Error('invalid node URL');
    let parsed;
    try { parsed = new URL(raw); }
    catch { throw new Error('invalid node URL'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('browser nodes must use HTTP or HTTPS');
    if (parsed.username || parsed.password || raw.slice(parsed.protocol.length + 2).split('/', 1)[0].includes('@')) {
        throw new Error('node URL must not contain credentials');
    }
    if (!parsed.hostname) throw new Error('invalid node URL');
    if (parsed.search || parsed.hash || raw.includes('?') || raw.includes('#')) {
        throw new Error('node URL must not contain a query or fragment');
    }
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    return { url: parsed.toString().replace(/\/$/, '') };
}

function joinNodePath(nodeUrl, suffix) {
    return nodeUrl.replace(/\/+$/, '') + '/' + String(suffix).replace(/^\/+/, '');
}

async function fetchBrowserDaemonHeight(nodeUrl, fetchImpl, timeoutMs = 10000) {
    if (typeof fetchImpl !== 'function') throw new Error('browser fetch is unavailable');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(1, Number(timeoutMs) || 1));
    try {
        const response = await fetchImpl(joinNodePath(nodeUrl, '/get_height'), {
            method: 'GET',
            credentials: 'omit',
            redirect: 'error',
            cache: 'no-store',
            headers: { Accept: 'application/json' },
            signal: controller.signal,
        });
        if (!response || !response.ok || response.redirected) {
            throw new Error(`node height request failed${response ? ` with HTTP ${response.status}` : ''}`);
        }
        const payload = await response.json();
        const height = Number(payload && payload.height);
        if (!Number.isSafeInteger(height) || height <= 0) throw new Error('node returned an invalid chain height');
        return height;
    } catch (error) {
        if (error && error.name === 'AbortError') throw new Error('node height request timed out');
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

function validIndex(value, name = 'subaddressIndex') {
    const index = Number(value);
    if (!Number.isSafeInteger(index) || index < 0) throw new Error(`${name} must be a non-negative integer`);
    return index;
}

async function createBrowserScanner({
    primaryAddress,
    privateViewKey,
    node,
    nodeUrl,
    networkType,
    restoreHeight,
    accountIndex = 0,
    syncTimeoutMs = 120000,
    monero,
    fetchImpl = globalThis.fetch,
} = {}) {
    const address = String(primaryAddress == null ? '' : primaryAddress).trim();
    const viewKey = String(privateViewKey == null ? '' : privateViewKey).trim();
    if (!/^[0-9a-f]{64}$/i.test(viewKey) || /^0+$/.test(viewKey)) {
        throw new Error('private view key must be a non-zero 64-character hexadecimal value');
    }
    const inferredNetwork = inferNetworkType(address);
    const selectedNetwork = normalizeNetworkType(networkType, inferredNetwork);
    if (node != null && nodeUrl != null && String(node).trim() !== String(nodeUrl).trim()) {
        throw new Error('provide only one node URL');
    }
    const normalizedNode = normalizeBrowserNode(node != null ? node : nodeUrl);
    const account = validIndex(accountIndex, 'accountIndex');

    let birthdayHeight;
    if (restoreHeight == null) {
        birthdayHeight = await fetchBrowserDaemonHeight(normalizedNode.url, fetchImpl);
    } else {
        birthdayHeight = Number(restoreHeight);
        if (!Number.isSafeInteger(birthdayHeight) || birthdayHeight < 0) {
            throw new Error('restoreHeight must be a non-negative integer');
        }
    }

    const implementation = monero || lazyMonero();
    let wallet;
    try {
        wallet = await implementation.createWalletFull({
            networkType: selectedNetwork,
            primaryAddress: address,
            privateViewKey: viewKey,
            restoreHeight: birthdayHeight,
        });
        await wallet.setDaemonConnection(normalizedNode.url);
        if (!await wallet.isConnectedToDaemon()) throw new Error('node is not reachable from this browser');

        let viewOnly;
        if (typeof wallet.isViewOnly === 'function') {
            viewOnly = !!await wallet.isViewOnly();
        } else if (typeof wallet.getPrivateSpendKey === 'function') {
            const spendKey = await wallet.getPrivateSpendKey();
            viewOnly = !spendKey || /^0+$/.test(String(spendKey));
        } else {
            throw new Error('cannot confirm that the wallet is view-only');
        }
        if (!viewOnly) throw new Error('wallet is not view-only');
    } catch (error) {
        if (wallet && typeof wallet.close === 'function') {
            try { await wallet.close(false); } catch { }
        }
        throw error;
    }

    let closed = false;
    function ensureOpen() {
        if (closed) throw new Error('scanner is closed');
    }
    async function syncOnce() {
        ensureOpen();
        let timer;
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`wallet sync timed out after ${syncTimeoutMs}ms`)), Math.max(1, Number(syncTimeoutMs) || 1));
        });
        try { await Promise.race([wallet.sync(birthdayHeight), timeout]); }
        finally { clearTimeout(timer); }
    }

    async function tip() {
        ensureOpen();
        return fetchBrowserDaemonHeight(normalizedNode.url, fetchImpl, Math.min(10000, syncTimeoutMs));
    }

    return {
        node: normalizedNode.url,
        networkType: selectedNetwork,
        viewOnly: true,
        birthdayHeight,
        async newSubaddress(label = '') {
            ensureOpen();
            const subaddress = await wallet.createSubaddress(account, String(label));
            let atHeight;
            try { atHeight = Number(await wallet.getDaemonHeight()); }
            catch { atHeight = await tip(); }
            if (!Number.isSafeInteger(atHeight) || atHeight <= 0) throw new Error('could not determine the order birthday height');
            return {
                address: read(subaddress, 'getAddress', 'address'),
                index: validIndex(read(subaddress, 'getIndex', 'index')),
                atHeight,
            };
        },
        async addressAt(index) {
            ensureOpen();
            return wallet.getAddress(account, validIndex(index));
        },
        async sync() { await syncOnce(); },
        async checkOrder({ subaddressIndex, amount, minConfirmations = 1, minHeight = null, sync = true, toleranceXmr = '0' } = {}) {
            ensureOpen();
            const index = validIndex(subaddressIndex);
            if (sync) await syncOnce();
            await wallet.getAddress(account, index);
            const transfers = await wallet.getTransfers({ accountIndex: account, subaddressIndex: index, isIncoming: true });
            const rows = creditableRows(transfers.map(toRow), minHeight);
            return summarizeTransfers(rows, xmrToPico(amount), minConfirmations, xmrToPico(toleranceXmr || '0'));
        },
        async checkOrders(list, { minConfirmations = 1, toleranceXmr = '0', sync = true } = {}) {
            ensureOpen();
            const output = new Map();
            if (!Array.isArray(list)) throw new Error('orders must be an array');
            if (list.length === 0) return output;
            if (sync) await syncOnce();

            let oldestHeight = Infinity;
            for (const order of list) {
                validIndex(order && order.index, 'order index');
                const height = Number(order && order.birthdayHeight);
                if (Number.isSafeInteger(height) && height >= 0 && height < oldestHeight) oldestHeight = height;
            }
            let transfers;
            try {
                transfers = Number.isFinite(oldestHeight) && oldestHeight > 0
                    ? await wallet.getTransfers({ accountIndex: account, isIncoming: true, txQuery: { minHeight: oldestHeight } })
                    : await wallet.getTransfers({ accountIndex: account, isIncoming: true });
            } catch {
                transfers = await wallet.getTransfers({ accountIndex: account, isIncoming: true });
            }

            const rowsByIndex = new Map();
            for (const transfer of transfers) {
                const row = toRow(transfer);
                if (row.subaddressIndex == null) continue;
                const rows = rowsByIndex.get(row.subaddressIndex) || [];
                rows.push(row);
                rowsByIndex.set(row.subaddressIndex, rows);
            }
            const tolerancePico = xmrToPico(toleranceXmr || '0');
            for (const order of list) {
                const index = validIndex(order.index, 'order index');
                const rows = creditableRows(rowsByIndex.get(index) || [], order.birthdayHeight == null ? null : Number(order.birthdayHeight));
                const confirmations = Number.isSafeInteger(order.minConfirmations) && order.minConfirmations >= 0
                    ? order.minConfirmations
                    : minConfirmations;
                output.set(order.id, summarizeTransfers(rows, xmrToPico(order.amount), confirmations, tolerancePico));
            }
            return output;
        },
        async height() { ensureOpen(); return Number(await wallet.getHeight()); },
        tip,
        tipHeight: tip,
        async close() {
            if (closed) return;
            closed = true;
            await wallet.close(false);
        },
    };
}

module.exports = {
    createBrowserScanner,
    fetchBrowserDaemonHeight,
    inferNetworkType,
    normalizeBrowserNode,
};
