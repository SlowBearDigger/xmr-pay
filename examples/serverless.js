// merchant-side payment verification endpoint — the ONLY server piece, and it
// runs on YOUR infrastructure (Vercel/Netlify function, Express route, anything
// Node). nobody else is in the path: you choose the nodes, you keep the state.
//
// drop-in: Vercel → api/verify-payment.js · Express → app.post('/api/verify-payment', handler)
//
// the in-memory Map below stands in for your existing orders table. the two
// guards before the node RPC (order exists / not already paid) are the whole
// anti-spam story; the alreadyUsed hook is the whole anti-replay story.

const { verifyPayment } = require('xmr-pay');
const { sendWebhook } = require('xmr-pay/webhook');

// your trusted nodes — your own monerod first if you run one
const NODES = (process.env.XMR_NODES ||
    'https://xmr-node.cakewallet.com:18081,https://node.sethforprivacy.com').split(',');

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
        quorum: 1,                    // 2 = require two independent nodes to agree
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
    return res.json(result);
};
