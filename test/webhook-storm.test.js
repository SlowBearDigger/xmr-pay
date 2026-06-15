// webhook storm — a forever-failing fulfillment endpoint must stay BOUNDED: a
// fixed number of attempts, no throw, no hang, and the agent settles the order
// regardless (delivery + idempotency are the caller's job).
//   node test/webhook-storm.test.js

const { sendWebhook } = require('../src/webhook');
const { createPaymentAgent } = require('../src/agent');
const { summarizeTransfers } = require('../src/watch');
const { xmrToPico } = require('../src/verify');

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { (c ? pass++ : fail++); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`); };

function failingFetch(mode) {
    const prev = global.fetch; let calls = 0;
    global.fetch = async () => { calls++; if (mode === 'reject') throw new Error('ECONNREFUSED'); return { ok: false, status: 500, json: async () => ({}) }; };
    return { restore: () => { global.fetch = prev; }, calls: () => calls };
}

(async () => {
    // bounded attempts, returns a failure verdict, never throws / hangs
    for (const mode of ['reject', '500']) {
        const f = failingFetch(mode);
        let res, threw = false;
        try { res = await sendWebhook('http://down.example', '{}', { secret: 's', attempts: 1 }); } catch { threw = true; }
        f.restore();
        ok(`failing webhook (${mode}): no throw, delivered:false, exactly 1 try`, !threw && res && res.delivered === false && f.calls() === 1, JSON.stringify(res));
    }

    // attempts is a hard cap — a permanently-down endpoint is retried N times, not forever
    {
        const f = failingFetch('reject');
        const res = await sendWebhook('http://down.example', '{}', { attempts: 3 }).catch(() => null);
        f.restore();
        ok('attempts:3 → exactly 3 tries then gives up (bounded, never infinite)', f.calls() === 3 && res && res.delivered === false, `${f.calls()} calls`);
    }

    // the agent settles the order even when onPaid (the webhook) throws — the failed
    // delivery must not crash the poller or leave the order un-settled.
    {
        let idx = 0; const rows = new Map();
        const ms = {
            async sync() { }, async newSubaddress() { const i = ++idx; return { address: 's' + i, index: i, atHeight: 1000 + i }; }, async addressAt(i) { return 's' + i; },
            async checkOrder({ subaddressIndex, amount, minConfirmations = 1 }) { return summarizeTransfers(rows.get(subaddressIndex) || [], xmrToPico(amount), minConfirmations); },
        };
        const a = createPaymentAgent({ scanner: ms, minConfirmations: 1, onPaid: async () => { throw new Error('webhook exploded'); } });
        const o = await a.createOrder({ id: 'w', amount: '0.1' });
        rows.set(o.index, [{ txid: 't1', amountPico: 100000000000n, confirmations: 10, inPool: false, locked: false }]);
        let crashed = false, r;
        try { r = await a.check('w'); } catch { crashed = true; }
        ok('onPaid throwing (webhook down) does NOT crash the agent; order still settles', !crashed && r && r.paid === true && a.get('w').paid === true);
    }

    console.log(`\n${fail === 0 ? 'ALL GREEN' : 'FAILED'}  ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
})();
