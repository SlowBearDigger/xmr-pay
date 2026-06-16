// verifyPaymentViaRpc — the wallet-rpc transport that needs NO monero-ts.
// runs offline: wallet-rpc and the daemon are just fetch(), so we mock them.
//   node test/verify-rpc.test.js

const { verifyPaymentViaRpc } = require('../src/watch');

const OK_TXID = 'a'.repeat(64);
const OK_KEY = 'b'.repeat(64);
const PROOF = 'InProofV2abc123';            // matches the (Out|In)Proof shape
const ADDR = '4' + '1'.repeat(94);          // shape-valid mainnet address
const PICO = 100000000000n;                 // 0.1 XMR

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { (c ? pass++ : fail++); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`); };

// a fake monero-wallet-rpc + daemon over fetch. handlers maps a json-rpc method
// name to a result object (or the string 'error' to make wallet-rpc reject).
// daemonUnlock, if set, is the unlock_time the /get_transactions fallback reports.
function fakeRpc(handlers) {
    const prev = global.fetch;
    global.fetch = async (url, opts) => {
        const u = String(url);
        const body = JSON.parse(opts.body);
        if (u.endsWith('/json_rpc')) {
            const h = handlers[body.method];
            if (h === 'error') return { ok: true, json: async () => ({ error: { message: 'invalid tx key/proof' } }) };
            if (h === undefined) return { ok: true, json: async () => ({ error: { message: 'no handler: ' + body.method } }) };
            return { ok: true, json: async () => ({ result: typeof h === 'function' ? h(body.params) : h }) };
        }
        if (u.endsWith('/get_transactions')) {
            if (handlers.daemonUnlock === undefined) return { ok: false, json: async () => ({}) };
            return { ok: true, json: async () => ({ txs: [{ tx_hash: body.txs_hashes[0], as_json: JSON.stringify({ unlock_time: Number(handlers.daemonUnlock) }) }] }) };
        }
        return { ok: false, json: async () => ({}) };
    };
    return () => { global.fetch = prev; };
}
const withRpc = async (h, fn) => { const undo = fakeRpc(h); try { return await fn(); } finally { undo(); } };

const good = (extra = {}) => ({ good: true, received: 100000000000, confirmations: 5, in_pool: false, ...extra });
const unlocked = { transfer: { unlock_time: 0 } };

(async () => {
    const base = { url: 'http://127.0.0.1:18083', txid: OK_TXID, proof: PROOF, address: ADDR, amount: '0.1' };

    // ---- cheap gates (no network) ----
    let r = await verifyPaymentViaRpc({ ...base, url: '' });
    ok('missing wallet-rpc url → invalid', !r.paid && r.status === 'invalid');
    r = await verifyPaymentViaRpc({ ...base, txid: 'nope' });
    ok('bad txid → invalid', !r.paid && r.status === 'invalid');
    r = await verifyPaymentViaRpc({ ...base, address: 'x' });
    ok('bad address → invalid', !r.paid && r.status === 'invalid');
    r = await verifyPaymentViaRpc({ ...base, amount: '0' });
    ok('amount 0 → invalid', !r.paid && r.status === 'invalid');
    r = await verifyPaymentViaRpc({ ...base, proof: 'xyz' });
    ok('garbage proof → invalid', !r.paid && r.status === 'invalid');

    // ---- happy path ----
    r = await withRpc({ check_tx_proof: good(), get_transfer_by_txid: unlocked }, () => verifyPaymentViaRpc(base));
    ok('good proof + unlocked + confs → paid', r.paid && r.status === 'paid' && r.transport === 'wallet-rpc' && /verified/.test(r.reason), r.reason);
    ok('paid reports receivedXmr 0.1', Math.abs(r.receivedXmr - 0.1) < 1e-9);

    r = await withRpc({ check_tx_proof: good({ received: 150000000000 }), get_transfer_by_txid: unlocked }, () => verifyPaymentViaRpc(base));
    ok('overpaid still paid, flagged', r.paid && r.overpaid === true && Math.abs(r.overpaidXmr - 0.05) < 1e-9);

    // ---- rejections (shared classifyResult) ----
    r = await withRpc({ check_tx_proof: { good: false, received: 0, confirmations: 0 } }, () => verifyPaymentViaRpc(base));
    ok('proof good:false → invalid', !r.paid && r.status === 'invalid');
    r = await withRpc({ check_tx_proof: good({ received: 50000000000 }) }, () => verifyPaymentViaRpc(base));
    ok('received < expected → underpaid', !r.paid && r.status === 'underpaid');
    r = await withRpc({ check_tx_proof: good({ received: 0 }) }, () => verifyPaymentViaRpc(base));
    ok('received 0 → no-funds', !r.paid && r.status === 'no-funds');
    r = await withRpc({ check_tx_proof: good({ confirmations: 0, in_pool: true }) }, () => verifyPaymentViaRpc(base));
    ok('0 confs in pool → mempool', !r.paid && r.status === 'mempool');
    r = await withRpc({ check_tx_proof: good({ confirmations: 1 }) }, () => verifyPaymentViaRpc({ ...base, minConfirmations: 2 }));
    ok('confs < min, not pool → unconfirmed', !r.paid && r.status === 'unconfirmed');

    // ---- time-lock gate ----
    const lockedRpc = { check_tx_proof: good(), get_transfer_by_txid: { transfer: { unlock_time: 3000000 } } };
    r = await withRpc(lockedRpc, () => verifyPaymentViaRpc(base));
    ok('time-locked tx → locked (never paid)', !r.paid && r.status === 'locked' && /time-locked|unlock_time/.test(r.reason), r.reason);
    // skipUnlockTimeCheck bypasses the gate — the SAME locked tx now settles (the
    // flag must actually be honoured; documented as NOT recommended).
    r = await withRpc(lockedRpc, () => verifyPaymentViaRpc({ ...base, skipUnlockTimeCheck: true }));
    ok('skipUnlockTimeCheck=true → the time-lock gate is bypassed → paid', r.paid && r.status === 'paid', r.reason);

    // ---- elapsed unlock_time (wallet-rpc parity fix) ----
    // a PAST unlock_time means the funds are spendable NOW — accept it, instead of
    // stranding a legit payment as "locked" forever (the bug this fixes; the monero-ts
    // transport already did this). a FUTURE unlock_time still stays locked.
    // block-height form: wallet tip is past the unlock height → elapsed → paid.
    r = await withRpc({ check_tx_proof: good(), get_transfer_by_txid: { transfer: { unlock_time: 100 } }, get_height: { height: 5000 } },
        () => verifyPaymentViaRpc(base));
    ok('block-height unlock_time already elapsed (tip past it) → paid', r.paid && r.status === 'paid', r.reason);
    // block-height form: wallet tip is below the unlock height → still locked.
    r = await withRpc({ check_tx_proof: good(), get_transfer_by_txid: { transfer: { unlock_time: 9000 } }, get_height: { height: 5000 } },
        () => verifyPaymentViaRpc(base));
    ok('block-height unlock_time in the future (tip below it) → locked', !r.paid && r.status === 'locked', r.reason);
    // timestamp form (>= 5e8): a long-past unix timestamp → elapsed → paid.
    r = await withRpc({ check_tx_proof: good(), get_transfer_by_txid: { transfer: { unlock_time: 1000000000 } } },
        () => verifyPaymentViaRpc(base));   // 2001 — long past
    ok('timestamp unlock_time in the past → paid', r.paid && r.status === 'paid', r.reason);
    // timestamp form: a far-future unix timestamp → locked.
    r = await withRpc({ check_tx_proof: good(), get_transfer_by_txid: { transfer: { unlock_time: 9999999999 } } },
        () => verifyPaymentViaRpc(base));   // 2286 — far future
    ok('timestamp unlock_time in the future → locked', !r.paid && r.status === 'locked', r.reason);

    // wallet has no record → fall back to daemon nodes for the unlock gate
    r = await withRpc({ check_tx_proof: good(), get_transfer_by_txid: 'error', daemonUnlock: 0 }, () => verifyPaymentViaRpc({ ...base, nodes: ['http://node:38081'] }));
    ok('no wallet record + daemon says unlocked → paid', r.paid && r.status === 'paid', r.reason);
    r = await withRpc({ check_tx_proof: good(), get_transfer_by_txid: 'error', daemonUnlock: 3000000 }, () => verifyPaymentViaRpc({ ...base, nodes: ['http://node:38081'] }));
    ok('no wallet record + daemon says locked → locked', !r.paid && r.status === 'locked');
    r = await withRpc({ check_tx_proof: good(), get_transfer_by_txid: 'error' }, () => verifyPaymentViaRpc(base));
    ok('no wallet record + no nodes → invalid (fail closed)', !r.paid && r.status === 'invalid' && /unlock_time/.test(r.reason), r.reason);

    // ---- check_tx_key path (no `good` field; bad key → wallet-rpc error) ----
    r = await withRpc({ check_tx_key: { received: 100000000000, confirmations: 5, in_pool: false }, get_transfer_by_txid: unlocked }, () => verifyPaymentViaRpc({ ...base, proof: OK_KEY }));
    ok('check_tx_key path → paid', r.paid && r.status === 'paid', r.reason);
    r = await withRpc({ check_tx_key: 'error' }, () => verifyPaymentViaRpc({ ...base, proof: OK_KEY }));
    ok('wallet-rpc error on bad key → invalid (reason names the rpc failure)', !r.paid && r.status === 'invalid' && /wallet-rpc/.test(r.reason), r.reason);

    // wallet-rpc returns a non-numeric amount → caught as a malformed-amount invalid
    r = await withRpc({ check_tx_proof: good({ received: 'not-a-number' }), get_transfer_by_txid: unlocked }, () => verifyPaymentViaRpc(base));
    ok('malformed amount from wallet-rpc → invalid (reason says malformed)', !r.paid && r.status === 'invalid' && /malformed amount/.test(r.reason), r.reason);

    // ---- replay gate (caller's alreadyUsed) ----
    r = await withRpc({ check_tx_proof: good(), get_transfer_by_txid: unlocked }, () => verifyPaymentViaRpc({ ...base, alreadyUsed: async () => true }));
    ok('alreadyUsed → replay (reason explains why)', !r.paid && r.status === 'replay' && /already used|another order/.test(r.reason), r.reason);

    console.log(`\n${fail === 0 ? 'ALL GREEN' : 'FAILED'}  ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('verify-rpc test error:', e); process.exit(2); });
