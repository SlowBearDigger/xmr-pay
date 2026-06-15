// merchant-side payment verification endpoint — the ONLY server piece, and it
// runs on YOUR infrastructure (Vercel/Netlify function, Express route, anything
// Node). nobody else is in the path: you choose the nodes, you keep the state.
//
// drop-in: Vercel → api/verify-payment.js · Express → app.post('/api/verify-payment', handler)
//
// THIS IS PROOF MODE — a stateless check of a proof the BUYER submits (txid +
// tx_proof). Fast and serverless-safe. Do NOT put watch-mode block SCANNING in a
// serverless function: scanning decrypts every output with your view key and can
// exceed a 10-15s function timeout on a slow node, stranding a payment. For watch
// mode (auto-detect, no buyer proof) run the long-lived agent — `npx xmr-pay`.
//
// A public verify URL calls YOUR nodes, so it's a DoS amplifier — this ships with
// a per-IP rate limit and an OPTIONAL shared-secret gate (VERIFY_TOKEN). The
// order-exists / not-already-paid checks are the anti-spam story; the alreadyUsed
// hook is the anti-replay story. For real scale, back the rate limit with a shared
// store (Upstash/Redis) and use quorum >= 2 with nodes you trust.

const { verifyPayment } = require('xmr-pay');
const { sendWebhook } = require('xmr-pay/webhook');

// your trusted nodes — your own monerod first if you run one
const NODES = (process.env.XMR_NODES ||
    'https://xmr-node.cakewallet.com:18081,https://node.sethforprivacy.com').split(',');

// require two independent nodes to agree by default — a single lying/wrong node
// can't flip a verdict. needs >= QUORUM reachable nodes; raise to 3 for serious
// volume, or set XMR_QUORUM=1 if you run your own trusted node.
const QUORUM = Number(process.env.XMR_QUORUM || 2);

// optional shared-secret gate. a public tip endpoint can stay open; a store
// endpoint should set VERIFY_TOKEN and have its frontend send `Authorization:
// Bearer <token>` (proxy it server-side so the token isn't in the browser).
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || '';

// per-IP fixed-window rate limit. in-memory = per-instance (serverless caveat) —
// for real scale use a shared store or the platform limiter. tune to taste.
const RL = new Map();
const RL_MAX = Number(process.env.VERIFY_RL_MAX || 30), RL_WINDOW_MS = 60_000;
function rateLimited(req) {
    const ip = String(req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || 'unknown').split(',')[0].trim();
    const now = Date.now(), e = RL.get(ip);
    if (!e || now > e.resetAt) { RL.set(ip, { n: 1, resetAt: now + RL_WINDOW_MS }); return false; }
    return ++e.n > RL_MAX;
}

// CORS: when the widget lives on a different origin than this function (e.g. a
// static site on github.io calling a function on vercel.app), the browser needs
// these headers or it blocks the request. set CORS_ORIGIN to your exact site
// origin in production — '*' is fine for a public tip endpoint, not for a store.
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
function cors(res) {
    res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// stand-in for your real orders storage. amount carries a piconero nonce so
// each order is unique on-chain (see xmr-pay/core makeAmountNonce).
const ORDERS = new Map([
    ['ord_123', { address: process.env.XMR_ADDRESS, amount_xmr: '0.050000000817', status: 'pending', tx_hash: null }],
]);

module.exports = async function handler(req, res) {
    cors(res);
    if (req.method === 'OPTIONS') return res.status(204).end();   // CORS preflight
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
    if (VERIFY_TOKEN && req.headers.authorization !== `Bearer ${VERIFY_TOKEN}`) return res.status(401).json({ error: 'unauthorized' });
    if (rateLimited(req)) return res.status(429).json({ error: 'rate limited — slow down' });
    const { order_id, txid, proof } = req.body || {};

    // cheap gates first — nothing touches a node unless the order is real and open
    const order = ORDERS.get(order_id);
    if (!order) return res.status(404).json({ error: 'unknown order' });
    if (order.status === 'paid') return res.json({ paid: true, status: 'paid', reason: 'already confirmed' });

    const result = await verifyPayment({
        txid,
        proof,
        address: order.address,
        amount: order.amount_xmr,
        nodes: NODES,
        minConfirmations: 1,          // raise for high-value orders
        quorum: QUORUM,               // default 2 — independent nodes must agree
        alreadyUsed: async (id) =>    // replay check against YOUR data
            [...ORDERS.values()].some(o => o.tx_hash === id),
    });

    if (result.paid) {
        // re-check and claim the txid in one synchronous tick (no await between
        // check and write) — concurrent requests can't both pass. with a real
        // database, enforce a UNIQUE constraint on tx_hash instead.
        if ([...ORDERS.values()].some(o => o.tx_hash === result.txid)) {
            return res.json({ ...result, paid: false, status: 'replay', reason: 'this txid was already used to pay another order' });
        }
        order.status = 'paid';
        order.tx_hash = result.txid;
        // fulfillment "webhook": YOUR endpoint notifies YOUR systems (shipping,
        // shop platform, Discord, Zapier) — signed with YOUR secret. there is no
        // third-party server anywhere in this flow.
        if (process.env.FULFILL_WEBHOOK_URL) {
            await sendWebhook(process.env.FULFILL_WEBHOOK_URL, {
                event: 'order.paid',
                order_id,
                txid: result.txid,
                amount_xmr: order.amount_xmr,
                confirmations: result.confirmations,
            }, { secret: process.env.FULFILL_WEBHOOK_SECRET });
        }
    }
    // transient transport failures (node-error, node-disagreement) are retryable:
    // answer 503 so clients and infra back off and retry, while still returning the
    // result body. terminal verdicts (paid/underpaid/locked/invalid/…) are 200.
    const retryable = result.status === 'node-error' || result.status === 'node-disagreement';
    return res.status(retryable ? 503 : 200).json(result);
};
