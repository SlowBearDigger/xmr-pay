'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createPaymentAgent } = require('../src/agent');

test('concurrent paid orders merge into one durable ledger state', async () => {
    let index = 0;
    const scanner = {
        async newSubaddress() {
            index += 1;
            return { address: `sub_${index}`, index, atHeight: 100 };
        },
        async checkOrder() {
            return {
                paid: true,
                status: 'paid',
                receivedXmr: 0.1,
                receivedPico: '100000000000',
                pendingXmr: 0,
                lockedXmr: 0,
                shortfallXmr: '0',
                confirmations: 1,
                txids: ['confirmed-tx'],
            };
        },
    };
    const store = new Map();
    let durable = new Map();
    const paidEvents = [];
    const agent = createPaymentAgent({
        scanner,
        store,
        minConfirmations: 1,
        persistPaid: async candidate => {
            const snapshot = new Map([...store].map(([id, order]) => [id, { ...order }]));
            snapshot.set(candidate.id, { ...candidate });
            await new Promise(resolve => setImmediate(resolve));
            durable = snapshot;
        },
        onPaid: order => { paidEvents.push(order.id); },
    });

    await agent.createOrder({ id: 'sale-a', amount: '0.1' });
    await agent.createOrder({ id: 'sale-b', amount: '0.1' });
    durable = new Map([...store].map(([id, order]) => [id, { ...order }]));

    await Promise.all([agent.check('sale-a'), agent.check('sale-b')]);

    assert.equal(durable.get('sale-a').paid, true);
    assert.equal(durable.get('sale-b').paid, true);
    assert.deepEqual(paidEvents.sort(), ['sale-a', 'sale-b']);
});
