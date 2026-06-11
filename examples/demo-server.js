// local demo of the full sovereign stack: serves the widget (single file, no
// CDN) + a demo page, and mounts a REAL verify endpoint that checks proofs
// against the stagenet chain. this is exactly what a merchant would run as a
// serverless function — here as a tiny http server for local testing.
//
//   NODE_PATH=~/Documents/goxmr-landing/server/node_modules node examples/demo-server.js

const http = require('http');
const fs = require('fs');
const path = require('path');
const { verifyPayment } = require('../src/verify');
const { signConfig, generateSigningKey } = require('../src/config');

const PORT = 8771;

// the demo verifies against a funded stagenet wallet. point XMRPAY_DEMO_INFO
// at a json file with { node, primaryAddress, orderSubaddress, restoreHeight }
// (see test/gen-proof.js for how the maintainer harness produces one).
const POC_INFO = process.env.XMRPAY_DEMO_INFO || path.join(__dirname, 'demo-info.json');
let info;
try {
    info = JSON.parse(fs.readFileSync(POC_INFO, 'utf8'));
} catch {
    console.error(`demo needs a stagenet wallet info file at ${POC_INFO}`);
    console.error('set XMRPAY_DEMO_INFO=/path/to/info.json — it must contain');
    console.error('{ node, primaryAddress, orderSubaddress, restoreHeight } for a funded stagenet wallet.');
    process.exit(1);
}
const NODES = [info.node, 'http://node.monerodevs.org:38089', 'http://node2.monerodevs.org:38089'];

// in production you keep this key OFF the web server and sign configs offline.
// here we generate one per boot just to demo the signed flow end to end.
const signer = generateSigningKey();
const signedEnv = signConfig({ address: info.orderSubaddress, amount: '0.1', networkType: 'stagenet' }, signer.privateKey);
const SIGNED = Buffer.from(JSON.stringify(signedEnv)).toString('base64');
const tampered = JSON.parse(JSON.stringify(signedEnv));
tampered.config.address = info.primaryAddress; // swap the address, keep the old signature
const SIGNED_BAD = Buffer.from(JSON.stringify(tampered)).toString('base64');
const FP = signedEnv.fingerprint;

// stand-in for the merchant's orders table. ord_demo expects the real faucet
// payment that sits on stagenet (0.1 XMR to the order subaddress).
const ORDERS = new Map([
    ['ord_demo', { address: info.orderSubaddress, amount_xmr: '0.1', status: 'pending', tx_hash: null }],
    // second order with the same address+amount — exists to DEMO the replay
    // defense: pay ord_demo, then submit the same proof here → rejected.
    ['ord_demo2', { address: info.orderSubaddress, amount_xmr: '0.1', status: 'pending', tx_hash: null }],
    ['ord_demo3', { address: info.orderSubaddress, amount_xmr: '0.1', status: 'pending', tx_hash: null }],
]);

const send = (res, code, type, body) => { res.writeHead(code, { 'Content-Type': type }); res.end(body); };
const json = (res, code, obj) => send(res, code, 'application/json', JSON.stringify(obj));
const file = (res, p, type) => {
    try { send(res, 200, type, fs.readFileSync(p)); }
    catch { send(res, 404, 'text/plain', 'not found: ' + p); }
};

http.createServer(async (req, res) => {
    const url = req.url.split('?')[0];

    if (req.method === 'GET') {
        if (url === '/' ) {
            let html = fs.readFileSync(path.join(__dirname, 'demo.html'), 'utf8');
            html = html.replace(/{{SUB}}/g, info.orderSubaddress).replace(/{{PRIMARY}}/g, info.primaryAddress)
                .replace(/{{SIGNED_BAD}}/g, SIGNED_BAD).replace(/{{SIGNED}}/g, SIGNED).replace(/{{FP}}/g, FP);
            return send(res, 200, 'text/html; charset=utf-8', html);
        }
        if (url === '/widget/xmr-pay.js') return file(res, path.join(__dirname, '../widget/xmr-pay.js'), 'application/javascript; charset=utf-8');
        if (url === '/pay-link') return file(res, path.join(__dirname, 'pay-link.html'), 'text/html; charset=utf-8');
        if (url === '/demo-proof.txt') return file(res, path.join(__dirname, 'demo-proof.txt'), 'text/plain; charset=utf-8');
        return send(res, 404, 'text/plain', 'not found');
    }

    if (req.method === 'POST' && url === '/api/verify-payment') {
        let raw = '';
        req.on('data', c => { raw += c; if (raw.length > 65536) req.destroy(); });
        req.on('end', async () => {
            let body;
            try { body = JSON.parse(raw); } catch { return json(res, 400, { error: 'bad json' }); }
            const { order_id, txid, proof } = body || {};

            // cheap gates before any node rpc — the whole anti-spam story
            const order = ORDERS.get(order_id);
            if (!order) return json(res, 404, { error: 'unknown order' });
            if (order.status === 'paid') return json(res, 200, { paid: true, status: 'paid', reason: 'already confirmed', txid: order.tx_hash });

            console.log(`[verify] order=${order_id} txid=${String(txid).slice(0, 16)}…`);
            const result = await verifyPayment({
                txid, proof,
                address: order.address,
                amount: order.amount_xmr,
                nodes: NODES,
                networkType: 'stagenet',
                minConfirmations: 1,
                alreadyUsed: async (id) => [...ORDERS.values()].some(o => o.tx_hash === id),
            });
            if (result.paid) {
                // claim the txid in the same synchronous tick as the check —
                // with a real database, use a UNIQUE constraint on tx_hash.
                if ([...ORDERS.values()].some(o => o.tx_hash === result.txid)) {
                    console.log(`[verify] order=${order_id} → REPLAY blocked (txid already claimed)`);
                    return json(res, 200, { ...result, paid: false, status: 'replay', reason: 'this txid was already used to pay another order' });
                }
                order.status = 'paid'; order.tx_hash = result.txid;
                console.log(`[verify] order=${order_id} → PAID (${result.confirmations} confs)`);
            }
            else console.log(`[verify] order=${order_id} → ${result.status}: ${result.reason}`);
            return json(res, 200, result);
        });
        return;
    }

    send(res, 405, 'text/plain', 'method not allowed');
}).listen(PORT, '127.0.0.1', () => {
    console.log(`demo up: http://localhost:${PORT}/  (order ord_demo → 0.1 XMR to ${info.orderSubaddress.slice(0, 12)}…)`);
});
