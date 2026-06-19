// shared verify logic for the demo — used by both the standalone server and the
// Vercel function. configured for stagenet so anyone can watch a real on-chain
// verification without spending real money. a real merchant would read orders
// from a database and persist `paid`; this demo verifies fresh every time so the
// same demo proof keeps working for every visitor.

const { verifyPayment } = require('xmr-pay');

const NODES = (process.env.XMR_NODES ||
    'http://node.monerodevs.org:38089,http://node2.monerodevs.org:38089,http://stagenet.xmr-tw.org:38081').split(',');
const NETWORK = process.env.XMR_NETWORK || 'stagenet';

// the demo order points at a stagenet subaddress that already received 0.1 XMR
// from a faucet (the page hands visitors a valid proof for that exact payment).
const ORDERS = new Map([
    ['ord_demo', {
        address: process.env.XMR_ADDRESS || '75a4WYbeKsdGjdFHqxpgNMSi3oqb1z9yx9m6qvNt3ZbTBpoFnD7EqicUZtCVsQoNPKXF5cMcTLJaTCkYiZVzddby9zc7bFV',
        amount_xmr: '0.1',
    }],
]);

// per-order attempt cap within a ROLLING WINDOW so a public demo never locks up
// permanently (it self-heals); the server also rate-limits per client IP.
const WINDOW_MS = 10 * 60 * 1000;
const ORDER_MAX = 150;
const orderHits = new Map();

async function handleVerify(body) {
    const { order_id, txid, proof } = body || {};
    const order = ORDERS.get(order_id);
    if (!order) return { code: 404, body: { error: 'unknown order' } };

    const now = Date.now();
    const hits = (orderHits.get(order_id) || []).filter(t => now - t < WINDOW_MS);
    hits.push(now);
    orderHits.set(order_id, hits);
    if (hits.length > ORDER_MAX) return { code: 429, body: { error: 'demo is busy — try again in a few minutes' } };

    const result = await verifyPayment({
        txid, proof,
        address: order.address,
        amount: order.amount_xmr,
        nodes: NODES,
        networkType: NETWORK,
        minConfirmations: 1,
        quorum: Number(process.env.XMR_QUORUM || 2),   // two stagenet nodes must agree
    });
    return { code: 200, body: result };
}

module.exports = { handleVerify };
