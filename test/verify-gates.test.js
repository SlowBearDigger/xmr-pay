// input gates of verifyPayment — the checks that reject before any node RPC.
// runs with plain `node` (no monero-ts, no network): verify.js loads monero-ts
// lazily and these paths return before it would ever be touched. fast guard
// against regressions in the cheap rejections.
//   node test/verify-gates.test.js

const { verifyPayment, xmrToPico, fetchUnlockTime } = require('../src/verify');

const OK_TXID = 'a'.repeat(64);
const OK_KEY = 'b'.repeat(64);
const MAINNET_ADDR = '4' + '1'.repeat(94);   // shape-valid mainnet address
const NODES = ['http://127.0.0.1:1'];        // never contacted in these cases

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };

// amount → piconero, the money math that must never drift
ok('xmrToPico string is exact', xmrToPico('0.05') === 50000000000n);
ok('xmrToPico keeps a 12-decimal nonce', xmrToPico('0.050000000817') === 50000000817n);
ok('xmrToPico whole number', xmrToPico('5') === 5000000000000n && xmrToPico(5) === 5000000000000n);
ok('xmrToPico small NUMBER (was rejected as "1e-8")', xmrToPico(0.00000001) === 10000n);
ok('xmrToPico zero', xmrToPico(0) === 0n && xmrToPico('0') === 0n);
try { xmrToPico('0.0000000000001'); ok('xmrToPico rejects 13 decimals', false); }
catch { ok('xmrToPico rejects 13-decimal string', true); }
try { xmrToPico('-1'); ok('xmrToPico rejects negative', false); } catch { ok('xmrToPico rejects negative', true); }

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

    // ---- C-1: the time-lock gate must honor the SAME quorum as the proof step.
    // a single lying node reporting unlock_time=0 for a frozen tx must NOT flip
    // locked -> paid. these mock /get_transactions per node and inject
    // disagreeing unlock_time answers (the report's "inject disagreeing unlock").
    const LOCK = 3000000n;                       // any non-zero unlock_time = time-locked
    // map value: bigint = unlock_time it reports · 'down' = throws · 'fail' = HTTP 500
    //            ['wrongtx', v] = reports v but with a mismatched tx_hash
    const fakeNodes = (map) => {
        const prev = global.fetch;
        global.fetch = async (url, opts) => {
            const uri = String(url).replace(/\/get_transactions$/, '');
            const reqTxid = JSON.parse(opts.body).txs_hashes[0];
            const v = map[uri];
            if (v === 'down') throw new Error('ECONNREFUSED');
            if (v === 'fail') return { ok: false, json: async () => ({}) };
            let txHash = reqTxid, unlock = v;
            if (Array.isArray(v) && v[0] === 'wrongtx') { txHash = 'f'.repeat(64); unlock = v[1]; }
            return { ok: true, json: async () => ({ txs: [{ tx_hash: txHash, as_json: JSON.stringify({ unlock_time: Number(unlock) }) }] }) };
        };
        return () => { global.fetch = prev; };
    };
    const withNodes = async (map, fn) => { const undo = fakeNodes(map); try { return await fn(); } finally { undo(); } };

    ok('unlock q1: node says 0 → 0n (unlocked)',
        (await withNodes({ 'http://a': 0n }, () => fetchUnlockTime(['http://a'], OK_TXID))) === 0n);
    ok('unlock q1: node says locked → returns the lock',
        (await withNodes({ 'http://a': LOCK }, () => fetchUnlockTime(['http://a'], OK_TXID))) === LOCK);
    ok('unlock q1: first node down → falls through to next',
        (await withNodes({ 'http://a': 'down', 'http://b': 0n }, () => fetchUnlockTime(['http://a', 'http://b'], OK_TXID))) === 0n);
    ok('unlock q2: both honest say 0 → 0n',
        (await withNodes({ 'http://a': 0n, 'http://b': 0n }, () => fetchUnlockTime(['http://a', 'http://b'], OK_TXID, 2))) === 0n);
    // THE FIX — a lying node (0) cannot outvote honest nodes (locked):
    ok('unlock q2: lying 0 vs honest locked → null, NOT 0 (C-1 fix)',
        (await withNodes({ 'http://a': 0n, 'http://b': LOCK, 'http://c': LOCK }, () => fetchUnlockTime(['http://a', 'http://b', 'http://c'], OK_TXID, 2))) === null);
    ok('unlock q2: disagreement in any position → null (fail closed)',
        (await withNodes({ 'http://a': LOCK, 'http://b': 0n, 'http://c': LOCK }, () => fetchUnlockTime(['http://a', 'http://b', 'http://c'], OK_TXID, 2))) === null);
    ok('unlock q2: only 1 node answers → null (cannot reach quorum)',
        (await withNodes({ 'http://a': 0n, 'http://b': 'down', 'http://c': 'down' }, () => fetchUnlockTime(['http://a', 'http://b', 'http://c'], OK_TXID, 2))) === null);
    ok('unlock: node returns a different tx_hash → null (substitution blocked)',
        (await withNodes({ 'http://a': ['wrongtx', 0n] }, () => fetchUnlockTime(['http://a'], OK_TXID))) === null);
    ok('unlock: no node returns the tx → null (fail closed)',
        (await withNodes({ 'http://a': 'down', 'http://b': 'fail' }, () => fetchUnlockTime(['http://a', 'http://b'], OK_TXID))) === null);

    console.log(`\n${fail === 0 ? 'ALL GREEN' : 'FAILED'}  ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('gates test error:', e); process.exit(2); });
