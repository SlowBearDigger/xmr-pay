// Serve authenticated payment orders, status streams and receipts.
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const { createScanner } = require('../src/scanner');
const { createPaymentAgent } = require('../src/agent');
const { sendWebhook } = require('../src/webhook');
const { receiptFromOrder, signReceipt } = require('../src/receipt');
const { generateSigningKey, configFingerprint } = require('../src/config');
const { nodesFromEnv } = require('../src/nodes');
const { loadOrders, saveOrders } = require('../src/ledger');

const env = process.env;
let NODES;
try { NODES = nodesFromEnv(env); }
catch (error) {
    console.error(`invalid Monero node configuration: ${error && error.code ? error.code : 'invalid-node-list'}`);
    process.exit(1);
}
const PORT = Number(env.PORT || 8788);
const BIND = env.BIND || '127.0.0.1';
const TOKEN = env.AGENT_TOKEN || '';
if (!TOKEN) {
    console.error('AGENT_TOKEN is required, including on loopback');
    process.exit(1);
}
const intEnv = (k, d) => { const n = Number(env[k]); return Number.isFinite(n) ? n : d; };

const ORDERS_FILE = env.XMR_ORDERS_FILE || 'orders.json';

let _saveDirty = false, _saveTimer = null;
function queueSave(store) {
    _saveDirty = true;
    if (_saveTimer) return;
    _saveTimer = setTimeout(() => { _saveTimer = null; if (_saveDirty) { _saveDirty = false; saveOrders(ORDERS_FILE, store); } }, 1000);
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
        syncTimeoutMs: intEnv('XMR_SYNC_TIMEOUT_MS', 120000),
    });

    if (!scanner.viewOnly) { console.error('REFUSING TO START: the wallet holds a spend key: use a VIEW-ONLY key'); process.exit(1); }
    console.log(`scanner up · node ${scanner.node} · view-only · birthday height ${scanner.birthdayHeight}`);
    if (!env.XMR_WALLET_PATH) console.warn('[warn] XMR_WALLET_PATH not set: set it so the wallet keeps its scan state across restarts (orders persist, but a fresh wallet starts at the tip).');

    const store = loadOrders(ORDERS_FILE);
    console.log(`orders: ${store.size} reloaded from ${ORDERS_FILE}`);

    const RECEIPT_KEY_FILE = env.XMR_RECEIPT_KEY || 'receipt-key.pem';
    let receiptKey = null, receiptFp = null;
    try {
        let pem;
        if (fs.existsSync(RECEIPT_KEY_FILE)) { pem = fs.readFileSync(RECEIPT_KEY_FILE, 'utf8'); }
        else { pem = generateSigningKey().privateKey; fs.writeFileSync(RECEIPT_KEY_FILE, pem, { mode: 0o600 }); console.log(`[receipt] generated a new signing key → ${RECEIPT_KEY_FILE}`); }
        receiptKey = pem;
        receiptFp = configFingerprint(crypto.createPublicKey(pem).export({ type: 'spki', format: 'pem' }));
        console.log(`[receipt] signing fingerprint ${receiptFp} : publish this so buyers can pin it`);
    } catch (e) { console.warn(`[receipt] disabled: could not load/create a signing key: ${e.message}`); }

    function buildWebhookPayload(order) {
        return {
            event: 'order.paid',
            order_id: order.id,
            amount_xmr: order.amount,
            received_xmr: order.receivedXmr,
            overpaid: !!order.overpaid,
            overpaid_xmr: order.overpaidXmr || '0',
            address: order.address,
            txids: order.txids,
            confirmations: order.confirmations,
            network: env.XMR_NETWORK || 'mainnet',
            receipt: order.receipt,
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

            const backoff = Math.min(1800000, 5000 * 2 ** Math.min(order.webhookAttempts - 1, 8));
            order.webhookNextAt = Date.now() + backoff;
            console.warn(`[webhook] ${orderId} undelivered (attempt ${order.webhookAttempts}, ${(res && (res.status || res.error)) || '?'}): retry in ${Math.round(backoff / 1000)}s`);
        }
        saveOrders(ORDERS_FILE, store);
    }

    const sseClients = new Map();
    function sseCount() { let n = 0; for (const s of sseClients.values()) n += s.size; return n; }
    async function buildStatus(r) {
        const dh = await tipHeight(), wh = await walletHeight();
        const syncing = !r.paid && (wh == null || dh == null || (dh - wh) > SYNC_GAP);
        return { id: r.id, paid: r.paid, status: r.status, amount: r.amount, receivedXmr: r.receivedXmr, pendingXmr: r.pendingXmr, lockedXmr: r.lockedXmr, shortfallXmr: r.shortfallXmr, overpaid: !!r.overpaid, overpaidXmr: r.overpaidXmr || '0', confirmations: r.confirmations, minConfirmations: MIN_CONF, tipHeight: dh, walletHeight: wh, syncing, txids: r.txids, webhookDelivered: r.webhookDelivered !== false };
    }
    async function pushOrder(id) {
        const set = sseClients.get(id);
        if (!set || set.size === 0) return;
        const r = agent.get(id);
        if (!r) return;
        let body; try { body = JSON.stringify(await buildStatus(r)); } catch { return; }
        for (const res of set) { try { res.write(`data: ${body}\n\n`); } catch {   } }
    }

    const agent = createPaymentAgent({
        scanner,
        store,
        minConfirmations: intEnv('XMR_MIN_CONFIRMATIONS', 1),
        toleranceXmr: env.XMR_TOLERANCE_XMR || '0',
        pollMs: intEnv('POLL_MS', 15000),

        activePollMs: intEnv('POLL_ACTIVE_MS', 3000),
        activeWindowMs: Math.max(0, intEnv('XMR_CHECKOUT_WINDOW_MIN', 30) * 60000),
        activeHint: () => sseCount() > 0,

        subaddressPool: intEnv('XMR_SUBADDRESS_POOL', 8),
        poolLabel: 'order',
        onUpdate: (o) => { queueSave(store); pushOrder(o.id); },

        expiryMs: Math.max(0, (Number(env.XMR_EXPIRY_HOURS) || 0) * 3600000),
        onExpire: (order) => { console.log(`[expired] ${order.id} · unpaid > ${env.XMR_EXPIRY_HOURS}h · dropped`); queueSave(store); },

        paidRetentionMs: Math.max(0, (Number(env.XMR_PAID_RETENTION_HOURS) || 0) * 3600000),
        onPaid: async (order) => {

            const live = store.get(order.id);
            if (live && env.FULFILL_WEBHOOK_URL) {
                live.webhookDelivered = false; live.webhookAttempts = 0; live.webhookNextAt = 0;
            }
            try { saveOrders(ORDERS_FILE, store); }
            catch (e) { console.error(`[orders] paid order save failed: ${e.message}`); process.exit(2); }
            pushOrder(order.id);
            console.log(`[paid] ${order.id} · ${order.amount} XMR · tx ${order.txids.join(',')}`);

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
                    order.receipt = signed;
                    const live = store.get(order.id);
                    if (live) live.receipt = signed;
                    try { saveOrders(ORDERS_FILE, store); }
                    catch (e) { console.error(`[orders] receipt save failed: ${e.message}`); process.exit(2); }
                    console.log(`[receipt] ${order.id} signed${txProofs.length ? ` + ${txProofs.length} tx_proof(s)` : ''}`);
                } catch (e) { console.error(`[receipt] ${order.id} mint failed: ${e.message}`); }
            }

            if (env.FULFILL_WEBHOOK_URL) {
                await deliverWebhook(order.id);
            }
        },
    });
    agent.start();

    const MIN_CONF = intEnv('XMR_MIN_CONFIRMATIONS', 1);

    let _tip = { h: 0, at: 0 }, _tipInflight = null;
    async function tipHeight() {
        const now = Date.now();
        if (_tip.h && now - _tip.at < 5000) return _tip.h;

        if (_tipInflight) return _tipInflight;

        _tipInflight = (async () => {
            try {
                const h = Number(await scanner.tipHeight());
                if (Number.isFinite(h) && h > 0) { _tip.h = h; _tip.at = Date.now(); }
            } catch {   }
            finally { _tipInflight = null; }
            return _tip.h || null;
        })();
        return _tipInflight;
    }

    let _wh = { h: 0, at: 0 };
    async function walletHeight() {
        const now = Date.now();
        if (_wh.h && now - _wh.at < 3000) return _wh.h;
        try { const h = await scanner.height(); if (Number.isFinite(h) && h > 0) { _wh.h = h; _wh.at = Date.now(); } } catch {   }
        return _wh.h || null;
    }
    const SYNC_GAP = intEnv('XMR_SYNC_GAP', 2);

    const server = http.createServer(async (req, res) => {
        const url = req.url.split('?')[0];
        try {
            if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { error: 'unauthorized' });
            if (req.method === 'GET' && url === '/healthz') {

                let undeliveredWebhooks = 0;
                if (env.FULFILL_WEBHOOK_URL) for (const o of store.values()) if (o.paid && o.webhookDelivered === false) undeliveredWebhooks++;
                const dh = await tipHeight(), wh = await walletHeight();
                const synced = (wh != null && dh != null) ? (dh - wh) <= SYNC_GAP : null;
                return send(res, 200, { ok: true, network: env.XMR_NETWORK || 'mainnet', node: scanner.node, viewOnly: scanner.viewOnly, orders: agent.list().length, pool: agent.poolReady(), receipt: receiptFp || null, undeliveredWebhooks, streamClients: sseCount(), walletHeight: wh, daemonHeight: dh, synced });
            }
            if (req.method === 'POST' && url === '/order') {
                if ((req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') return send(res, 415, { error: 'application/json required' });
                const chunks = [];
                let size = 0;
                for await (const chunk of req) {
                    size += chunk.length;
                    if (size > 16384) { send(res, 413, { error: 'request too large' }); return; }
                    chunks.push(chunk);
                }
                let body;
                try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
                catch { return send(res, 400, { error: 'bad json' }); }
                if (!body || typeof body !== 'object' || Array.isArray(body)) return send(res, 400, { error: 'order object required' });
                const id = Number.isSafeInteger(body.id) && body.id >= 0 ? String(body.id) : body.id;
                let order;
                try { order = await agent.createOrder({ id, amount: body.amount, label: body.label }); }
                catch (e) { return send(res, 409, { error: e.message }); }
                try {
                    await scanner.save();
                    saveOrders(ORDERS_FILE, store);
                } catch (e) {
                    console.error(`[orders] save failed: ${e.message}`);
                    send(res, 503, { error: 'order ledger unavailable' });
                    setTimeout(() => process.exit(2), 100);
                    return;
                }
                return send(res, 200, { id: order.id, address: order.address, amount: order.amount, status: order.status, birthdayHeight: order.birthdayHeight });
            }

            const sm = url.match(/^\/order\/([^/]+)\/stream$/);
            if (req.method === 'GET' && sm) {
                const id = decodeURIComponent(sm[1]);
                const r0 = agent.get(id);
                if (!r0) return send(res, 404, { error: 'unknown order' });
                res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
                res.write('retry: 3000\n\n');
                buildStatus(r0).then(s => { try { res.write(`data: ${JSON.stringify(s)}\n\n`); } catch {   } });
                let set = sseClients.get(id); if (!set) { set = new Set(); sseClients.set(id, set); }
                set.add(res);
                agent.kick();
                const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {   } }, 20000); if (ping.unref) ping.unref();
                const cleanup = () => { clearInterval(ping); const s = sseClients.get(id); if (s) { s.delete(res); if (s.size === 0) sseClients.delete(id); } };
                req.on('close', cleanup); res.on('error', cleanup);
                return;
            }
            const m = url.match(/^\/order\/([^/]+)$/);
            if (req.method === 'GET' && m) {

                const r = agent.get(decodeURIComponent(m[1]));
                if (!r) return send(res, 404, { error: 'unknown order' });
                return send(res, 200, await buildStatus(r));
            }

            const rm = url.match(/^\/receipt\/([^/]+)$/);
            if (req.method === 'GET' && rm) {
                const r = agent.get(decodeURIComponent(rm[1]));
                if (!r) return send(res, 404, { error: 'unknown order' });
                if (!r.receipt) return send(res, 409, { error: r.paid ? 'receipt not ready' : 'order not paid yet', status: r.status });
                return send(res, 200, r.receipt);
            }
            send(res, 404, { error: 'not found' });
        } catch { send(res, 500, { error: 'agent error' }); }
    });
    server.listen(PORT, BIND, () => console.log(`payment agent on http://${BIND}:${PORT}  (POST /order · GET /order/:id · GET /order/:id/stream · GET /receipt/:id · GET /healthz)`));

    if (env.FULFILL_WEBHOOK_URL) {
        const _webhookSweep = setInterval(() => {
            const now = Date.now();
            for (const o of store.values()) {
                if (o.paid && o.webhookDelivered === false && (o.webhookNextAt || 0) <= now) deliverWebhook(o.id);
            }
        }, intEnv('XMR_WEBHOOK_SWEEP_MS', 30000));
        if (_webhookSweep.unref) _webhookSweep.unref();
    }

    const _persist = setInterval(() => saveOrders(ORDERS_FILE, store), 30000); if (_persist.unref) _persist.unref();

    const _persistWallet = setInterval(() => { scanner.save().catch(() => {}); }, 120000); if (_persistWallet.unref) _persistWallet.unref();
    setTimeout(() => { scanner.save().catch(() => {}); }, 8000);

    let _down = false;
    const shutdown = () => {
        if (_down) return; _down = true;
        agent.stop(); saveOrders(ORDERS_FILE, store);
        scanner.close(true).finally(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
})().catch(e => { console.error('agent boot error:', e); process.exit(2); });
