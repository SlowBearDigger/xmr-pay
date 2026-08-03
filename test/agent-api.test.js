// Reference-agent API contract: creation is acknowledged only after the order
// ledger is durable, and POST/GET/SSE all serialize one authoritative snapshot.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPaymentAgent } = require('../src/agent');
const { createDurableOrder, persistOrderTransition, persistOrderRetirement, buildStatusSnapshot } = require('../src/agent-api');
const { loadOrderLedger } = require('../src/order-ledger');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  - ' + extra : ''}`); };

function scanner(result = { paid: false, status: 'pending', receivedXmr: 0, lockedXmr: 0, shortfallXmr: '0.1', confirmations: 0, txids: [] }) {
    let index = 0;
    return {
        async newSubaddress() { const i = ++index; return { address: `sub_${i}`, index: i, atHeight: 1234 }; },
        async addressAt(i) { return `sub_${i}`; },
        async checkOrder() { return result; },
    };
}

(async () => {
    const referenceSource = fs.readFileSync(path.join(__dirname, '../examples/scanner-agent.js'), 'utf8');
    ok('reference agent wires paid transitions through durable persistence', /persistPaid:\s*\(order\)[\s\S]*persistOrderTransition\(\{ ledgerState, ledgerFile: ORDERS_FILE, order \}\)/.test(referenceSource));

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xmr-pay-agent-api-'));
    try {
        const file = path.join(tmp, 'orders.json');
        const ledgerState = { store: new Map(), usedSubaddressHighWater: 0, generation: 0 };
        const agent = createPaymentAgent({ scanner: scanner(), store: ledgerState.store, usedSubaddressHighWater: 0, minConfirmations: 1 });
        const created = await createDurableOrder({ agent, ledgerState, ledgerFile: file, order: { id: 'sale-1', amount: '0.1' } });
        ok('durable create writes the order before resolving', fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')).orders[0].id === 'sale-1');
        ok('durable create persists the advanced subaddress high-water', ledgerState.usedSubaddressHighWater === 1 && JSON.parse(fs.readFileSync(file, 'utf8')).usedSubaddressHighWater === 1);

        const context = { minConfirmations: 1, tipHeight: 2000, walletHeight: 1999, syncGap: 2 };
        const post = buildStatusSnapshot(created, context);
        const get = buildStatusSnapshot(agent.get(created.id), context);
        const required = ['id', 'address', 'amount', 'paid', 'status', 'receivedXmr', 'lockedXmr', 'shortfallXmr', 'confirmations', 'minConfirmations', 'syncing', 'txids', 'birthdayHeight', 'revision'];
        ok('POST snapshot contains the full authoritative field contract', required.every(key => Object.prototype.hasOwnProperty.call(post, key)), JSON.stringify(post));
        ok('first POST and first GET snapshots match exactly', JSON.stringify(post) === JSON.stringify(get));

        const differentHealth = buildStatusSnapshot(agent.get(created.id), { minConfirmations: 9, tipHeight: 2500, walletHeight: 2000, syncGap: 2 });
        ok('dynamic node health cannot change an order snapshot at the same revision', JSON.stringify(differentHealth) === JSON.stringify(get));

        const paidResult = { paid: true, status: 'paid', receivedXmr: 0.1, receivedPico: '100000000000', pendingXmr: 0, lockedXmr: 0, shortfallXmr: '0', confirmations: 1, txids: ['paid-tx'] };
        const impossible = path.join(tmp, 'plain-file');
        fs.writeFileSync(impossible, 'not a directory');
        const badState = { store: new Map(), usedSubaddressHighWater: 0, generation: 0 };
        let orphanChecks = 0, orphanFulfillments = 0;
        const badScanner = scanner(paidResult);
        const checkOrder = badScanner.checkOrder;
        badScanner.checkOrder = async (...args) => { orphanChecks++; return checkOrder(...args); };
        const badAgent = createPaymentAgent({ scanner: badScanner, store: badState.store, minConfirmations: 1, onPaid: () => { orphanFulfillments++; } });
        let rejected = false;
        try {
            await createDurableOrder({ agent: badAgent, ledgerState: badState, ledgerFile: path.join(impossible, 'orders.json'), order: { id: 'must-not-ack', amount: '0.1' } });
        } catch { rejected = true; }
        ok('durable create propagates a persistence failure instead of resolving success', rejected);
        await badAgent.tick();
        ok('failed durable create removes the orphan before polling or fulfillment', badAgent.get('must-not-ack') === null && !badState.store.has('must-not-ack') && orphanChecks === 0 && orphanFulfillments === 0);
        ok('failed durable create burns its allocated subaddress monotonically', badState.usedSubaddressHighWater === 1 && badAgent.usedSubaddressHighWater() === 1);

        const recoveredFile = path.join(tmp, 'recovered-orders.json');
        let retriedCreate = null;
        try {
            retriedCreate = await createDurableOrder({ agent: badAgent, ledgerState: badState, ledgerFile: recoveredFile, order: { id: 'must-not-ack', amount: '0.1' } });
        } catch { /* assertion below reports unsafe retained state */ }
        const recoveredDisk = retriedCreate ? JSON.parse(fs.readFileSync(recoveredFile, 'utf8')) : null;
        ok('retry succeeds without reusing the burned subaddress or persisting an orphan', retriedCreate && retriedCreate.index === 2 && recoveredDisk.usedSubaddressHighWater === 2 && recoveredDisk.orders.length === 1 && recoveredDisk.orders[0].id === 'must-not-ack');

        // Let the backup rename succeed while the primary rename fails because
        // its target is a directory. Recovery must retain only the burned index,
        // never the unacknowledged order staged by the first write attempt.
        const blockedPrimary = path.join(tmp, 'blocked-primary');
        fs.mkdirSync(blockedPrimary);
        const partialState = { store: new Map(), usedSubaddressHighWater: 0, generation: 0 };
        const partialAgent = createPaymentAgent({ scanner: scanner(), store: partialState.store, minConfirmations: 1 });
        let partialRejected = false;
        try {
            await createDurableOrder({ agent: partialAgent, ledgerState: partialState, ledgerFile: blockedPrimary, order: { id: 'partial-create', amount: '0.1' } });
        } catch { partialRejected = true; }
        const partialRecovery = loadOrderLedger(blockedPrimary);
        ok('partial ledger failure durably burns the index without recovering an orphan', partialRejected && partialRecovery.usedSubaddressHighWater === 1 && partialRecovery.store.size === 0 && partialAgent.get('partial-create') === null);

        const paidFile = path.join(tmp, 'paid-orders.json');
        const paidState = { store: new Map(), usedSubaddressHighWater: 0, generation: 0 };
        let transitionFile = paidFile;
        let paidCalls = 0;
        let clock = 0;
        const paidAgent = createPaymentAgent({
            scanner: scanner(paidResult),
            store: paidState.store,
            minConfirmations: 1,
            paidRetentionMs: 1,
            now: () => clock,
            persistPaid: order => persistOrderTransition({ ledgerState: paidState, ledgerFile: transitionFile, order }),
            persistRetired: order => persistOrderRetirement({ ledgerState: paidState, ledgerFile: paidFile, orderId: order.id }),
            onPaid: () => {
                const durable = JSON.parse(fs.readFileSync(paidFile, 'utf8')).orders.find(order => order.id === 'paid-transition');
                if (!durable || !durable.paid) throw new Error('onPaid ran before durable paid state');
                paidCalls++;
            },
        });
        await createDurableOrder({ agent: paidAgent, ledgerState: paidState, ledgerFile: paidFile, order: { id: 'paid-transition', amount: '0.1' } });
        transitionFile = path.join(impossible, 'paid-orders.json');
        let persistRejected;
        try { await paidAgent.check('paid-transition'); }
        catch (error) { persistRejected = error; }
        const failedSnapshot = buildStatusSnapshot(paidAgent.get('paid-transition'));
        const failedDiskOrder = JSON.parse(fs.readFileSync(paidFile, 'utf8')).orders.find(order => order.id === 'paid-transition');
        ok('real paid-ledger failure is propagated with a stable error code', persistRejected && persistRejected.code === 'ORDER_PERSIST_FAILED');
        ok('GET/SSE and the last durable snapshot both remain unpaid after save failure', !failedSnapshot.paid && failedDiskOrder && !failedDiskOrder.paid);
        ok('real paid-ledger failure does not emit fulfillment', paidCalls === 0);

        transitionFile = paidFile;
        const settled = await paidAgent.check('paid-transition');
        ok('successful paid persistence publishes the transition', settled.paid && paidAgent.get('paid-transition').paid);
        ok('onPaid observes the already-durable paid transition exactly once', paidCalls === 1);
        clock = 2;
        await paidAgent.tick();
        const retiredDisk = JSON.parse(fs.readFileSync(paidFile, 'utf8')).orders.find(order => order.id === 'paid-transition');
        ok('paid retention becomes invisible only after durable ledger deletion', paidAgent.get('paid-transition') === null && retiredDisk == null);
        agent.stop(); badAgent.stop(); partialAgent.stop();
        paidAgent.stop();
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }

    console.log(`\n${fail === 0 ? 'ALL GREEN' : 'FAILED'}  ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
})().catch(error => {
    ok('agent API test completed', false, error.message);
    console.log(`\nFAILED  ${pass} passed, ${fail} failed`);
    process.exit(1);
});
