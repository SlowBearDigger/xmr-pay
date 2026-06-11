// input gates of verifyPayment — the checks that reject before any node RPC.
// runs with plain `node` (no monero-ts, no network): verify.js loads monero-ts
// lazily and these paths return before it would ever be touched. fast guard
// against regressions in the cheap rejections.
//   node test/verify-gates.test.js

const { verifyPayment } = require('../src/verify');

const OK_TXID = 'a'.repeat(64);
const OK_KEY = 'b'.repeat(64);
const MAINNET_ADDR = '4' + '1'.repeat(94);   // shape-valid mainnet address
const NODES = ['http://127.0.0.1:1'];        // never contacted in these cases

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };

(async () => {
    const base = { txid: OK_TXID, proof: OK_KEY, address: MAINNET_ADDR, amount: '0.1', nodes: NODES };

    let r = await verifyPayment({ ...base, txid: 'nope' });
    ok('short txid → invalid', !r.paid && r.status === 'invalid');

    r = await verifyPayment({ ...base, txid: 'g'.repeat(64) });
    ok('non-hex txid → invalid', !r.paid && r.status === 'invalid');

    r = await verifyPayment({ ...base, address: 'not-an-address' });
    ok('bad address → invalid', !r.paid && r.status === 'invalid');

    r = await verifyPayment({ ...base, address: '8' + '1'.repeat(94), networkType: 'mainnet' });
    ok('subaddress (8…) is a valid mainnet target', r.status !== 'invalid' || !/address/.test(r.reason), r.reason);

    r = await verifyPayment({ ...base, amount: '0' });
    ok('amount 0 → invalid', !r.paid && r.status === 'invalid');

    r = await verifyPayment({ ...base, amount: '0.0000000000001' });   // 13 decimals
    ok('over-precise amount → invalid', !r.paid && r.status === 'invalid', r.reason);

    r = await verifyPayment({ ...base, nodes: [] });
    ok('no nodes → invalid', !r.paid && r.status === 'invalid');

    r = await verifyPayment({ ...base, proof: 'xyz' });
    ok('garbage proof → invalid', !r.paid && r.status === 'invalid');

    // the quorum-undercut gate Copilot flagged: more agreement requested than
    // nodes available must fail loudly, not silently fall back to one node.
    r = await verifyPayment({ ...base, quorum: 2 });
    ok('quorum 2 with 1 node → invalid (no silent downgrade)', !r.paid && r.status === 'invalid' && /quorum/.test(r.reason), r.reason);

    r = await verifyPayment({ ...base, quorum: 3, nodes: ['http://127.0.0.1:1', 'http://127.0.0.1:2'] });
    ok('quorum 3 with 2 nodes → invalid', !r.paid && /quorum/.test(r.reason), r.reason);

    // txid normalization is observable even on a rejection (replay store must
    // see one canonical form).
    r = await verifyPayment({ ...base, txid: OK_TXID.toUpperCase(), nodes: [] });
    ok('returned txid is lowercased', r.txid === OK_TXID);

    console.log(`\n${fail === 0 ? 'ALL GREEN' : 'FAILED'}  ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('gates test error:', e); process.exit(2); });
