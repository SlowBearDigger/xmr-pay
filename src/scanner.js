// view-only payment SCANNER — the sovereign, zero-daemon counterpart to the
// wallet-rpc watcher. it builds a monero-ts (WASM) view-only wallet from
// (primary address + private view key) ONLY — no spend key, cannot spend — and
// scans the chain for payments to per-order subaddresses, SUMMING them (shared
// summarizeTransfers) so a buyer who pays in installments or tops up an
// underpayment completes the order. the merchant's view key never leaves their
// own process; no monero-wallet-rpc to run. monero-ts is an optional peer dep.
//
//   const s = await createScanner({ primaryAddress, privateViewKey, networkType: 'stagenet', nodes: [...], restoreHeight });
//   const { address, index } = await s.newSubaddress('order ord_1');   // hand this to the buyer
//   const r = await s.checkOrder({ subaddressIndex: index, amount: '0.1' });
//   // r = { paid, status, receivedXmr, pendingXmr, requiredXmr, shortfallXmr, confirmations, txids }
//   await s.close();

const { xmrToPico } = require('./verify');
const { summarizeTransfers } = require('./watch');
const { normalizeNodes, publicNodes } = require('./nodes');
const { requestNode, createNodeBridge } = require('./node-transport');
const { creditableRows, read: call, toRow } = require('./scanner-common');

let monerojs = null;
function lazyMonero() { if (!monerojs) monerojs = require('monero-ts'); return monerojs; }

// Read the current chain tip before creating a fresh wallet. requestNode()
// supports unauthenticated, Basic, and Digest nodes without following redirects.
async function fetchDaemonHeight(nodes) {
    for (const node of nodes) {
        try {
            const response = await requestNode(node, { path: '/get_height', timeoutMs: 8000, maxResponseBytes: 1024 * 1024 });
            const j = response.json;
            const h = Number(j && j.height);
            if (Number.isFinite(h) && h > 0) return h;
        } catch { /* next node */ }
    }
    return null;
}

async function createScanner({ primaryAddress, privateViewKey, networkType = 'mainnet', nodes = [], restoreHeight, path, password = '', accountIndex = 0, syncTimeoutMs = 120000, monero } = {}) {
    if (!primaryAddress || !privateViewKey) throw new Error('primaryAddress and privateViewKey are required (view-only)');
    const normalizedNodes = normalizeNodes(nodes);
    const m = monero || lazyMonero();

    // `fs` is required lazily and ONLY when a wallet `path` is given — deliberate,
    // not a style slip: an in-memory scanner (no path, e.g. a browser/edge Modo A
    // bundle) must not pull `fs` into its dependency graph at all.
    const opening = !!(path && require('fs').existsSync(path + '.keys'));

    // a FRESH scanner starts at the chain tip unless an explicit restoreHeight is
    // given — a payment processor never needs history, so the first sync is instant
    // and it only ever scans FORWARD. an order's "birthday" (the tip when it was
    // created) is the tight window for any later re-scan.
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

    // wallet2 does not reliably negotiate arbitrary reverse-proxy Basic/Digest
    // challenges. Protected nodes therefore get an ephemeral loopback bridge;
    // credentials remain in this process and wallet2 sees a plain local daemon.
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
        try { await wallet.close(false); } catch { /* ignore */ }
        await Promise.allSettled(bridges.map(bridge => bridge.close()));
        throw error;
    }

    // connect to the first reachable node
    let connected = null, nodeIdx = -1;
    for (let i = 0; i < normalizedNodes.length; i++) {
        try { await wallet.setDaemonConnection(walletConnections[i]); if (await wallet.isConnectedToDaemon()) { connected = normalizedNodes[i]; nodeIdx = i; break; } } catch { /* next */ }
    }
    if (!connected) {
        try { await wallet.close(false); } catch { /* ignore */ }
        await Promise.allSettled(bridges.map(bridge => bridge.close()));
        throw new Error('no node reachable: ' + JSON.stringify(publicNodes(normalizedNodes)));
    }

    // rotate to the NEXT reachable node — used when the current one degrades mid-run
    // (monero-ts holds ONE daemon connection; without this a single failing node
    // silently stalls the agent until restart). returns the new node, or null.
    async function rotateNode() {
        for (let k = 1; k <= normalizedNodes.length; k++) {
            const i = (nodeIdx + k) % normalizedNodes.length;
            try { await wallet.setDaemonConnection(walletConnections[i]); if (await wallet.isConnectedToDaemon()) { connected = normalizedNodes[i]; nodeIdx = i; return normalizedNodes[i]; } } catch { /* next */ }
        }
        return null;
    }

    // opened an existing wallet → its current height IS the birthday/start
    if (birthday == null) { try { birthday = Number(await wallet.getHeight()); } catch { birthday = 0; } }

    // a view-only wallet must NOT hold a usable spend key — verify, loudly
    let viewOnly = true;
    try { const sk = await wallet.getPrivateSpendKey(); viewOnly = !sk || /^0+$/.test(sk); } catch { viewOnly = true; }

    // time-bound the sync: monero-ts wallet.sync() has no timeout, so a half-open
    // node (accepts the socket, never answers) would hang the poll tick FOREVER —
    // the tick's try/catch only fires on a THROW, not a hang. on timeout/error,
    // fail over to the next node and retry once before giving up to the caller.
    const startH = () => (birthday != null ? birthday : undefined);
    async function syncOnce() {
        let to; const timer = new Promise((_, rej) => { to = setTimeout(() => rej(new Error(`wallet sync timed out after ${syncTimeoutMs}ms`)), syncTimeoutMs); if (to.unref) to.unref(); });
        try { await Promise.race([wallet.sync(startH()), timer]); } finally { clearTimeout(to); }
    }
    async function doSync() {
        try { await syncOnce(); }
        catch (e) {
            if (normalizedNodes.length > 1 && await rotateNode()) { await syncOnce(); return; }   // failover + one retry
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
            // the tip at creation = this order's birthday: the only blocks that can
            // ever contain its payment start here, so a per-order re-scan is tiny.
            let atHeight = null;
            try { atHeight = Number(await wallet.getDaemonHeight()); } catch { /* offline */ }
            return { address: call(sub, 'getAddress', 'address'), index: Number(call(sub, 'getIndex', 'index')), atHeight };
        },
        async addressAt(index) { return await wallet.getAddress(accountIndex, index); },
        async checkOrder({ subaddressIndex, amount, minConfirmations = 1, minHeight = null, sync = true, toleranceXmr = '0' }) {
            if (sync) await doSync();
            // materialize the index so a fresh order's subaddress is actually scanned
            try { await wallet.getAddress(accountIndex, subaddressIndex); } catch { /* lookahead covers it */ }
            const transfers = await wallet.getTransfers({ accountIndex, subaddressIndex, isIncoming: true });
            // only credit payments that arrived at/after the order's birthday
            const rows = creditableRows(transfers.map(toRow), minHeight);
            return summarizeTransfers(rows, xmrToPico(amount), minConfirmations, xmrToPico(toleranceXmr || '0'));
        },
        // BATCH check: ONE account-wide getTransfers, distributed across many orders
        // by subaddress index — O(1) wallet queries per tick instead of O(orders)
        // (one getTransfers PER order). this is the scale path: 1000 pending orders
        // = 1 query/tick, not 1000. mirrors MoneroPay's single-query-then-distribute.
        // `list`: [{ id, index, amount, birthdayHeight }]. returns Map(id → result).
        async checkOrders(list, { minConfirmations = 1, toleranceXmr = '0', sync = true } = {}) {
            if (sync) await doSync();
            const out = new Map();
            if (!Array.isArray(list) || list.length === 0) return out;
            // bound the query to the OLDEST pending order's birthday — a long-running
            // wallet accumulates years of transfers, and scanning all of them every
            // tick would creep back toward the cost we just removed. no pending
            // order's payment is below its own birthday, so this can't miss one.
            // (MoneroPay does the same via findMinCreationHeight.) defensive: if this
            // monero-ts build rejects the height-bounded query shape, fall back.
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
                const orderMinConfirmations = Number.isSafeInteger(o.minConfirmations) && o.minConfirmations >= 0 ? o.minConfirmations : minConfirmations;
                out.set(o.id, summarizeTransfers(rows, xmrToPico(o.amount), orderMinConfirmations, tolPico));
            }
            return out;
        },
        // generate an InProof for a received tx. recipient-side, so the view key
        // is enough — it proves to ANYONE that this subaddress received this tx,
        // the trustless on-chain leg of a receipt. callers treat a throw as "no
        // on-chain proof available" and fall back to the merchant signature.
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
        async save() { try { if (path) await wallet.save(); } catch { /* in-memory */ } },
        async close(save = false) {
            if (closed) return;
            closed = true;
            try { await wallet.close(!!save && !!path); } catch { /* ignore */ }
            await Promise.allSettled(bridges.map(bridge => bridge.close()));
        },
    };
}

module.exports = { createScanner, fetchDaemonHeight, toRow, creditableRows };
