// SSE push (instant detection) — integration over REAL http, no monero-ts. wires
// the same onUpdate/onPaid → pushOrder path the reference agent uses, mounts the
// /order/:id/stream handler, and drives a real EventSource-style client: connect →
// initial snapshot, then a paying tick → a pushed `paid` event. proves the push
// contract end to end (the headline auto-detection UX) at the HTTP layer.
//   node test/agent-sse.test.js

const http = require('http');
const { createPaymentAgent } = require('../src/agent');
const { summarizeTransfers } = require('../src/watch');
const { xmrToPico } = require('../src/verify');

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { (c ? pass++ : fail++); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`); };

function mockScanner() {
    let idx = 0; const rowsByIndex = new Map();
    const self = {
        rowsByIndex, syncs: 0,
        async sync() { self.syncs++; },
        async newSubaddress() { const i = ++idx; return { address: `sub_${i}`, index: i, atHeight: 1000 + i }; },
        async addressAt(i) { return `sub_${i}`; },
        async checkOrder({ subaddressIndex, amount, minConfirmations = 1 }) {
            return summarizeTransfers(rowsByIndex.get(subaddressIndex) || [], xmrToPico(amount), minConfirmations);
        },
    };
    return self;
}
const row = (amountPico, confs = 10) => ({ txid: 'tx_' + amountPico, amountPico: BigInt(amountPico), confirmations: confs, inPool: false, locked: false });

// a minimal SSE client: collects `data:` payloads as they stream in.
function sseClient(url) {
    const events = [];
    const req = http.get(url, { headers: { Accept: 'text/event-stream' } }, (res) => {
        res.setEncoding('utf8'); let buf = '';
        res.on('data', (c) => {
            buf += c; let i;
            while ((i = buf.indexOf('\n\n')) >= 0) {
                const frame = buf.slice(0, i); buf = buf.slice(i + 2);
                const line = frame.split('\n').find(l => l.startsWith('data:'));
                if (line) { try { events.push(JSON.parse(line.slice(5).trim())); } catch (e) {} }
            }
        });
    });
    return { events, close: () => req.destroy() };
}
const wait = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    const ms = mockScanner();
    const sseClients = new Map();
    async function pushOrder(id) {
        const set = sseClients.get(id); if (!set || !set.size) return;
        const r = agent.get(id); if (!r) return;
        const body = JSON.stringify({ id: r.id, paid: r.paid, status: r.status, confirmations: r.confirmations, receivedXmr: r.receivedXmr });
        for (const res of set) { try { res.write(`data: ${body}\n\n`); } catch (e) {} }
    }
    const agent = createPaymentAgent({
        scanner: ms, minConfirmations: 1, pollMs: 1e9,   // drive ticks manually
        onUpdate: (o) => pushOrder(o.id),
        onPaid: (o) => pushOrder(o.id),
    });
    agent.start();

    const server = http.createServer((req, res) => {
        const sm = req.url.match(/^\/order\/([^/]+)\/stream$/);
        if (sm) {
            const id = decodeURIComponent(sm[1]);
            if (!agent.get(id)) { res.writeHead(404); return res.end(); }
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
            res.write('retry: 3000\n\n');
            const r0 = agent.get(id);
            res.write(`data: ${JSON.stringify({ id: r0.id, paid: r0.paid, status: r0.status })}\n\n`);
            let set = sseClients.get(id); if (!set) { set = new Set(); sseClients.set(id, set); }
            set.add(res);
            req.on('close', () => { const s = sseClients.get(id); if (s) { s.delete(res); if (!s.size) sseClients.delete(id); } });
            return;
        }
        res.writeHead(404); res.end();
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    const order = await agent.createOrder({ amount: '0.1', id: 'sse1' });
    const c = sseClient(`http://127.0.0.1:${port}/order/sse1/stream`);
    await wait(50);
    ok('stream sends an initial snapshot on connect', c.events.length >= 1 && c.events[0].id === 'sse1');
    ok('server registered the client', sseClients.get('sse1') && sseClients.get('sse1').size === 1);

    // a partial payment lands → onUpdate → push (not paid yet)
    ms.rowsByIndex.set(order.index, [row(xmrToPico('0.04'))]);
    await agent.tick();
    await wait(40);
    const partial = c.events.find(e => e.status === 'partial');
    ok('a partial payment is PUSHED to the stream', !!partial, partial ? partial.status : 'none');

    // the rest lands → paid → push paid INSTANTLY
    ms.rowsByIndex.set(order.index, [row(xmrToPico('0.1'))]);
    const n0 = c.events.length;
    await agent.tick();
    await wait(40);
    const paid = c.events.slice(n0).find(e => e.paid === true);
    ok('the PAID transition is pushed instantly over SSE', !!paid, paid ? 'paid:true received' : 'none');

    c.close();
    await wait(30);
    ok('client disconnect cleans up the server registry', !sseClients.get('sse1'));

    agent.stop(); server.close();
    console.log(`\n${fail === 0 ? 'ALL GREEN' : 'FAILED'}  ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('sse test error:', e); process.exit(2); });
