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
    // 7: one partial payment toward a 0.100000004821 nonce order (→ exact shortfall)
    7: { in: [{ txid: '7'.repeat(64), amount: 50000004821, confirmations: 3, type: 'in', unlock_time: 0, locked: false }], pool: [] },
    // 8: TWO payments that sum to an exact nonce amount (the "second payment" case)
    8: { in: [
        { txid: '8'.repeat(64), amount: 50000000000, confirmations: 3, type: 'in', unlock_time: 0, locked: false },
        { txid: '9'.repeat(64), amount: 50000004821, confirmations: 3, type: 'in', unlock_time: 0, locked: false },
    ], pool: [] },
    // 9: a CONFIRMED payment the daemon flagged double_spend_seen — contested money.
    //    must be HELD (never credited) until the flag clears, even past minConf.
    9: { in: [{ txid: 'cd'.repeat(32), amount: 100000000000, confirmations: 8, type: 'in', unlock_time: 0, locked: false, double_spend_seen: true }], pool: [] },
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

    // the buyer-facing "send X more" in watch mode — exact, and the SECOND payment
    // is detected simply by summing transfers to the order's subaddress.
    r = await w.checkOrder({ subaddressIndex: 2, amount: '0.1' });
    ok('partial → exact shortfall (send 0.06 more)', !r.paid && r.shortfallXmr === '0.06', r.shortfallXmr);

    r = await w.checkOrder({ subaddressIndex: 3, amount: '0.1' });
    ok('second payment detected + summed → paid, shortfall 0', r.paid && r.shortfallXmr === '0', r.shortfallXmr);

    r = await w.checkOrder({ subaddressIndex: 7, amount: '0.100000004821' });
    ok('partial toward a NONCE order → exact shortfall 0.05', !r.paid && r.status === 'partial' && r.shortfallXmr === '0.05', r.shortfallXmr);

    r = await w.checkOrder({ subaddressIndex: 8, amount: '0.100000004821' });
    ok('two payments sum to an EXACT nonce amount → paid', r.paid && r.shortfallXmr === '0', `rec=${r.receivedXmr}`);

    r = await w.checkOrder({ subaddressIndex: 3, amount: '0.1', minConfirmations: 3 });
    ok('minConfirmations counts per transfer (2-conf half not counted yet)', !r.paid && r.status === 'mempool', r.reason);

    r = await w.checkOrder({ subaddressIndex: 4, amount: '0.1' });
    ok('pool-only → mempool', !r.paid && r.status === 'mempool');

    r = await w.checkOrder({ subaddressIndex: 5, amount: '0.1' });
    ok('time-locked outputs never count as paid', !r.paid && r.status === 'locked', r.reason);
    // but locked funds ARE on-chain, so the buyer owes nothing more — shortfall 0,
    // not the locked amount (else a top-up prompt would tell them to overpay).
    ok('locked funds count toward shortfall → owes 0, just waits', r.shortfallXmr === '0' && r.lockedXmr === 0.1, `short ${r.shortfallXmr} locked ${r.lockedXmr}`);

    r = await w.checkOrder({ subaddressIndex: 6, amount: '0.1' });
    ok('nothing yet → pending', !r.paid && r.status === 'pending');

    // double_spend_seen gate must be LIVE on the wallet-rpc transport (it was dead
    // before incoming() carried the flag — a contested tx would have been credited).
    r = await w.checkOrder({ subaddressIndex: 9, amount: '0.1' });
    ok('double_spend_seen confirmed tx → HELD, never paid', !r.paid && r.status === 'mempool', r.status);
    const rows9 = await w.incoming(9);
    ok('incoming() surfaces doubleSpendSeen so the gate can fire', !!rows9[0] && rows9[0].doubleSpendSeen === true);

    ok('height passthrough', (await w.height()) === 2135999);

    console.log(`\n${fail === 0 ? 'ALL GREEN' : 'FAILED'}  ${pass} passed, ${fail} failed`);
    server.close();
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('watch test error:', e); server.close(); process.exit(2); });
