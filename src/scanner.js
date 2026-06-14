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

let monerojs = null;
function lazyMonero() { if (!monerojs) monerojs = require('monero-ts'); return monerojs; }

// read the current chain tip straight from a daemon (plain /get_height RPC, no
// wallet needed). lets a FRESH scanner start at "now" instead of scanning history
// — a payment scanner never needs the past, so this makes the first sync instant.
async function fetchDaemonHeight(nodes) {
    for (const u of nodes) {
        try {
            const r = await fetch(String(u).replace(/\/+$/, '') + '/get_height', { method: 'GET', signal: AbortSignal.timeout(8000) });
            if (!r.ok) continue;
            const j = await r.json();
            const h = Number(j && j.height);
            if (Number.isFinite(h) && h > 0) return h;
        } catch { /* next node */ }
    }
    return null;
}

const big = (v) => BigInt((v == null ? 0 : (v.toString ? v.toString() : v)));
const call = (o, m, p) => (o && typeof o[m] === 'function') ? o[m]() : (o ? o[p] : undefined);

// normalize one monero-ts incoming transfer to the row shape summarizeTransfers
// expects — defensive about the getX()/property naming across versions.
function toRow(t) {
    const tx = (typeof t.getTx === 'function') ? t.getTx() : (t.tx || {});
    const confirmations = Number(call(tx, 'getNumConfirmations', 'numConfirmations') ?? 0) || 0;
    const isConfirmed = !!call(tx, 'getIsConfirmed', 'isConfirmed');
    const inPool = !isConfirmed || !!call(tx, 'getInTxPool', 'inTxPool');
    // "locked" = an EXPLICIT unlock_time (the time-lock scam), NOT the benign
    // ~10-block maturation that getIsLocked() also reports. otherwise the scanner
    // would hold a normal confirmed payment as `locked` for 10 blocks while the
    // wallet-rpc watcher and proof mode (which gate on unlock_time only) already
    // call it paid — a drift between transports. maturation is governed by
    // confirmations + minConfirmations; this gates only the malicious freeze.
    const ut = call(tx, 'getUnlockTime', 'unlockTime');
    const locked = ut != null && String(ut) !== '' && String(ut) !== '0';
    const txid = call(tx, 'getHash', 'hash') || call(t, 'getTxHash', 'txHash') || null;
    const amountPico = big(call(t, 'getAmount', 'amount') ?? 0n);
    return { txid, amountPico, confirmations, inPool, locked };
}

async function createScanner({ primaryAddress, privateViewKey, networkType = 'mainnet', nodes = [], restoreHeight, path, password = '', accountIndex = 0 } = {}) {
    if (!primaryAddress || !privateViewKey) throw new Error('primaryAddress and privateViewKey are required (view-only)');
    if (!Array.isArray(nodes) || nodes.length === 0) throw new Error('at least one node URI is required');
    const m = lazyMonero();

    const opening = !!(path && require('fs').existsSync(path + '.keys'));

    // a FRESH scanner starts at the chain tip unless an explicit restoreHeight is
    // given — a payment processor never needs history, so the first sync is instant
    // and it only ever scans FORWARD. an order's "birthday" (the tip when it was
    // created) is the tight window for any later re-scan.
    let birthday = restoreHeight;
    if (!opening && birthday == null) {
        birthday = await fetchDaemonHeight(nodes);
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

    // connect to the first reachable node
    let connected = null;
    for (const u of nodes) {
        try { await wallet.setDaemonConnection(u); if (await wallet.isConnectedToDaemon()) { connected = u; break; } } catch { /* next */ }
    }
    if (!connected) { try { await wallet.close(false); } catch { /* ignore */ } throw new Error('no node reachable: ' + nodes.join(', ')); }

    // opened an existing wallet → its current height IS the birthday/start
    if (birthday == null) { try { birthday = Number(await wallet.getHeight()); } catch { birthday = 0; } }

    // a view-only wallet must NOT hold a usable spend key — verify, loudly
    let viewOnly = true;
    try { const sk = await wallet.getPrivateSpendKey(); viewOnly = !sk || /^0+$/.test(sk); } catch { viewOnly = true; }

    async function doSync() { await wallet.sync(birthday != null ? birthday : undefined); }

    return {
        node: connected,
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
        async checkOrder({ subaddressIndex, amount, minConfirmations = 1, sync = true }) {
            if (sync) await doSync();
            // materialize the index so a fresh order's subaddress is actually scanned
            try { await wallet.getAddress(accountIndex, subaddressIndex); } catch { /* lookahead covers it */ }
            const transfers = await wallet.getTransfers({ accountIndex, subaddressIndex, isIncoming: true });
            return summarizeTransfers(transfers.map(toRow), xmrToPico(amount), minConfirmations);
        },
        async sync() { await doSync(); },
        async height() { return Number(await wallet.getHeight()); },
        async daemonHeight() { return Number(await wallet.getDaemonHeight()); },
        async save() { try { if (path) await wallet.save(); } catch { /* in-memory */ } },
        async close(save = false) { try { await wallet.close(!!save && !!path); } catch { /* ignore */ } },
    };
}

module.exports = { createScanner, toRow };
