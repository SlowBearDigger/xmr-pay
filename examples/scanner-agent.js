// the merchant's PAYMENT AGENT — a long-running view-only scanner + per-order
// manager + signed fulfillment webhooks. the monero-ts WASM cold start is paid
// ONCE at boot; per-order checks are incremental (fast). the merchant's view key
// NEVER leaves this process — run it on YOUR box, bound to localhost or behind
// auth. this is "watch mode" without monero-wallet-rpc.
//
//   XMR_PRIMARY_ADDRESS=4… XMR_VIEW_KEY=<private view key> \
//   XMR_NETWORK=stagenet XMR_NODES=http://node:38089 \
//   node examples/scanner-agent.js
//
// API (bind to localhost; your shop's backend calls it):
//   POST /order   {amount, id?}   → {id, address, amount, status, birthdayHeight}
//   GET  /order/:id               → {paid, status, receivedXmr, shortfallXmr, …}
//   GET  /receipt/:id             → signed receipt envelope (once the order is paid)
//   GET  /healthz                 → {ok, network, node, viewOnly, orders}
//
// needs monero-ts installed (the only non-core dependency, optional peer).

const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const { createScanner } = require('../src/scanner');
const { createPaymentAgent } = require('../src/agent');
const { sendWebhook } = require('../src/webhook');
const { receiptFromOrder, signReceipt } = require('../src/receipt');
const { generateSigningKey, configFingerprint } = require('../src/config');
const { nodesFromEnv } = require('../src/nodes');

const env = process.env;
let NODES;
try { NODES = nodesFromEnv(env); }
catch (error) {
    console.error(`invalid Monero node configuration: ${error && error.code ? error.code : 'invalid-node-list'}`);
    process.exit(1);
}
const PORT = Number(env.PORT || 8788);
const BIND = env.BIND || '127.0.0.1';          // holds the view key → localhost by default
const TOKEN = env.AGENT_TOKEN || '';            // optional bearer auth for POST /order
const intEnv = (k, d) => { const n = Number(env[k]); return Number.isFinite(n) ? n : d; };

// PERSIST the order ledger so a restart never forgets which orders are awaiting
// payment. on boot we reload it and re-check every pending order, so a payment
// that arrived while the agent was down still auto-completes. (a payment is
// never lost regardless — it lands on-chain in YOUR wallet — this is about the
// order auto-completing.) NOTE: pair it with XMR_WALLET_PATH so the wallet keeps
// its scan state too; without it a restarted wallet starts at the tip and can't
// see a payment that arrived during the downtime.
const ORDERS_FILE = env.XMR_ORDERS_FILE || 'orders.json';
function loadOrders() {
    try { return new Map(JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8')).map(o => [o.id, o])); }
    catch { return new Map(); }
}
function saveOrders(store) {
    try { fs.writeFileSync(ORDERS_FILE, JSON.stringify([...store.values()])); }
    catch (e) { console.error(`[orders] save failed: ${e.message}`); }
}
// COALESCED save for routine updates: the poller calls onUpdate once per pending
// order per tick, so writing the whole ledger each time is O(N) blocking writes
// per poll. debounce to at most one write per second. (createOrder / onPaid /
// shutdown still save immediately — those are the transitions worth flushing.)
let _saveDirty = false, _saveTimer = null;
function queueSave(store) {
    _saveDirty = true;
    if (_saveTimer) return;
    _saveTimer = setTimeout(() => { _saveTimer = null; if (_saveDirty) { _saveDirty = false; saveOrders(store); } }, 1000);
    if (_saveTimer.unref) _saveTimer.unref();
}

function send(res, code, body) {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
}

(async () => {
    if (!env.XMR_PRIMARY_ADDRESS || !env.XMR_VIEW_KEY) {
        console.error('set XMR_PRIMARY_ADDRESS and XMR_VIEW_KEY (private view key)');
        process.exit(1);
    }
    console.log('booting scanner (one-time WASM cold start)…');
    const scanner = await createScanner({
        primaryAddress: env.XMR_PRIMARY_ADDRESS,
        privateViewKey: env.XMR_VIEW_KEY,
        networkType: env.XMR_NETWORK || 'mainnet',
        nodes: NODES,
        restoreHeight: env.XMR_RESTORE_HEIGHT != null && env.XMR_RESTORE_HEIGHT !== '' ? Number(env.XMR_RESTORE_HEIGHT) : undefined,
        path: env.XMR_WALLET_PATH || undefined,
        password: env.XMR_WALLET_PASSWORD || '',
        syncTimeoutMs: intEnv('XMR_SYNC_TIMEOUT_MS', 120000),   // (C) bound a hung sync; fail over to the next node
    });

    // refuse to run anything but a view-only wallet — a spend key here would be
    // custodial and a catastrophic footgun.
    if (!scanner.viewOnly) { console.error('REFUSING TO START: the wallet holds a spend key — use a VIEW-ONLY key'); process.exit(1); }
    console.log(`scanner up · node ${scanner.node} · view-only · birthday height ${scanner.birthdayHeight}`);
    if (!env.XMR_WALLET_PATH) console.warn('[warn] XMR_WALLET_PATH not set — set it so the wallet keeps its scan state across restarts (orders persist, but a fresh wallet starts at the tip).');

    const store = loadOrders();
    let idc = 0; for (const id of store.keys()) { const m = /(\d+)$/.exec(id); if (m && +m[1] > idc) idc = +m[1]; }
    console.log(`orders: ${store.size} reloaded from ${ORDERS_FILE}`);

    // merchant signing key for RECEIPTS. it persists so the fingerprint a buyer
    // pins stays stable across restarts; generated once if absent. it is NOT a
    // Monero key — it only signs receipts, so losing it costs nothing but new
    // receipts (old ones still verify against their embedded pubkey).
    const RECEIPT_KEY_FILE = env.XMR_RECEIPT_KEY || 'receipt-key.pem';
    let receiptKey = null, receiptFp = null;
    try {
        let pem;
        if (fs.existsSync(RECEIPT_KEY_FILE)) { pem = fs.readFileSync(RECEIPT_KEY_FILE, 'utf8'); }
        else { pem = generateSigningKey().privateKey; fs.writeFileSync(RECEIPT_KEY_FILE, pem, { mode: 0o600 }); console.log(`[receipt] generated a new signing key → ${RECEIPT_KEY_FILE}`); }
        receiptKey = pem;
        receiptFp = configFingerprint(crypto.createPublicKey(pem).export({ type: 'spki', format: 'pem' }));
        console.log(`[receipt] signing fingerprint ${receiptFp}  — publish this so buyers can pin it`);
    } catch (e) { console.warn(`[receipt] disabled — could not load/create a signing key: ${e.message}`); }

    // ── durable fulfillment webhook ─────────────────────────────────────────
    // the order.paid webhook is the merchant's notification to fulfill. firing it
    // ONCE (even with sendWebhook's internal retries) loses it if their endpoint is
    // briefly down — the order is paid on-chain but the merchant never hears. so we
    // track delivery PER ORDER (persisted in orders.json) and re-attempt undelivered
    // ones on a sweep with capped backoff, surviving endpoint outages AND restarts.
    function buildWebhookPayload(order) {
        return {
            event: 'order.paid',
            order_id: order.id,
            amount_xmr: order.amount,           // what was owed
            received_xmr: order.receivedXmr,    // what actually landed (≥ owed)
            overpaid: !!order.overpaid,         // buyer sent MORE than owed
            overpaid_xmr: order.overpaidXmr || '0', // exact excess to refund
            address: order.address,             // the per-order subaddress paid
            txids: order.txids,
            confirmations: order.confirmations,
            network: env.XMR_NETWORK || 'mainnet',
            receipt: order.receipt,             // signed receipt envelope (if minted)
        };
    }
    async function deliverWebhook(orderId) {
        if (!env.FULFILL_WEBHOOK_URL) return;
        const order = store.get(orderId);
        if (!order || !order.paid || order.webhookDelivered) return;
        order.webhookAttempts = (order.webhookAttempts || 0) + 1;
        let res;
        try { res = await sendWebhook(env.FULFILL_WEBHOOK_URL, buildWebhookPayload(order), { secret: env.FULFILL_WEBHOOK_SECRET }); }
        catch (e) { res = { delivered: false, error: e.message }; }
        if (res && res.delivered) {
            order.webhookDelivered = true; order.webhookNextAt = 0;
            console.log(`[webhook] ${orderId} delivered (attempt ${order.webhookAttempts})`);
        } else {
            // capped exponential backoff (5s → … → 30 min ceiling); keep retrying
            // while the order lives in the store. GET /order/:id shows it undelivered.
            const backoff = Math.min(1800000, 5000 * 2 ** Math.min(order.webhookAttempts - 1, 8));
            order.webhookNextAt = Date.now() + backoff;
            console.warn(`[webhook] ${orderId} undelivered (attempt ${order.webhookAttempts}, ${(res && (res.status || res.error)) || '?'}) — retry in ${Math.round(backoff / 1000)}s`);
        }
        saveOrders(store);
    }

    // ── SSE push (instant detection) ────────────────────────────────────────
    // BTCPay pushes invoice changes to the buyer over a socket so the checkout
    // updates the moment a tx is seen — no polling lag. we do the same the simple
    // way: GET /order/:id/stream is a Server-Sent-Events channel. the buyer's
    // widget (or any client) gets the status the instant the poller folds a change.
    // it rides through the same-origin proxy like any GET, and a slow poll stays as
    // a backup, so a buffering proxy can never make a payment look lost.
    const sseClients = new Map();   // orderId -> Set<res>
    function sseCount() { let n = 0; for (const s of sseClients.values()) n += s.size; return n; }
    async function buildStatus(r) {
        const dh = await tipHeight(), wh = await walletHeight();
        const syncing = !r.paid && wh != null && dh != null && (dh - wh) > SYNC_GAP;
        return { id: r.id, paid: r.paid, status: r.status, amount: r.amount, receivedXmr: r.receivedXmr, lockedXmr: r.lockedXmr, shortfallXmr: r.shortfallXmr, overpaid: !!r.overpaid, overpaidXmr: r.overpaidXmr || '0', confirmations: r.confirmations, minConfirmations: MIN_CONF, tipHeight: dh, walletHeight: wh, syncing, txids: r.txids, webhookDelivered: r.webhookDelivered !== false };
    }
    async function pushOrder(id) {
        const set = sseClients.get(id);
        if (!set || set.size === 0) return;
        const r = agent.get(id);
        if (!r) return;
        let body; try { body = JSON.stringify(await buildStatus(r)); } catch { return; }
        for (const res of set) { try { res.write(`data: ${body}\n\n`); } catch { /* dropped on close */ } }
    }

    const agent = createPaymentAgent({
        scanner,
        store,
        idgen: () => `ord_${(++idc).toString(36)}`,
        minConfirmations: intEnv('XMR_MIN_CONFIRMATIONS', 1),
        toleranceXmr: env.XMR_TOLERANCE_XMR || '0',   // (B) accept within this much of the price (dust/fee/rounding); default exact
        pollMs: intEnv('POLL_MS', 15000),
        // adaptive cadence: poll fast while a buyer is actively paying (an order is
        // young, or a checkout stream is open), slow when idle. detection in seconds
        // without idle-hammering the node. POLL_ACTIVE_MS >= POLL_MS disables it.
        activePollMs: intEnv('POLL_ACTIVE_MS', 3000),
        activeWindowMs: Math.max(0, intEnv('XMR_CHECKOUT_WINDOW_MIN', 30) * 60000),
        activeHint: () => sseCount() > 0,   // someone is watching the checkout right now
        // pre-warm a pool of subaddresses so POST /order is instant even while a
        // wallet sync holds the lock (set 0 to create one per order on demand).
        subaddressPool: intEnv('XMR_SUBADDRESS_POOL', 8),
        poolLabel: 'order',
        onUpdate: (o) => { queueSave(store); pushOrder(o.id); },   // coalesced save + instant SSE push to the buyer
        // drop unpaid orders older than XMR_EXPIRY_HOURS (0 = never, default). bounds
        // the per-tick work + memory; a late payment still lands on-chain in your
        // wallet — it just won't auto-complete (reconcile from the [expired] log).
        expiryMs: Math.max(0, (Number(env.XMR_EXPIRY_HOURS) || 0) * 3600000),
        onExpire: (order) => { console.log(`[expired] ${order.id} · unpaid > ${env.XMR_EXPIRY_HOURS}h · dropped`); queueSave(store); },
        // retire SETTLED orders too (the store/webhook is the source of truth) so a
        // long-running agent's memory + ledger stay bounded. 0 = keep forever.
        paidRetentionMs: Math.max(0, (Number(env.XMR_PAID_RETENTION_HOURS) || 0) * 3600000),
        onPaid: async (order) => {
            saveOrders(store);
            pushOrder(order.id);   // tell the buyer "paid" INSTANTLY — before the (slower) receipt mint below
            console.log(`[paid] ${order.id} · ${order.amount} XMR · tx ${order.txids.join(',')}`);

            // mint + sign the receipt. the merchant signature is the offline leg;
            // the InProofs are the trustless on-chain leg (best-effort — a failure
            // never blocks the order, the signed receipt still stands on its own).
            if (receiptKey) {
                try {
                    const txProofs = [];
                    if (env.XMR_RECEIPT_TXPROOF !== '0') {
                        for (const txid of order.txids) {
                            try { txProofs.push(await scanner.txProof(txid, order.index)); }
                            catch (e) { console.warn(`[receipt] tx_proof ${txid} failed: ${e.message}`); }
                        }
                    }
                    const merchant = { fingerprint: receiptFp };
                    if (env.XMR_MERCHANT_NAME) merchant.name = env.XMR_MERCHANT_NAME;
                    const signed = signReceipt(receiptFromOrder(order, {
                        merchant, network: env.XMR_NETWORK || 'mainnet', paidAt: Date.now(), txProofs,
                    }), receiptKey);
                    order.receipt = signed;                 // for the webhook payload (onPaid gets a snapshot)
                    const live = store.get(order.id);        // ALSO persist on the live order so GET /receipt/:id + a reload find it
                    if (live) live.receipt = signed;
                    saveOrders(store);
                    console.log(`[receipt] ${order.id} signed${txProofs.length ? ` + ${txProofs.length} tx_proof(s)` : ''}`);
                } catch (e) { console.error(`[receipt] ${order.id} mint failed: ${e.message}`); }
            }

            if (env.FULFILL_WEBHOOK_URL) {
                // mark pending on the LIVE order (onPaid gets a snapshot) so the flag
                // persists + the sweep can re-attempt; then try once immediately.
                const live = store.get(order.id);
                if (live) { live.webhookDelivered = false; live.webhookAttempts = 0; live.webhookNextAt = 0; }
                await deliverWebhook(order.id);
            }
        },
    });
    agent.start();

    const MIN_CONF = intEnv('XMR_MIN_CONFIRMATIONS', 1);
    // cached chain tip so a busy status endpoint doesn't hammer the node — gives
    // the UI a REAL, live block height to show ("scanning the blockchain").
    let _tip = { h: 0, at: 0 }, _tipInflight = null;
    async function tipHeight() {
        const now = Date.now();
        if (_tip.h && now - _tip.at < 5000) return _tip.h;
        // DEDUP the fetch: under a burst of concurrent status polls on a cold/stale
        // cache, every request would otherwise fire its own /get_height — a
        // thundering herd against the node. share one in-flight fetch instead.
        if (_tipInflight) return _tipInflight;
        // Read through the scanner's authenticated transport, not through the
        // wallet lock. This keeps health checks responsive for Basic/Digest nodes.
        _tipInflight = (async () => {
            try {
                const h = Number(await scanner.tipHeight());
                if (Number.isFinite(h) && h > 0) { _tip.h = h; _tip.at = Date.now(); }
            } catch { /* keep last */ }
            finally { _tipInflight = null; }
            return _tip.h || null;
        })();
        return _tipInflight;
    }

    // (A) the scanner's OWN synced height (local wallet read, cached 3s). compared to
    // the daemon tip it tells whether we're CAUGHT UP — so a behind/just-restarted
    // agent can say "node catching up" instead of reporting a paid order as pending.
    let _wh = { h: 0, at: 0 };
    async function walletHeight() {
        const now = Date.now();
        if (_wh.h && now - _wh.at < 3000) return _wh.h;
        try { const h = await scanner.height(); if (Number.isFinite(h) && h > 0) { _wh.h = h; _wh.at = Date.now(); } } catch { /* keep last */ }
        return _wh.h || null;
    }
    const SYNC_GAP = intEnv('XMR_SYNC_GAP', 2);   // blocks behind tip still considered "synced"

    const server = http.createServer(async (req, res) => {
        const url = req.url.split('?')[0];
        try {
            if (req.method === 'GET' && url === '/healthz') {
                // count paid orders whose fulfillment webhook is still undelivered —
                // a non-zero value means a merchant endpoint is down / mis-set, NOT a
                // lost payment (the funds are on-chain; the order is paid).
                let undeliveredWebhooks = 0;
                if (env.FULFILL_WEBHOOK_URL) for (const o of store.values()) if (o.paid && o.webhookDelivered === false) undeliveredWebhooks++;
                const dh = await tipHeight(), wh = await walletHeight();
                const synced = (wh != null && dh != null) ? (dh - wh) <= SYNC_GAP : null;
                return send(res, 200, { ok: true, network: env.XMR_NETWORK || 'mainnet', node: scanner.node, viewOnly: scanner.viewOnly, orders: agent.list().length, pool: agent.poolReady(), receipt: receiptFp || null, undeliveredWebhooks, streamClients: sseCount(), walletHeight: wh, daemonHeight: dh, synced });
            }
            if (req.method === 'POST' && url === '/order') {
                if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { error: 'unauthorized' });
                let raw = ''; req.on('data', c => { raw += c; if (raw.length > 16384) req.destroy(); });
                req.on('end', async () => {
                    let body; try { body = JSON.parse(raw || '{}'); } catch { return send(res, 400, { error: 'bad json' }); }
                    if (!body.amount) return send(res, 400, { error: 'amount is required' });
                    try {
                        const order = await agent.createOrder({ id: body.id, amount: String(body.amount), label: body.label });
                        saveOrders(store);   // persist immediately so a restart right after won't forget it
                        send(res, 200, { id: order.id, address: order.address, amount: order.amount, status: order.status, birthdayHeight: order.birthdayHeight });
                    } catch (e) { send(res, 409, { error: e.message }); }
                });
                return;
            }
            // SSE stream: push status changes the instant the poller folds them, so
            // the buyer's checkout updates in seconds (BTCPay's socket trick, done
            // simply). EventSource can't set headers → accept the token via ?token=
            // too. matched BEFORE the plain /order/:id route.
            const sm = url.match(/^\/order\/([^/]+)\/stream$/);
            if (req.method === 'GET' && sm) {
                const qtoken = new URL(req.url, 'http://x').searchParams.get('token');
                if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}` && qtoken !== TOKEN) return send(res, 401, { error: 'unauthorized' });
                const id = decodeURIComponent(sm[1]);
                const r0 = agent.get(id);
                if (!r0) return send(res, 404, { error: 'unknown order' });
                res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
                res.write('retry: 3000\n\n');
                buildStatus(r0).then(s => { try { res.write(`data: ${JSON.stringify(s)}\n\n`); } catch { /* closed */ } });
                let set = sseClients.get(id); if (!set) { set = new Set(); sseClients.set(id, set); }
                set.add(res);
                agent.kick();   // a watcher just arrived — poll fast now
                const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 20000); if (ping.unref) ping.unref();
                const cleanup = () => { clearInterval(ping); const s = sseClients.get(id); if (s) { s.delete(res); if (s.size === 0) sseClients.delete(id); } };
                req.on('close', cleanup); res.on('error', cleanup);
                return;
            }
            const m = url.match(/^\/order\/([^/]+)$/);
            if (req.method === 'GET' && m) {
                if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { error: 'unauthorized' });
                // read the CACHED state — the background poller keeps every order
                // fresh, so a status poll never triggers a per-request wallet sync.
                const r = agent.get(decodeURIComponent(m[1]));
                if (!r) return send(res, 404, { error: 'unknown order' });
                return send(res, 200, await buildStatus(r));
            }
            // the signed receipt for a paid order. token-gated like /order/:id so
            // receipts are not enumerable on the open agent — the buyer fetches
            // theirs through the store (which checks they own the order), and the
            // receipt itself is shareable + verifiable by anyone once they have it.
            const rm = url.match(/^\/receipt\/([^/]+)$/);
            if (req.method === 'GET' && rm) {
                if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { error: 'unauthorized' });
                const r = agent.get(decodeURIComponent(rm[1]));
                if (!r) return send(res, 404, { error: 'unknown order' });
                if (!r.receipt) return send(res, 409, { error: r.paid ? 'receipt not ready' : 'order not paid yet', status: r.status });
                return send(res, 200, r.receipt);
            }
            send(res, 404, { error: 'not found' });
        } catch (e) { send(res, 500, { error: 'agent error' }); }
    });
    server.listen(PORT, BIND, () => console.log(`payment agent on http://${BIND}:${PORT}  (POST /order · GET /order/:id · GET /order/:id/stream · GET /receipt/:id · GET /healthz)`));

    // re-attempt any paid order whose webhook is still undelivered (endpoint was
    // down at pay time, or we just restarted with one pending in orders.json). only
    // touches orders explicitly flagged false — orders paid before this feature
    // (webhookDelivered === undefined) are treated as already handled, never re-spammed.
    if (env.FULFILL_WEBHOOK_URL) {
        const _webhookSweep = setInterval(() => {
            const now = Date.now();
            for (const o of store.values()) {
                if (o.paid && o.webhookDelivered === false && (o.webhookNextAt || 0) <= now) deliverWebhook(o.id);
            }
        }, intEnv('XMR_WEBHOOK_SWEEP_MS', 30000));
        if (_webhookSweep.unref) _webhookSweep.unref();
    }

    const _persist = setInterval(() => saveOrders(store), 30000); if (_persist.unref) _persist.unref();
    // persist the WALLET cache too (subaddress indices + scan progress). without
    // this, a restart re-creates subaddresses from index 1 — reusing a still-
    // pending order's address — and rescans from the restore height every time.
    const _persistWallet = setInterval(() => { scanner.save().catch(() => {}); }, 120000); if (_persistWallet.unref) _persistWallet.unref();
    setTimeout(() => { scanner.save().catch(() => {}); }, 8000);   // capture the pre-warmed pool early

    // graceful shutdown. systemd sends SIGTERM on `systemctl restart/stop` (NOT
    // SIGINT), so we MUST handle it — otherwise the wallet never saves and the
    // next boot reuses subaddress indices. close(true) writes the wallet cache.
    let _down = false;
    const shutdown = () => {
        if (_down) return; _down = true;
        agent.stop(); saveOrders(store);
        scanner.close(true).finally(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
})().catch(e => { console.error('agent boot error:', e); process.exit(2); });
