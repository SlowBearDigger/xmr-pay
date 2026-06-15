// block reorgs & the confirmation gate — offline, with a MOCK scanner.
//
// the reorg defence is minConfirmations: an order is not marked paid until the
// payment has minConfirmations, so a tx that gets orphaned BEFORE settlement
// never falsely completes. AFTER settlement the agent LATCHES (the poller skips
// paid orders) — a reorg deeper than minConfirmations is the merchant's accepted
// risk, bounded by how high they set minConfirmations. (Same model as every
// processor: confirmations are the defence; you don't un-capture a settled sale.)
//   node test/reorg.test.js

const { createPaymentAgent } = require('../src/agent');
const { summarizeTransfers } = require('../src/watch');
const { xmrToPico } = require('../src/verify');

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { (c ? pass++ : fail++); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`); };

function mockScanner() {
    let idx = 0;
    const rowsByIndex = new Map();
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
const row = (pico, confs) => ({ txid: 'tx_' + pico + '_' + confs, amountPico: BigInt(pico), confirmations: confs, inPool: false, locked: false });
const P = '100000000000'; // 0.1 XMR in piconero

(async () => {
    const ms = mockScanner();
    const paid = [];
    const agent = createPaymentAgent({ scanner: ms, minConfirmations: 5, onPaid: o => paid.push(o.id) });

    // ── pre-settlement reorg: a tx seen but orphaned before minConf never pays ──
    await agent.createOrder({ id: 'r1', amount: '0.1' }); // sub index 1
    ms.rowsByIndex.set(1, [row(P, 3)]);                   // seen, 3 confs < 5
    let r = await agent.check('r1');
    ok('seen below minConf → NOT paid', !r.paid && r.status !== 'paid', r.status);

    ms.rowsByIndex.set(1, []);                            // REORG: the tx is orphaned
    r = await agent.check('r1');
    ok('orphaned before settlement → received resets, still NOT paid', !r.paid && r.receivedXmr === 0, `recv ${r.receivedXmr}`);

    ms.rowsByIndex.set(1, [row(P, 5)]);                  // re-mined to minConf
    r = await agent.check('r1');
    ok('re-mined to minConf → paid', r.paid && r.status === 'paid');
    ok('onPaid fired exactly once for r1', paid.filter(x => x === 'r1').length === 1);

    // ── the confirmation gate is what blocks a too-shallow (reorg-prone) tx ──
    await agent.createOrder({ id: 'r2', amount: '0.1' }); // index 2
    ms.rowsByIndex.set(2, [row(P, 1)]);                  // full amount but only 1 conf
    r = await agent.check('r2');
    ok('full amount, 1 conf < minConf(5) → NOT paid yet', !r.paid, r.status);
    ms.rowsByIndex.set(2, [row(P, 5)]);
    r = await agent.check('r2');
    ok('reaches minConf → paid', r.paid);

    // ── post-settlement latch: the poller does NOT re-check a settled order, so
    //    a deep reorg after settlement does not silently reverse it (by design) ──
    await agent.createOrder({ id: 'r3', amount: '0.1' }); // index 3
    ms.rowsByIndex.set(3, [row(P, 10)]);
    r = await agent.check('r3');
    ok('r3 settles', r.paid);
    ms.rowsByIndex.set(3, []);                           // deep reorg orphans the settled tx
    await agent.tick();                                  // a normal poller cycle
    ok('settled order stays paid after a poller tick (latched; minConf is the defence)', agent.get('r3').paid === true);

    ok('onPaid fired exactly once per order, never duplicated', paid.length === 3 && new Set(paid).size === 3, paid.join(','));

    console.log(`\n${fail === 0 ? 'ALL GREEN' : 'FAILED'}  ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
})();
