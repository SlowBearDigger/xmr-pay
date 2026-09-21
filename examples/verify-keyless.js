// Verify buyer payment proofs against configured nodes without a merchant key.
const http = require('http');
let _verifyPayment;
function defaultVerify(opts) { if (!_verifyPayment) _verifyPayment = require('../src/verify').verifyPayment; return _verifyPayment(opts); }
const { isValidAddress, isValidTxid } = require('../src/verify');

function createVerifyHandler({
    verify = defaultVerify,
    nodes,
    networkType = 'mainnet',
    quorum = 2,
    minConfirmations = 1,
    token = '',
    corsOrigin = '*',
    rlMax = 30, rlWindowMs = 60_000,
} = {}) {
    if (!Array.isArray(nodes) || nodes.length === 0) throw new Error('createVerifyHandler: nodes[] is required (your trusted monerod URLs)');
    const want = Math.max(1, quorum | 0);
    if (nodes.length < want) throw new Error(`quorum ${want} needs at least ${want} nodes, but ${nodes.length} provided`);

    const RL = new Map();
    function rateLimited(req) {
        const ip = String(req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || 'unknown').split(',')[0].trim();
        const now = Date.now(), e = RL.get(ip);
        if (!e || now > e.resetAt) { RL.set(ip, { n: 1, resetAt: now + rlWindowMs }); return false; }
        return ++e.n > rlMax;
    }
    const json = (res, code, body) => {
        res.setHeader('Access-Control-Allow-Origin', corsOrigin);
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.setHeader('Content-Type', 'application/json');
        res.statusCode = code;
        res.end(JSON.stringify(body));
    };

    return async function handler(req, res, parsedBody) {
        if (req.method === 'OPTIONS') { json(res, 204, {}); return; }
        if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
        if (token && req.headers.authorization !== `Bearer ${token}`) return json(res, 401, { error: 'unauthorized' });
        if (rateLimited(req)) return json(res, 429, { error: 'rate limited — slow down' });

        const b = parsedBody || {};
        const txid = typeof b.txid === 'string' ? b.txid.trim() : '';
        const proof = typeof b.proof === 'string' ? b.proof.trim() : '';
        const address = typeof b.address === 'string' ? b.address.trim() : '';
        const amount = b.amount != null ? String(b.amount) : '';

        const minConf = Math.max(minConfirmations, Number.isFinite(+b.minConfirmations) ? +b.minConfirmations : 0);

        if (!isValidTxid(txid)) return json(res, 400, { paid: false, status: 'invalid', reason: 'txid must be 64 hex chars' });
        if (!proof) return json(res, 400, { paid: false, status: 'invalid', reason: 'proof is required' });
        if (!isValidAddress(address, networkType)) return json(res, 400, { paid: false, status: 'invalid', reason: `address is not a valid ${networkType} address` });
        if (!amount) return json(res, 400, { paid: false, status: 'invalid', reason: 'amount is required' });

        try {
            const r = await verify({
                txid, proof, address, amount,
                nodes, networkType, minConfirmations: minConf, quorum: want,

            });
            return json(res, 200, {
                paid: !!r.paid, status: r.status, reason: r.reason,
                receivedXmr: r.receivedXmr, confirmations: r.confirmations,
                overpaid: !!r.overpaid, overpaidXmr: r.overpaidXmr || '0',
                txid: r.txid || txid, nodesAgreed: r.nodesAgreed,
            });
        } catch (e) {

            return json(res, 502, { paid: false, status: 'node-error', reason: (e && e.message) || 'verification failed' });
        }
    };
}

module.exports = { createVerifyHandler };

if (require.main === module) {
    const env = process.env;
    const nodes = (env.XMR_NODES || 'https://xmr-node.cakewallet.com:18081,https://node.sethforprivacy.com').split(',').map(s => s.trim()).filter(Boolean);
    const handler = createVerifyHandler({
        nodes,
        networkType: env.XMR_NETWORK || 'mainnet',
        quorum: Number(env.XMR_QUORUM || 2),
        minConfirmations: Number(env.XMR_MIN_CONFIRMATIONS || 1),
        token: env.VERIFY_TOKEN || '',
        corsOrigin: env.CORS_ORIGIN || '*',
        rlMax: Number(env.VERIFY_RL_MAX || 30),
    });
    const PORT = Number(env.PORT || 8795), BIND = env.BIND || '127.0.0.1';
    http.createServer((req, res) => {
        const url = (req.url || '').split('?')[0];
        if (url === '/healthz') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, keyless: true, network: env.XMR_NETWORK || 'mainnet', nodes: nodes.length })); return; }
        if (url !== '/verify') { res.statusCode = 404; res.end('not found'); return; }
        if (req.method === 'OPTIONS') return handler(req, res, null);
        let raw = ''; req.on('data', c => { raw += c; if (raw.length > 8192) req.destroy(); });
        req.on('end', () => { let body; try { body = JSON.parse(raw || '{}'); } catch { res.statusCode = 400; res.setHeader('Content-Type', 'application/json'); return res.end('{"error":"bad json"}'); } handler(req, res, body); });
    }).listen(PORT, BIND, () => console.log(`keyless verifier on http://${BIND}:${PORT}/verify  (network ${env.XMR_NETWORK || 'mainnet'}, ${nodes.length} nodes, quorum ${env.XMR_QUORUM || 2})`));
}
