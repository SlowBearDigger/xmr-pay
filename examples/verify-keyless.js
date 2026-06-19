// KEYLESS proof verifier — the shared "calculator" for proof mode.
//
// What it is: a STATELESS HTTP endpoint that, given a buyer's tx proof, answers
// "did this txid pay >= this amount to this address?" using ONLY public on-chain
// data (the proof + the tx). It holds NO view key, NO funds, and NO order state —
// so a SINGLE instance can safely serve every store, and anyone can run their own.
//
// Why it exists: WordPress / shared-host PHP can't run the Monero proof crypto
// (it needs monero-ts WASM in Node, or wallet-rpc). So the store's PHP keeps the
// orders and calls THIS to do the math. The store binds address+amount from its
// OWN order before calling — the buyer never gets to pick what's checked.
//
// vs. examples/serverless.js: that one is STATEFUL (it owns the orders + the
// replay check). This one is STATELESS on purpose — the caller (the WooCommerce
// plugin, your backend) owns the orders, the amount-nonce, and the txid dedup.
// It returns the txid so the caller can dedup; it is NOT the replay authority.
//
// Run it:  node examples/verify-keyless.js                 # standalone, host-Node
//   or deploy createVerifyHandler() to Vercel/Netlify/Workers-on-Node/etc.
//
// Trust model: keyless + reproducible + self-hostable. A caller trusts only that
// the math was done honestly — and can re-run it (the proof is kept) to audit. It
// never touches money, so a compromised verifier can lie about a single proof but
// can't move funds or leak a key.

const http = require('http');
let _verifyPayment;
function defaultVerify(opts) { if (!_verifyPayment) _verifyPayment = require('../src/verify').verifyPayment; return _verifyPayment(opts); }
const { isValidAddress, isValidTxid } = require('../src/verify');

// build a request handler. everything is injectable so it drops into any runtime
// (standalone http below, or a serverless function) and is unit-testable.
function createVerifyHandler({
    verify = defaultVerify,
    nodes,                                   // SERVER-chosen — never taken from the caller (no SSRF/amplifier)
    networkType = 'mainnet',
    quorum = 2,                              // independent nodes must agree; 1 if you run your own trusted node
    minConfirmations = 1,
    token = '',                              // optional Bearer gate (set for a store endpoint; open for a public tip one)
    corsOrigin = '*',                        // set to your exact store origin in production
    rlMax = 30, rlWindowMs = 60_000,         // per-IP fixed-window rate limit (in-memory = per-instance)
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
        // the caller may RAISE confirmations for a high-value order, never lower
        // the server floor (a buyer-influenced 0-conf would weaken the store).
        const minConf = Math.max(minConfirmations, Number.isFinite(+b.minConfirmations) ? +b.minConfirmations : 0);

        // cheap input gates BEFORE we ever touch a node — a bad request must not
        // become a node call (DoS hygiene) and the buyer gets a precise reason.
        if (!isValidTxid(txid)) return json(res, 400, { paid: false, status: 'invalid', reason: 'txid must be 64 hex chars' });
        if (!proof) return json(res, 400, { paid: false, status: 'invalid', reason: 'proof is required' });
        if (!isValidAddress(address, networkType)) return json(res, 400, { paid: false, status: 'invalid', reason: `address is not a valid ${networkType} address` });
        if (!amount) return json(res, 400, { paid: false, status: 'invalid', reason: 'amount is required' });

        try {
            const r = await verify({
                txid, proof, address, amount,
                nodes, networkType, minConfirmations: minConf, quorum: want,
                // NO alreadyUsed here — replay/dedup is the CALLER's job (it owns
                // the orders). we are a pure calculator; we just report the txid.
            });
            return json(res, 200, {
                paid: !!r.paid, status: r.status, reason: r.reason,
                receivedXmr: r.receivedXmr, confirmations: r.confirmations,
                overpaid: !!r.overpaid, overpaidXmr: r.overpaidXmr || '0',
                txid: r.txid || txid, nodesAgreed: r.nodesAgreed,
            });
        } catch (e) {
            // a thrown error here is a node/transport problem (verifyPayment folds
            // semantic failures into status:'invalid'), so it's retryable.
            return json(res, 502, { paid: false, status: 'node-error', reason: (e && e.message) || 'verification failed' });
        }
    };
}

module.exports = { createVerifyHandler };

// ── standalone server (host-Node, or `node verify-keyless.js`) ──────────────
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
