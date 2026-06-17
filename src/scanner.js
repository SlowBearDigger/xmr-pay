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
// trim trailing slashes without a regex (avoids the /\/+$/ polynomial-ReDoS pattern on node URLs)
const rtrimSlash = u => { u = String(u); let e = u.length; while (e > 0 && u.charCodeAt(e - 1) === 47) e--; return u.slice(0, e); };

async function fetchDaemonHeight(nodes) {
    for (const u of nodes) {
        try {
            const r = await fetch(rtrimSlash(u) + '/get_height', { method: 'GET', signal: AbortSignal.timeout(8000) });
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
    // parse unlock_time (consensus time-lock). NOT the benign ~10-block maturation
    // that getIsLocked() folds in — that's handled by confirmations + minConfirmations.
    let unlockTime = 0n;
    try { const u = call(tx, 'getUnlockTime', 'unlockTime'); if (u != null && String(u) !== '') unlockTime = BigInt(String(u)); } catch { unlockTime = 0n; }
    const txid = call(tx, 'getHash', 'hash') || call(t, 'getTxHash', 'txHash') || null;
    const amountPico = big(call(t, 'getAmount', 'amount') ?? 0n);
    // the daemon flags a tx whose inputs it has seen double-spent. while that flag
    // is set the payment is contested — never credit it (a reorg could replace it).
    // monerod clears it once the tx is firmly in the chain. (MoneroPay surfaces
    // this field but doesn't gate on it; we gate — strictly safer.)
    const doubleSpendSeen = !!call(tx, 'getIsDoubleSpendSeen', 'isDoubleSpendSeen');
    // the block this transfer landed in (0 / falsy while still in the mempool).
    // used to bind a payment to the order that was live when it arrived.
    const height = Number(call(tx, 'getHeight', 'height') ?? 0) || 0;
    // "locked" = the unlock_time has NOT yet elapsed (a future time-lock — the
    // scam vector, funds not spendable). an ALREADY-elapsed unlock_time means the
    // funds are spendable now → NOT locked (rejecting those, as we used to, threw
    // away legit payments). Monero encodes unlock_time as a block height when
    // < 500000000, else a unix timestamp. (MoneroPay/BTCPay only handle the
    // block-height form; we handle both.) the ~10-block maturation stays the job
    // of confirmations + minConfirmations, so we under-estimate the tip by 1 (the
    // tx's own block is conf #1) to never unlock a block early.
    let locked = false;
    if (unlockTime > 0n) {
        if (unlockTime < 500000000n) {
            const currentHeight = BigInt(height > 0 ? height + confirmations - 1 : 0);
            locked = currentHeight < unlockTime;
        } else {
            locked = BigInt(Math.floor(Date.now() / 1000)) < unlockTime;
        }
    }
    // the minor subaddress index this transfer landed on — lets ONE account-wide
    // getTransfers be distributed across many orders (the O(1)-per-tick batch path).
    const si = Number(call(t, 'getSubaddressIndex', 'subaddressIndex'));
    const subaddressIndex = Number.isFinite(si) ? si : null;
    return { txid, amountPico, confirmations, inPool, locked, height, doubleSpendSeen, subaddressIndex };
}

// an order can only ever be paid by money that arrives AFTER the order exists.
// drop CONFIRMED transfers below the order's birthday height (minus a small
// reorg/timing grace) so a REUSED or pre-funded subaddress can't settle a new
// order with a stale payment — the false-instant-paid bug. in-pool / unheighted
// rows (height 0) are recent by definition, so they're always kept.
const BIRTHDAY_GRACE = 3;
function creditableRows(rows, minHeight, grace = BIRTHDAY_GRACE) {
    if (minHeight == null) return rows;
    const floor = minHeight - grace;
    return rows.filter(r => !r.height || r.height >= floor);
}

async function createScanner({ primaryAddress, privateViewKey, networkType = 'mainnet', nodes = [], restoreHeight, path, password = '', accountIndex = 0, syncTimeoutMs = 120000 } = {}) {
    if (!primaryAddress || !privateViewKey) throw new Error('primaryAddress and privateViewKey are required (view-only)');
    if (!Array.isArray(nodes) || nodes.length === 0) throw new Error('at least one node URI is required');
    const m = lazyMonero();

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
    let connected = null, nodeIdx = -1;
    for (let i = 0; i < nodes.length; i++) {
        try { await wallet.setDaemonConnection(nodes[i]); if (await wallet.isConnectedToDaemon()) { connected = nodes[i]; nodeIdx = i; break; } } catch { /* next */ }
    }
    if (!connected) { try { await wallet.close(false); } catch { /* ignore */ } throw new Error('no node reachable: ' + nodes.join(', ')); }

    // rotate to the NEXT reachable node — used when the current one degrades mid-run
    // (monero-ts holds ONE daemon connection; without this a single failing node
    // silently stalls the agent until restart). returns the new node, or null.
    async function rotateNode() {
        for (let k = 1; k <= nodes.length; k++) {
            const i = (nodeIdx + k) % nodes.length;
            try { await wallet.setDaemonConnection(nodes[i]); if (await wallet.isConnectedToDaemon()) { connected = nodes[i]; nodeIdx = i; return nodes[i]; } } catch { /* next */ }
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
            if (nodes.length > 1 && await rotateNode()) { await syncOnce(); return; }   // failover + one retry
            throw e;
        }
    }

    return {
        get node() { return connected; },
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
                out.set(o.id, summarizeTransfers(rows, xmrToPico(o.amount), minConfirmations, tolPico));
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
        async height() { return Number(await wallet.getHeight()); },
        async daemonHeight() { return Number(await wallet.getDaemonHeight()); },
        async save() { try { if (path) await wallet.save(); } catch { /* in-memory */ } },
        async close(save = false) { try { await wallet.close(!!save && !!path); } catch { /* ignore */ } },
    };
}

module.exports = { createScanner, toRow, creditableRows };
