// watch mode against a mock wallet-rpc — offline, exercises the full http path.
//   node test/watch.test.js

const http = require('http');
const { createWatcher } = require('../src/watch');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };

// scenario is selected by the subaddress index the test asks about
const TRANSFERS = {
    1: { in: [{ txid: 'a'.repeat(64), amount: 100000000000, confirmations: 3, type: 'in', unlock_time: 0, locked: false }], pool: [] },
    2: { in: [{ txid: 'b'.repeat(64), amount: 40000000000, confirmations: 5, type: 'in', unlock_time: 0, locked: false }], pool: [] },
    3: { in: [
        { txid: 'c'.repeat(64), amount: 60000000000, confirmations: 4, type: 'in', unlock_time: 0, locked: false },
        { txid: 'd'.repeat(64), amount: 40000000000, confirmations: 2, type: 'in', unlock_time: 0, locked: false },
    ], pool: [] },
    4: { in: [], pool: [{ txid: 'e'.repeat(64), amount: 100000000000, confirmations: 0, type: 'pool', unlock_time: 0, locked: false }] },
    5: { in: [{ txid: 'f'.repeat(64), amount: 100000000000, confirmations: 20, type: 'in', unlock_time: 3000000, locked: true }], pool: [] },
    6: { in: [], pool: [] },
};

const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => {
        const { method, params, id } = JSON.parse(raw);
        let result;
        if (method === 'create_address') result = { address: '78' + 'x'.repeat(93), address_index: 7 };
        else if (method === 'get_transfers') result = TRANSFERS[params.subaddr_indices[0]] || { in: [], pool: [] };
        else if (method === 'get_height') result = { height: 2135999 };
        else { res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { message: 'unknown method' } })); return; }
        res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    });
});

(async () => {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const w = createWatcher({ url: `http://127.0.0.1:${server.address().port}` });

    const sub = await w.newSubaddress('order 42');
    ok('newSubaddress returns address + index', sub.index === 7 && sub.address.startsWith('78'));

    let r = await w.checkOrder({ subaddressIndex: 1, amount: '0.1' });
    ok('exact payment → paid', r.paid && r.status === 'paid' && r.receivedXmr === 0.1);

    r = await w.checkOrder({ subaddressIndex: 2, amount: '0.1' });
    ok('0.04 of 0.1 → partial', !r.paid && r.status === 'partial', `${r.receivedXmr}/${r.requiredXmr}`);

    r = await w.checkOrder({ subaddressIndex: 3, amount: '0.1' });
    ok('two transfers sum to paid (installments work)', r.paid && r.receivedXmr === 0.1 && r.txids.length === 2);

    r = await w.checkOrder({ subaddressIndex: 3, amount: '0.1', minConfirmations: 3 });
    ok('minConfirmations counts per transfer (2-conf half not counted yet)', !r.paid && r.status === 'mempool', r.reason);

    r = await w.checkOrder({ subaddressIndex: 4, amount: '0.1' });
    ok('pool-only → mempool', !r.paid && r.status === 'mempool');

    r = await w.checkOrder({ subaddressIndex: 5, amount: '0.1' });
    ok('time-locked outputs never count as paid', !r.paid && r.status === 'locked', r.reason);

    r = await w.checkOrder({ subaddressIndex: 6, amount: '0.1' });
    ok('nothing yet → pending', !r.paid && r.status === 'pending');

    ok('height passthrough', (await w.height()) === 2135999);

    console.log(`\n${fail === 0 ? 'ALL GREEN' : 'FAILED'}  ${pass} passed, ${fail} failed`);
    server.close();
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('watch test error:', e); server.close(); process.exit(2); });
