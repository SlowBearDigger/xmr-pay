// durable fulfillment-webhook redelivery: a paid order whose merchant endpoint is
// briefly DOWN must NOT lose its notification — it retries until delivered, and a
// restart (reload from the persisted store) keeps retrying. mirrors the policy in
// examples/scanner-agent.js (deliverWebhook + the sweep), exercised against a real
// flaky HTTP server using the lib's own sendWebhook (HMAC + event_ts + retries).

const http = require('http');
const { sendWebhook, verifySignature } = require('../src/webhook');

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { (c ? pass++ : fail++); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`); };
const SECRET = 'whsec_test';

// a merchant endpoint that 503s its first `failFirst` requests, then 200s.
function flakyServer(failFirst) {
    const received = [];
    let hits = 0;
    const srv = http.createServer((req, res) => {
        let body = ''; req.on('data', c => body += c);
        req.on('end', () => {
            hits++;
            if (hits <= failFirst) { res.writeHead(503); return res.end('down'); }
            received.push({ body, sig: req.headers['x-xmr-pay-signature'] });
            res.writeHead(200); res.end('ok');
        });
    });
    return new Promise(r => srv.listen(0, () => r({ srv, url: `http://127.0.0.1:${srv.address().port}/hook`, received, hits: () => hits })));
}

// faithful copy of the example's deliverWebhook flag-transition (timing elided).
async function deliverWebhook(store, url, id) {
    const order = store.get(id);
    if (!order || !order.paid || order.webhookDelivered) return;   // idempotent: never re-send a delivered order
    order.webhookAttempts = (order.webhookAttempts || 0) + 1;
    const res = await sendWebhook(url, {
        event: 'order.paid', order_id: order.id, amount_xmr: order.amount, received_xmr: order.receivedXmr,
    }, { secret: SECRET, attempts: 1 });   // attempts:1 here so the SWEEP does the retrying, one try per round
    if (res && res.delivered) { order.webhookDelivered = true; }
    return res;
}

(async () => {
    // ── 1. endpoint down for 2 tries → eventual delivery, signed, idempotent ──
    const A = await flakyServer(2);
    const store = new Map([['o1', { id: 'o1', paid: true, amount: '0.02', receivedXmr: 0.02, webhookDelivered: false }]]);

    const r1 = await deliverWebhook(store, A.url, 'o1');   // onPaid's immediate try → fails (down)
    ok('first attempt while endpoint down → not delivered', r1 && r1.delivered === false && store.get('o1').webhookDelivered === false);

    // the sweep keeps re-attempting due orders until delivered
    let rounds = 0;
    while (store.get('o1').webhookDelivered === false && rounds < 10) { await deliverWebhook(store, A.url, 'o1'); rounds++; }
    ok('webhook is eventually delivered once the endpoint recovers', store.get('o1').webhookDelivered === true);
    ok('exactly one successful POST landed at the merchant', A.received.length === 1, `got ${A.received.length}`);

    const got = A.received[0];
    ok('delivered body is the order.paid event for o1', JSON.parse(got.body).event === 'order.paid' && JSON.parse(got.body).order_id === 'o1');
    ok('delivery is HMAC-signed with the shared secret', verifySignature(got.body, SECRET, got.sig));
    ok('body carries an event_ts (replay defence)', typeof JSON.parse(got.body).event_ts === 'number');

    // sweeping again is a no-op — a delivered order is never re-sent (idempotent)
    const before = A.hits();
    await deliverWebhook(store, A.url, 'o1');
    ok('a delivered order is never re-sent', A.hits() === before);
    A.srv.close();

    // ── 2. restart safety: a reloaded paid+undelivered order still gets delivered ──
    const B = await flakyServer(0);   // up immediately
    const persisted = JSON.parse(JSON.stringify([...store.values()]));   // simulate orders.json round-trip
    persisted[0].webhookDelivered = false;                                // it was pending when we "crashed"
    const reloaded = new Map(persisted.map(o => [o.id, o]));
    await deliverWebhook(reloaded, B.url, 'o1');
    ok('a reloaded undelivered order is delivered after restart', reloaded.get('o1').webhookDelivered === true && B.received.length === 1);
    B.srv.close();

    // ── 3. healthy endpoint → delivered on the first attempt ──
    const C = await flakyServer(0);
    const store3 = new Map([['o2', { id: 'o2', paid: true, amount: '0.01', receivedXmr: 0.01, webhookDelivered: false }]]);
    await deliverWebhook(store3, C.url, 'o2');
    ok('healthy endpoint → delivered first try', store3.get('o2').webhookDelivered === true && C.received.length === 1);
    C.srv.close();

    console.log(`\n${fail === 0 ? 'ALL GREEN' : 'FAILED'}  ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('redelivery test error:', e); process.exit(2); });
