// Regression checks for payment lifecycle and malformed order input.
const assert = require('node:assert/strict');
const { createPaymentAgent } = require('../src/agent');
const { toRow } = require('../src/scanner');
let failures = 0;
async function test(name, fn) {
    try { await fn(); console.log('PASS', name); }
    catch (error) { failures++; console.error('FAIL', name, error.message); }
}
function setup(options = {}) {
    let index = 0;
    const scanner = {
        async newSubaddress() { return { address: `s${++index}`, index }; },
        async addressAt(i) { return `s${i}`; },
        async checkOrder() { return { paid: false, status: 'pending', receivedXmr: 0, pendingXmr: 0, lockedXmr: 0 }; },
    };
    return { scanner, agent: createPaymentAgent({ scanner, ...options }) };
}
(async () => {
    for (const field of ['pendingXmr', 'lockedXmr']) await test(`expiry preserves ${field}`, async () => {
        const { scanner, agent } = setup({ expiryMs: 1, now: () => 100 });
        const order = await agent.createOrder({ amount: '1' });
        scanner.checkOrder = async () => ({ paid: false, status: 'pending', receivedXmr: 0, [field]: 0.5 });
        const live = agent.get(order.id);
        const store = new Map([[order.id, { ...live, createdAt: 0 }]]);
        const reloaded = createPaymentAgent({ scanner, store, expiryMs: 1, now: () => 100 });
        await reloaded.tick();
        assert.ok(reloaded.get(order.id));
    });
    await test('failed check cannot expire an order', async () => {
        const { scanner } = setup();
        scanner.checkOrder = async () => { throw new Error('offline'); };
        const store = new Map([['a', { id: 'a', amount: '1', index: 1, createdAt: 0, receivedXmr: 0 }]]);
        const agent = createPaymentAgent({ scanner, store, expiryMs: 1, now: () => 100 });
        await agent.tick();
        assert.ok(agent.get('a'));
    });
    await test('retention preserves an undelivered webhook', async () => {
        const store = new Map([['a', { id: 'a', paid: true, paidAt: 0, webhookDelivered: false }]]);
        const { agent } = setup({ store, paidRetentionMs: 1, now: () => 100 });
        await agent.tick();
        assert.ok(agent.get('a'));
    });
    await test('non-scalar order id rejected before allocation', async () => {
        const { agent } = setup();
        await assert.rejects(agent.createOrder({ id: {}, amount: '1' }));
    });
    await test('string index cannot alias a used numeric index', async () => {
        const { agent } = setup();
        await agent.createOrder({ id: 'a', index: 1, amount: '1' });
        await assert.rejects(agent.createOrder({ id: 'b', index: '1', amount: '1' }));
    });
    await test('malformed unlock time fails closed', () => {
        assert.throws(() => toRow({ amount: 1n, tx: { unlockTime: 'invalid', isConfirmed: true, numConfirmations: 10, height: 100 } }));
    });
    process.exitCode = failures ? 1 : 0;
})();
