// fulfillment webhooks against a mock receiver — offline, full http path.
//   node test/webhook.test.js

const http = require('http');
const { sendWebhook, signPayload, verifySignature } = require('../src/webhook');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };

let hits = 0;
let seen = null;
const server = http.createServer((req, res) => {
    hits++;
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => {
        seen = { body: raw, sig: req.headers['x-xmr-pay-signature'] };
        // fail the first attempt so the retry path gets exercised
        if (hits === 1) { res.writeHead(500); res.end(); return; }
        res.writeHead(200); res.end('ok');
    });
});

(async () => {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}/hook`;
    const payload = { event: 'order.paid', order_id: 'ord_1', txid: 'a'.repeat(64) };

    const r = await sendWebhook(url, payload, { secret: 'whsec_test', attempts: 3 });
    ok('delivers after a 500 (retry works)', r.delivered === true && r.attempt === 2, JSON.stringify(r));
    ok('payload arrives intact', seen && JSON.parse(seen.body).order_id === 'ord_1');
    ok('signature header present', !!(seen && seen.sig && seen.sig.startsWith('sha256=')));
    ok('receiver verifies with the right secret', verifySignature(seen.body, 'whsec_test', seen.sig));
    ok('receiver rejects with the wrong secret', !verifySignature(seen.body, 'whsec_wrong', seen.sig));
    ok('receiver rejects a tampered body', !verifySignature(seen.body.replace('ord_1', 'ord_2'), 'whsec_test', seen.sig));
    ok('signPayload is deterministic', signPayload('{"a":1}', 's') === signPayload('{"a":1}', 's'));

    // unreachable target reports failure instead of throwing
    const dead = await sendWebhook('http://127.0.0.1:1/hook', payload, { attempts: 1, timeoutMs: 1500 });
    ok('unreachable url → delivered:false, no throw', dead.delivered === false);

    console.log(`\n${fail === 0 ? 'ALL GREEN' : 'FAILED'}  ${pass} passed, ${fail} failed`);
    server.close();
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('webhook test error:', e); server.close(); process.exit(2); });
