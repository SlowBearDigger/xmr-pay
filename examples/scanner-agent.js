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
//   GET  /healthz                 → {ok, network, node, viewOnly, orders}
//
// needs monero-ts installed (the only non-core dependency, optional peer).

const http = require('http');
const fs = require('fs');
const { createScanner } = require('../src/scanner');
const { createPaymentAgent } = require('../src/agent');
const { sendWebhook } = require('../src/webhook');

const env = process.env;
const NODES = (env.XMR_NODES || '').split(',').map(s => s.trim()).filter(Boolean);
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

function send(res, code, body) {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
}

(async () => {
    if (!env.XMR_PRIMARY_ADDRESS || !env.XMR_VIEW_KEY) {
        console.error('set XMR_PRIMARY_ADDRESS and XMR_VIEW_KEY (private view key)');
        process.exit(1);
    }
    if (NODES.length === 0) { console.error('set XMR_NODES (comma-separated)'); process.exit(1); }

    console.log('booting scanner (one-time WASM cold start)…');
    const scanner = await createScanner({
        primaryAddress: env.XMR_PRIMARY_ADDRESS,
        privateViewKey: env.XMR_VIEW_KEY,
        networkType: env.XMR_NETWORK || 'mainnet',
        nodes: NODES,
        restoreHeight: env.XMR_RESTORE_HEIGHT != null && env.XMR_RESTORE_HEIGHT !== '' ? Number(env.XMR_RESTORE_HEIGHT) : undefined,
        path: env.XMR_WALLET_PATH || undefined,
        password: env.XMR_WALLET_PASSWORD || '',
    });

    // refuse to run anything but a view-only wallet — a spend key here would be
    // custodial and a catastrophic footgun.
    if (!scanner.viewOnly) { console.error('REFUSING TO START: the wallet holds a spend key — use a VIEW-ONLY key'); process.exit(1); }
    console.log(`scanner up · node ${scanner.node} · view-only · birthday height ${scanner.birthdayHeight}`);
    if (!env.XMR_WALLET_PATH) console.warn('[warn] XMR_WALLET_PATH not set — set it so the wallet keeps its scan state across restarts (orders persist, but a fresh wallet starts at the tip).');

    const store = loadOrders();
    let idc = 0; for (const id of store.keys()) { const m = /(\d+)$/.exec(id); if (m && +m[1] > idc) idc = +m[1]; }
    console.log(`orders: ${store.size} reloaded from ${ORDERS_FILE}`);

    const agent = createPaymentAgent({
        scanner,
        store,
        idgen: () => `ord_${(++idc).toString(36)}`,
        minConfirmations: intEnv('XMR_MIN_CONFIRMATIONS', 1),
        pollMs: intEnv('POLL_MS', 15000),
        // pre-warm a pool of subaddresses so POST /order is instant even while a
        // wallet sync holds the lock (set 0 to create one per order on demand).
        subaddressPool: intEnv('XMR_SUBADDRESS_POOL', 8),
        poolLabel: 'order',
        onUpdate: () => saveOrders(store),
        onPaid: async (order) => {
            saveOrders(store);
            console.log(`[paid] ${order.id} · ${order.amount} XMR · tx ${order.txids.join(',')}`);
            if (env.FULFILL_WEBHOOK_URL) {
                try {
                    await sendWebhook(env.FULFILL_WEBHOOK_URL,
                        {
                            event: 'order.paid',
                            order_id: order.id,
                            amount_xmr: order.amount,           // what was owed
                            received_xmr: order.receivedXmr,    // what actually landed (≥ owed)
                            address: order.address,             // the per-order subaddress paid
                            txids: order.txids,
                            confirmations: order.confirmations,
                            network: env.XMR_NETWORK || 'mainnet',
                        },
                        { secret: env.FULFILL_WEBHOOK_SECRET });
                } catch (e) { console.error(`[webhook] ${order.id} failed: ${e.message}`); }
            }
        },
    });
    agent.start();

    const MIN_CONF = intEnv('XMR_MIN_CONFIRMATIONS', 1);
    // cached chain tip so a busy status endpoint doesn't hammer the node — gives
    // the UI a REAL, live block height to show ("scanning the blockchain").
    let _tip = { h: 0, at: 0 };
    async function tipHeight() {
        const now = Date.now();
        if (_tip.h && now - _tip.at < 5000) return _tip.h;
        // fetch STRAIGHT from the node, not via the wallet — a status read must
        // never block behind an in-progress wallet sync.
        try {
            const r = await fetch(String(scanner.node).replace(/\/+$/, '') + '/get_height', { signal: AbortSignal.timeout(4000) });
            const j = await r.json(); const h = Number(j && j.height);
            if (Number.isFinite(h) && h > 0) { _tip.h = h; _tip.at = now; }
        } catch { /* keep last */ }
        return _tip.h || null;
    }

    const server = http.createServer(async (req, res) => {
        const url = req.url.split('?')[0];
        try {
            if (req.method === 'GET' && url === '/healthz') {
                return send(res, 200, { ok: true, network: env.XMR_NETWORK || 'mainnet', node: scanner.node, viewOnly: scanner.viewOnly, orders: agent.list().length, pool: agent.poolReady() });
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
            const m = url.match(/^\/order\/([^/]+)$/);
            if (req.method === 'GET' && m) {
                if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { error: 'unauthorized' });
                // read the CACHED state — the background poller keeps every order
                // fresh, so a status poll never triggers a per-request wallet sync.
                const r = agent.get(decodeURIComponent(m[1]));
                if (!r) return send(res, 404, { error: 'unknown order' });
                return send(res, 200, { id: r.id, paid: r.paid, status: r.status, amount: r.amount, receivedXmr: r.receivedXmr, lockedXmr: r.lockedXmr, shortfallXmr: r.shortfallXmr, confirmations: r.confirmations, minConfirmations: MIN_CONF, tipHeight: await tipHeight(), txids: r.txids });
            }
            send(res, 404, { error: 'not found' });
        } catch (e) { send(res, 500, { error: 'agent error' }); }
    });
    server.listen(PORT, BIND, () => console.log(`payment agent on http://${BIND}:${PORT}  (POST /order · GET /order/:id · GET /healthz)`));

    const _persist = setInterval(() => saveOrders(store), 30000); if (_persist.unref) _persist.unref();
    process.on('SIGINT', () => { agent.stop(); saveOrders(store); scanner.close(false).finally(() => process.exit(0)); });
})().catch(e => { console.error('agent boot error:', e); process.exit(2); });
