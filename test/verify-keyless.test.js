// keyless stateless verifier (examples/verify-keyless.js) — HTTP contract over a
// real server with an INJECTED verify (no monero-ts/nodes needed). asserts the
// input gates, token/rate-limit, the server-chosen-nodes rule (the caller can NOT
// point us at its own nodes), confirmations-floor, and the pure pass-through shape.
//   node test/verify-keyless.test.js

const http = require('http');
const { createVerifyHandler } = require('../examples/verify-keyless');

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { (c ? pass++ : fail++); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`); };

const TXID = 'a'.repeat(64);
// a real stagenet address (valid shape) so isValidAddress passes in the gates
const ADDR = '74ZW4FgV1eTVNP77KZRetwNQc8DCBy62kiFQhJjqpV6wBeu5Up9iUj3e8tk65PLVeqa1We17DK1YWVUJdysYPXM8EUoGKDM';

function serve(handler) {
    const srv = http.createServer((req, res) => {
        let raw = ''; req.on('data', c => raw += c);
        req.on('end', () => { let b; try { b = JSON.parse(raw || '{}'); } catch { b = {}; } handler(req, res, req.method === 'OPTIONS' ? null : b); });
    });
    return srv;
}
function post(port, body, headers = {}) {
    return new Promise((resolve) => {
        const data = JSON.stringify(body);
        const req = http.request({ port, host: '127.0.0.1', method: 'POST', path: '/verify', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers } }, (res) => {
            let raw = ''; res.on('data', c => raw += c);
            res.on('end', () => { let j; try { j = JSON.parse(raw || '{}'); } catch { j = {}; } resolve({ status: res.statusCode, body: j }); });
        });
        req.end(data);
    });
}
const listen = (srv) => new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

(async () => {
    // capture what the handler passes to verifyPayment
    let seen = null;
    const fakeVerify = async (opts) => { seen = opts; return { paid: true, status: 'ok', reason: '', receivedXmr: 0.05, confirmations: 3, overpaid: false, overpaidXmr: '0', txid: opts.txid, nodesAgreed: 2 }; };
    const NODES = ['https://node-a:18081', 'https://node-b:18081'];

    // happy path
    {
        const h = createVerifyHandler({ verify: fakeVerify, nodes: NODES, networkType: 'stagenet', quorum: 2, minConfirmations: 1 });
        const srv = serve(h); const port = await listen(srv);
        const r = await post(port, { txid: TXID, proof: 'InProofV2xxx', address: ADDR, amount: '0.05' });
        ok('happy: 200 + paid pass-through', r.status === 200 && r.body.paid === true && r.body.status === 'ok' && r.body.txid === TXID);
        ok('happy: returns confirmations + nodesAgreed', r.body.confirmations === 3 && r.body.nodesAgreed === 2);
        ok('SERVER nodes used, not caller-supplied', JSON.stringify(seen.nodes) === JSON.stringify(NODES) && seen.networkType === 'stagenet' && seen.quorum === 2);
        ok('NO alreadyUsed passed (dedup is the caller\'s job)', seen.alreadyUsed === undefined);
        srv.close();
    }

    // caller cannot point us at its own nodes / lower the network
    {
        seen = null;
        const h = createVerifyHandler({ verify: fakeVerify, nodes: NODES, networkType: 'stagenet', quorum: 2 });
        const srv = serve(h); const port = await listen(srv);
        await post(port, { txid: TXID, proof: 'p', address: ADDR, amount: '0.05', nodes: ['http://evil:1'], networkType: 'mainnet', quorum: 1 });
        ok('caller-supplied nodes/network/quorum are IGNORED', JSON.stringify(seen.nodes) === JSON.stringify(NODES) && seen.networkType === 'stagenet' && seen.quorum === 2);
        srv.close();
    }

    // confirmations floor: caller may RAISE, never lower
    {
        seen = null;
        const h = createVerifyHandler({ verify: fakeVerify, nodes: NODES, networkType: 'stagenet', minConfirmations: 1 });
        const srv = serve(h); const port = await listen(srv);
        await post(port, { txid: TXID, proof: 'p', address: ADDR, amount: '0.05', minConfirmations: 10 });
        ok('caller can RAISE minConfirmations (1 → 10)', seen.minConfirmations === 10);
        await post(port, { txid: TXID, proof: 'p', address: ADDR, amount: '0.05', minConfirmations: 0 });
        ok('caller can NOT lower below the server floor (0 → 1)', seen.minConfirmations === 1);
        srv.close();
    }

    // input gates — never reach the verifier
    {
        let called = false;
        const h = createVerifyHandler({ verify: async () => { called = true; return {}; }, nodes: NODES, networkType: 'stagenet' });
        const srv = serve(h); const port = await listen(srv);
        const bad = [
            ['short txid', { txid: 'abc', proof: 'p', address: ADDR, amount: '0.05' }],
            ['missing proof', { txid: TXID, proof: '', address: ADDR, amount: '0.05' }],
            ['bad address for network', { txid: TXID, proof: 'p', address: 'not-an-address', amount: '0.05' }],
            ['missing amount', { txid: TXID, proof: 'p', address: ADDR }],
        ];
        let allGated = true;
        for (const [name, body] of bad) { const r = await post(port, body); if (!(r.status === 400 && r.body.status === 'invalid')) { allGated = false; console.log('   gate miss:', name, r.status); } }
        ok('all malformed requests are gated 400 (no node call)', allGated && called === false);
        srv.close();
    }

    // token gate
    {
        const h = createVerifyHandler({ verify: fakeVerify, nodes: NODES, networkType: 'stagenet', token: 'sekret' });
        const srv = serve(h); const port = await listen(srv);
        const r1 = await post(port, { txid: TXID, proof: 'p', address: ADDR, amount: '0.05' });
        ok('no token → 401', r1.status === 401);
        const r2 = await post(port, { txid: TXID, proof: 'p', address: ADDR, amount: '0.05' }, { Authorization: 'Bearer sekret' });
        ok('right token → 200', r2.status === 200);
        srv.close();
    }

    // rate limit
    {
        const h = createVerifyHandler({ verify: fakeVerify, nodes: NODES, networkType: 'stagenet', rlMax: 3 });
        const srv = serve(h); const port = await listen(srv);
        let last;
        for (let i = 0; i < 5; i++) last = await post(port, { txid: TXID, proof: 'p', address: ADDR, amount: '0.05' });
        ok('over the per-IP limit → 429', last.status === 429);
        srv.close();
    }

    // misconfig: nodes < quorum throws at construction
    {
        let threw = false;
        try { createVerifyHandler({ verify: fakeVerify, nodes: ['http://only-one'], quorum: 2 }); } catch { threw = true; }
        ok('construction rejects nodes < quorum', threw);
    }

    console.log(`\n${fail === 0 ? 'ALL GREEN' : 'FAILED'}  ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('verify-keyless test error:', e); process.exit(2); });
