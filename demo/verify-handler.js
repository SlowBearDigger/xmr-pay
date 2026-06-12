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

// light per-order attempt cap so the public endpoint can't be hammered for free
// node RPCs; a real deployment uses its platform's rate limiter (see DEPLOY.md).
const attempts = new Map();

async function handleVerify(body) {
    const { order_id, txid, proof } = body || {};
    const order = ORDERS.get(order_id);
    if (!order) return { code: 404, body: { error: 'unknown order' } };

    const n = (attempts.get(order_id) || 0) + 1;
    attempts.set(order_id, n);
    if (n > 60) return { code: 429, body: { error: 'too many attempts — demo cooling down' } };

    const result = await verifyPayment({
        txid, proof,
        address: order.address,
        amount: order.amount_xmr,
        nodes: NODES,
        networkType: NETWORK,
        minConfirmations: 1,
    });
    return { code: 200, body: result };
}

module.exports = { handleVerify };
