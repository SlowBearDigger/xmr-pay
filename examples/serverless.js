// Verify payment proofs in a serverless endpoint.
const { verifyPayment } = require('xmr-pay');
const { sendWebhook } = require('xmr-pay/webhook');

const NODES = (process.env.XMR_NODES ||
    'https://xmr-node.cakewallet.com:18081,https://node.sethforprivacy.com').split(',');

const QUORUM = Number(process.env.XMR_QUORUM || 2);

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || '';

const RL = new Map();
const RL_MAX = Number(process.env.VERIFY_RL_MAX || 30), RL_WINDOW_MS = 60_000;
function rateLimited(req) {
    const ip = String(req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || 'unknown').split(',')[0].trim();
    const now = Date.now(), e = RL.get(ip);
    if (!e || now > e.resetAt) { RL.set(ip, { n: 1, resetAt: now + RL_WINDOW_MS }); return false; }
    return ++e.n > RL_MAX;
}

const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
function cors(res) {
    res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

const ORDERS = new Map([
    ['ord_123', { address: process.env.XMR_ADDRESS, amount_xmr: '0.050000000817', status: 'pending', tx_hash: null }],
]);

module.exports = async function handler(req, res) {
    cors(res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
    if (VERIFY_TOKEN && req.headers.authorization !== `Bearer ${VERIFY_TOKEN}`) return res.status(401).json({ error: 'unauthorized' });
    if (rateLimited(req)) return res.status(429).json({ error: 'rate limited — slow down' });
    const { order_id, txid, proof } = req.body || {};

    const order = ORDERS.get(order_id);
    if (!order) return res.status(404).json({ error: 'unknown order' });
    if (order.status === 'paid') return res.json({ paid: true, status: 'paid', reason: 'already confirmed' });

    const result = await verifyPayment({
        txid,
        proof,
        address: order.address,
        amount: order.amount_xmr,
        nodes: NODES,
        minConfirmations: 1,
        quorum: QUORUM,
        alreadyUsed: async (id) =>
            [...ORDERS.values()].some(o => o.tx_hash === id),
    });

    if (result.paid) {

        if ([...ORDERS.values()].some(o => o.tx_hash === result.txid)) {
            return res.json({ ...result, paid: false, status: 'replay', reason: 'this txid was already used to pay another order' });
        }
        order.status = 'paid';
        order.tx_hash = result.txid;

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

    const retryable = result.status === 'node-error' || result.status === 'node-disagreement';
    return res.status(retryable ? 503 : 200).json(result);
};
