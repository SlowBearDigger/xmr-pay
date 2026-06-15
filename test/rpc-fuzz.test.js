// adversarial RPC fuzzing — a hostile or malformed node response must never crash
// the verifier and never yield a trusted value. targets the real node-response
// parsing (fetchUnlockTime → unlockTimeFromNode, the time-lock gate's daemon read)
// plus the input gates. complements chaos.test.js (hostile wallet results).
//   node test/rpc-fuzz.test.js

const fc = require('fast-check');
const { fetchUnlockTime, detectProofKind, isValidTxid, isValidAddress } = require('../src/verify');

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { (c ? pass++ : fail++); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`); };

const TXID = 'a'.repeat(64);

// swap in a mock global.fetch that returns a (possibly hostile) response, run fn,
// then always restore the real fetch.
function withFetch(makeResponse, fn) {
    const real = global.fetch;
    global.fetch = async () => makeResponse();
    return Promise.resolve().then(fn).finally(() => { global.fetch = real; });
}

// arbitrary hostile /get_transactions response bodies
const hostileBody = fc.oneof(
    fc.constant(null),
    fc.constant({}),
    fc.constant({ txs: null }),
    fc.constant({ txs: [] }),
    fc.constant({ txs: [{}] }),
    fc.constant({ txs: [{ as_json: 'not json {' }] }),
    fc.constant({ txs: [{ tx_hash: 'b'.repeat(64), as_json: '{"unlock_time":0}' }] }),        // mismatched tx
    fc.constant({ txs: [{ tx_hash: TXID, as_json: '{"unlock_time":"; DROP TABLE --"}' }] }),  // junk unlock_time
    fc.constant({ txs: [{ tx_hash: TXID, as_json: '{"unlock_time":{}}' }] }),
    fc.constant({ txs: [{ tx_hash: TXID, as_json: '{"unlock_time":[1,2,3]}' }] }),
    fc.constant({ txs: [{ tx_hash: TXID, as_json: '{}' }] }),                                  // no unlock_time
    fc.record({ txs: fc.array(fc.anything(), { maxLength: 3 }) }),
    fc.anything(),
);

(async () => {
    // 1) every hostile response → null (fail closed), never throws, never trusted
    let threw = false, nonNull = 0;
    const bodies = fc.sample(hostileBody, 400);
    const oks = fc.sample(fc.boolean(), 400);
    for (let i = 0; i < bodies.length; i++) {
        try {
            const r = await withFetch(() => ({ ok: oks[i], json: async () => bodies[i] }), () => fetchUnlockTime(['http://x'], TXID, 1));
            if (r !== null) nonNull++;
        } catch { threw = true; }
    }
    ok('fetchUnlockTime never throws on 400 hostile node responses', !threw);
    ok('fetchUnlockTime fails CLOSED (null) on every hostile response', nonNull === 0, `${nonNull} non-null`);

    // a response whose json() itself throws (non-JSON body) → null
    let r = await withFetch(() => ({ ok: true, json: async () => { throw new Error('not json'); } }), () => fetchUnlockTime(['http://x'], TXID, 1));
    ok('json() throwing → null (caught, fail closed)', r === null);

    // 2) a VALID matching response returns the EXACT unlock_time (not always-null)
    const good = { txs: [{ tx_hash: TXID, as_json: JSON.stringify({ unlock_time: 123456 }) }] };
    r = await withFetch(() => ({ ok: true, json: async () => good }), () => fetchUnlockTime(['http://x'], TXID, 1));
    ok('valid matching response → exact unlock_time BigInt', r === 123456n, String(r));

    // unlock_time 0 (spendable) → 0n, distinct from the null "couldn't read" signal
    const z = { txs: [{ tx_hash: TXID, as_json: JSON.stringify({ unlock_time: 0 }) }] };
    r = await withFetch(() => ({ ok: true, json: async () => z }), () => fetchUnlockTime(['http://x'], TXID, 1));
    ok('unlock_time 0 → 0n (spendable), distinct from null', r === 0n);

    // a CORRECT tx_hash but case-different → still matches (txid is lowercased)
    const up = { txs: [{ tx_hash: TXID.toUpperCase(), as_json: JSON.stringify({ unlock_time: 7 }) }] };
    r = await withFetch(() => ({ ok: true, json: async () => up }), () => fetchUnlockTime(['http://x'], TXID, 1));
    ok('case-insensitive tx_hash match → 7n', r === 7n);

    // 3) detectProofKind never throws + only well-formed proofs classify
    let dThrew = false, dBad = 0;
    fc.assert(fc.property(fc.anything(), v => {
        let k; try { k = detectProofKind(v); } catch { dThrew = true; return false; }
        if (![null, 'txkey', 'txproof'].includes(k)) { dBad++; return false; }
        return true;
    }), { numRuns: 3000 });
    ok('detectProofKind never throws + always null|txkey|txproof', !dThrew && dBad === 0);

    // 4) the input gates never throw on arbitrary garbage
    let gThrew = false;
    fc.assert(fc.property(fc.anything(), v => {
        try { isValidTxid(v); isValidAddress(v, 'mainnet'); } catch { gThrew = true; return false; }
        return true;
    }), { numRuns: 3000 });
    ok('isValidTxid / isValidAddress never throw on garbage', !gThrew);

    console.log(`\n${fail === 0 ? 'ALL GREEN' : 'FAILED'}  ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
})();
