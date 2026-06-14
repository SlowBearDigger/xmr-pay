// chaos suite — how xmr-pay behaves when EVERYTHING goes wrong.
//
// the happy-path suites (verify-rpc, watch) prove a real payment resolves to
// paid. this one proves the opposite job: under delayed confirmations, node
// failures, duplicate submissions, partial payments, network congestion, and
// user mistakes, the lib never says `paid` for money that didn't arrive, can't
// be spent, or already paid another order — and degrades loudly, not silently.
//
// the categories below are the ones a reviewer named as where payment systems
// actually earn trust. each block is one of them. runs offline & deterministic:
// wallet-rpc and the daemon are just fetch(), so we mock them — no monero-ts,
// no network, no stagenet.
//   node test/chaos.test.js

const { verifyPaymentViaRpc, createWatcher } = require('../src/watch');

const TXID = 'a'.repeat(64);
const KEY = 'b'.repeat(64);
const PROOF = 'InProofV2abc123';
const ADDR = '4' + '1'.repeat(94);
const PICO = 100000000000n;                 // 0.1 XMR in piconero

let pass = 0, fail = 0, warn = 0;
const ok = (n, c, x = '') => { (c ? pass++ : fail++); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`); };
const note = (n, x = '') => { warn++; console.log(`WARN  ${n}${x ? '  — ' + x : ''}`); };

// a fake monero-wallet-rpc + daemon over fetch. `routes` maps a json-rpc method
// (or 'get_transactions' for the daemon path) to a handler:
//   object              → returned as the rpc `result`
//   'error'             → wallet-rpc rejects (json-rpc error)
//   'throw'             → fetch itself throws (node/wallet down, ECONNREFUSED)
//   'timeout'           → fetch throws an AbortError (request timed out)
//   'http500'           → non-ok HTTP response
//   fn(params, callIdx) → computed per call (callIdx lets a value change over
//                         time — the same order polled while the chain moves)
// for 'get_transactions' the handler value is the unlock_time the daemon reports
// (number), or null for "node has no record of this tx".
function mockNet(routes) {
    const prev = global.fetch;
    const calls = {};
    global.fetch = async (url, opts) => {
        const u = String(url);
        const body = JSON.parse(opts.body);
        const isDaemon = u.endsWith('/get_transactions');
        const key = isDaemon ? 'get_transactions' : body.method;
        const idx = (calls[key] = (calls[key] || 0) + 1) - 1;
        let h = routes[key];
        if (typeof h === 'function') h = h(body.params || body, idx);
        if (h === 'throw') throw Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' });
        if (h === 'timeout') throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
        if (h === 'http500') return { ok: false, status: 500, json: async () => ({}) };
        if (isDaemon) {
            if (h === undefined || h === null) return { ok: false, json: async () => ({}) };  // not found
            return { ok: true, json: async () => ({ txs: [{ tx_hash: body.txs_hashes[0], as_json: JSON.stringify({ unlock_time: Number(h) }) }] }) };
        }
        if (h === 'error') return { ok: true, json: async () => ({ error: { message: 'wallet-rpc: invalid tx key/proof' } }) };
        if (h === undefined) return { ok: true, json: async () => ({ error: { message: 'no handler: ' + body.method } }) };
        return { ok: true, json: async () => ({ result: h }) };
    };
    return () => { global.fetch = prev; };
}
const withNet = async (routes, fn) => { const undo = mockNet(routes); try { return await fn(); } finally { undo(); } };

const good = (extra = {}) => ({ good: true, received: Number(PICO), confirmations: 5, in_pool: false, ...extra });
const unlocked = { transfer: { unlock_time: 0 } };
const base = { url: 'http://127.0.0.1:18083', txid: TXID, proof: PROOF, address: ADDR, amount: '0.1' };

(async () => {

    // ── 1 · delayed confirmations & reorg ──────────────────────────────────
    // a tx is not money until it is confirmed and stays confirmed. poll the same
    // order while the chain moves under it: pool → 1 conf → deep → reorg back to
    // pool. it must read paid ONLY in the deep window, and un-pay if the block
    // that confirmed it is orphaned. the lib holds no memory, so each call is a
    // fresh truth — a merchant who re-checks is always safe.
    const lifecycle = [
        { good: true, received: Number(PICO), confirmations: 0, in_pool: true },   // seen in mempool
        { good: true, received: Number(PICO), confirmations: 1, in_pool: false },   // 1 confirmation
        { good: true, received: Number(PICO), confirmations: 10, in_pool: false },  // deep
        { good: true, received: Number(PICO), confirmations: 0, in_pool: true },    // REORG: back to pool
    ];
    const lifeRoutes = { check_tx_proof: (_p, i) => lifecycle[Math.min(i, lifecycle.length - 1)], get_transfer_by_txid: unlocked };
    await withNet(lifeRoutes, async () => {
        let r = await verifyPaymentViaRpc({ ...base, minConfirmations: 2 });
        ok('delayed: mempool tx not paid', !r.paid && r.status === 'mempool', r.status);
        r = await verifyPaymentViaRpc({ ...base, minConfirmations: 2 });
        ok('delayed: 1/2 confs → unconfirmed, not paid', !r.paid && r.status === 'unconfirmed', r.status);
        r = await verifyPaymentViaRpc({ ...base, minConfirmations: 2 });
        ok('delayed: deep enough → paid', r.paid && r.status === 'paid', r.status);
        r = await verifyPaymentViaRpc({ ...base, minConfirmations: 2 });
        ok('reorg: confirmations vanish → un-pays on re-check (mempool)', !r.paid && r.status === 'mempool', r.status);
    });
    // a 0-conf-tolerant merchant opts into reorg risk explicitly — and is told.
    await withNet({ check_tx_proof: good({ confirmations: 0, in_pool: true }), get_transfer_by_txid: unlocked }, async () => {
        const r = await verifyPaymentViaRpc({ ...base, minConfirmations: 0 });
        ok('delayed: minConfirmations:0 accepts mempool (opt-in risk)', r.paid, r.status);
    });

    // ── 2 · node / wallet-rpc failures ─────────────────────────────────────
    // a node that is down, slow, or returning errors must never produce a paid.
    // fail closed, every transport, every step.
    await withNet({ check_tx_proof: 'throw' }, async () => {
        const r = await verifyPaymentViaRpc(base);
        ok('node failure: wallet-rpc down → node-error (retryable, not paid)', !r.paid && r.status === 'node-error', r.status);
    });
    await withNet({ check_tx_proof: 'http500' }, async () => {
        const r = await verifyPaymentViaRpc(base);
        ok('node failure: wallet-rpc HTTP 500 → node-error (retryable, not paid)', !r.paid && r.status === 'node-error', r.status);
    });
    // the proof verifies, but the unlock_time step can reach nobody: must NOT
    // assume unlocked — fail closed.
    await withNet({ check_tx_proof: good(), get_transfer_by_txid: 'error' }, async () => {
        const r = await verifyPaymentViaRpc(base);   // no daemon nodes given as fallback
        ok('node failure: unlock check has no source → invalid (fail closed)', !r.paid && /unlock_time/.test(r.reason), r.reason);
    });
    // wallet has no record, falls back to a daemon node that is also down → still
    // fail closed, never paid.
    await withNet({ check_tx_proof: good(), get_transfer_by_txid: 'error', get_transactions: 'throw' }, async () => {
        const r = await verifyPaymentViaRpc({ ...base, nodes: ['http://node:38081'] });
        ok('node failure: wallet + daemon both unreachable → not paid', !r.paid, r.status);
    });
    // watch mode: a congested wallet-rpc must surface as an error to the poller,
    // never as a quiet "pending" the caller could mistake for "all fine".
    await withNet({ get_transfers: 'throw' }, async () => {
        const w = createWatcher({ url: base.url });
        let threw = false;
        try { await w.checkOrder({ subaddressIndex: 1, amount: '0.1' }); } catch { threw = true; }
        ok('node failure: watch poll on a down wallet-rpc throws (not silent paid/pending)', threw);
    });

    // ── 3 · duplicate submissions (the concurrency race) ───────────────────
    // the lib proves a payment is real; it cannot know your order state — replay
    // protection is the caller's, and it MUST be atomic. two concurrent requests
    // carrying the same valid proof: a naive read-then-write store double-pays
    // (the TOCTOU window the docs warn about); an atomic check-and-claim lets
    // exactly one through. this proves both directions.
    await withNet({ check_tx_proof: good(), get_transfer_by_txid: unlocked }, async () => {
        // naive: alreadyUsed reads a set the caller only writes AFTER verify
        // returns — both requests read "unused" before either commits.
        const seen = new Set();
        const naive = async () => {
            const r = await verifyPaymentViaRpc({ ...base, alreadyUsed: async t => seen.has(t) });
            if (r.paid) seen.add(r.txid);   // commit happens too late
            return r;
        };
        const [a, b] = await Promise.all([naive(), naive()]);
        ok('duplicate: naive read-then-write store DOUBLE-PAYS (the documented TOCTOU)', a.paid && b.paid,
            'this is the failure your orders table must close with UNIQUE(tx_hash)');

        // atomic: claim synchronously inside the check — first caller wins, the
        // other is rejected as replay. models a UNIQUE constraint / check-and-set.
        const claimed = new Set();
        const claim = t => (claimed.has(t) ? false : (claimed.add(t), true));
        const atomic = () => verifyPaymentViaRpc({ ...base, alreadyUsed: async t => !claim(t) });
        const [c, d] = await Promise.all([atomic(), atomic()]);
        const paidCount = [c, d].filter(x => x.paid).length;
        const replayCount = [c, d].filter(x => x.status === 'replay').length;
        ok('duplicate: atomic claim → exactly ONE paid, one replay', paidCount === 1 && replayCount === 1, `${paidCount} paid, ${replayCount} replay`);
    });
    // the simple sequential replay (same proof, second order) still rejects.
    await withNet({ check_tx_proof: good(), get_transfer_by_txid: unlocked }, async () => {
        const r = await verifyPaymentViaRpc({ ...base, alreadyUsed: async () => true });
        ok('duplicate: known txid → replay', !r.paid && r.status === 'replay');
    });

    // ── 4 · partial payments (watch mode sums transfers) ───────────────────
    // proof mode verifies exactly one tx; splits are watch mode's job. it must
    // sum confirmed transfers, hold back pool and time-locked ones, and only
    // flip to paid when CONFIRMED, SPENDABLE funds cover the order.
    const W = (scenario) => {
        const undo = mockNet({
            create_address: { address: '78' + 'x'.repeat(93), address_index: 7 },
            get_transfers: scenario,
            get_height: { height: 2200000 },
        });
        return [createWatcher({ url: base.url }), undo];
    };
    const tx = (amount, confirmations, opts = {}) => ({ txid: (opts.id || '1').repeat(64), amount, confirmations, type: opts.pool ? 'pool' : 'in', unlock_time: opts.lock || 0, locked: !!opts.lock });
    {
        // two installments, both confirmed, sum to exactly the order
        let [w, undo] = W({ in: [tx(60000000000, 4, { id: 'c' }), tx(40000000000, 2, { id: 'd' })], pool: [] });
        let r = await w.checkOrder({ subaddressIndex: 1, amount: '0.1' });
        ok('partial: two confirmed installments sum to paid', r.paid && r.txids.length === 2, `${r.receivedXmr}`);
        undo();
        // confirmed half + the rest still in the pool → not yet
        [w, undo] = W({ in: [tx(60000000000, 4, { id: 'c' })], pool: [tx(40000000000, 0, { id: 'e', pool: true })] });
        r = await w.checkOrder({ subaddressIndex: 1, amount: '0.1' });
        ok('partial: confirmed + pending pool remainder → mempool, not paid', !r.paid && r.status === 'mempool', `${r.receivedXmr}+${r.pendingXmr}`);
        undo();
        // confirmed part + a time-locked part that WOULD cover it → never paid
        [w, undo] = W({ in: [tx(60000000000, 4, { id: 'c' }), tx(50000000000, 9, { id: 'f', lock: 3000000 })], pool: [] });
        r = await w.checkOrder({ subaddressIndex: 1, amount: '0.1' });
        ok('partial: confirmed + time-locked remainder → locked, not paid', !r.paid && r.status === 'locked', r.reason);
        undo();
        // a single transfer one piconero short → partial, never paid
        [w, undo] = W({ in: [tx(99999999999, 6, { id: 'c' })], pool: [] });
        r = await w.checkOrder({ subaddressIndex: 1, amount: '0.1' });
        ok('partial: 1 piconero short → partial, not paid', !r.paid && r.status === 'partial', `${r.receivedXmr}/0.1`);
        undo();
        // overpaid across installments still settles
        [w, undo] = W({ in: [tx(80000000000, 5, { id: 'c' }), tx(50000000000, 5, { id: 'd' })], pool: [] });
        r = await w.checkOrder({ subaddressIndex: 1, amount: '0.1' });
        ok('partial: overpaid across installments → paid', r.paid && r.receivedXmr > 0.1, `${r.receivedXmr}`);
        undo();
    }

    // ── 5 · network congestion (timeouts) ──────────────────────────────────
    // a request that times out mid-flight is indistinguishable, at the wire,
    // from a node that is gone. either way: never paid.
    await withNet({ check_tx_proof: 'timeout' }, async () => {
        const r = await verifyPaymentViaRpc(base);
        ok('congestion: wallet-rpc timeout → node-error (retryable, not paid)', !r.paid && r.status === 'node-error', r.status);
    });
    await withNet({ check_tx_proof: good(), get_transfer_by_txid: 'timeout' }, async () => {
        const r = await verifyPaymentViaRpc(base);   // unlock step times out, no fallback nodes configured
        ok('congestion: unlock-step timeout, no fallback → invalid (fail closed)', !r.paid && /unlock_time/.test(r.reason), r.reason);
    });
    // the sharp edge is now closed: a transport failure reads as `node-error`
    // (retry me), a genuinely bad proof stays `invalid` (reject me). the merchant
    // can finally tell the two apart by status alone.
    {
        const down = await withNet({ check_tx_proof: 'throw' }, () => verifyPaymentViaRpc(base));
        const bad = await withNet({ check_tx_proof: { good: false, received: 0, confirmations: 0 } }, () => verifyPaymentViaRpc(base));
        ok('congestion vs bad proof: distinct statuses (node-error vs invalid)', down.status === 'node-error' && bad.status === 'invalid', `${down.status} / ${bad.status}`);
    }

    // ── 6 · user mistakes ──────────────────────────────────────────────────
    // people fat-finger amounts, pay the wrong address, paste junk. none of it
    // should crash, and none should pay an order it does not match.
    await withNet({ check_tx_proof: good({ received: 50000000000 }), get_transfer_by_txid: unlocked }, async () => {
        const r = await verifyPaymentViaRpc(base);   // paid 0.05 toward a 0.1 order
        ok('mistake: underpaid order → underpaid, not paid', !r.paid && r.status === 'underpaid', r.reason);
    });
    {
        const r = await verifyPaymentViaRpc({ ...base, proof: 'not a real proof at all' });
        ok('mistake: pasted junk proof → invalid (cheap reject, no RPC)', !r.paid && r.status === 'invalid');
    }
    {
        // buyer paid the right amount but to a DIFFERENT order's subaddress: this
        // order's watcher sees nothing and stays pending (no false-pay; the stray
        // payment is a manual-reconciliation matter, not a settlement).
        const undo = mockNet({ get_transfers: { in: [], pool: [] } });
        const w = createWatcher({ url: base.url });
        const r = await w.checkOrder({ subaddressIndex: 9, amount: '0.1' });
        ok('mistake: paid to the wrong subaddress → this order stays pending', !r.paid && r.status === 'pending');
        undo();
    }

    // ── 7 · hostile / malformed node responses ─────────────────────────────
    // a node (or a compromised wallet-rpc) returning garbage must never coerce
    // into a paid. negative or absent amounts collapse to no-funds, not a pass.
    await withNet({ check_tx_proof: good({ received: -100000000000 }), get_transfer_by_txid: unlocked }, async () => {
        const r = await verifyPaymentViaRpc(base);
        ok('hostile: negative received → no-funds, not paid', !r.paid && r.status === 'no-funds', r.status);
    });
    await withNet({ check_tx_proof: { good: true, confirmations: 5, in_pool: false }, get_transfer_by_txid: unlocked }, async () => {
        const r = await verifyPaymentViaRpc(base);   // `received` field omitted entirely
        ok('hostile: missing received field → no-funds, not paid', !r.paid && r.status === 'no-funds', r.status);
    });
    // a non-integer `received` (no honest wallet-rpc sends this) now fails closed
    // through the guarded atomicToPico parse instead of throwing an uncaught
    // BigInt exception.
    await withNet({ check_tx_proof: good({ received: '100000000000.5' }), get_transfer_by_txid: unlocked }, async () => {
        const r = await verifyPaymentViaRpc(base);
        ok('hostile: non-integer received → invalid (fail closed, no uncaught throw)', !r.paid && r.status === 'invalid', r.status);
    });

    console.log(`\n${fail === 0 ? 'ALL GREEN' : 'FAILED'}  ${pass} passed, ${fail} failed, ${warn} warnings`);
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('chaos test error:', e); process.exit(2); });
