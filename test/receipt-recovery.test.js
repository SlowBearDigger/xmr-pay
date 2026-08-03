'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { generateSigningKey, configFingerprint } = require('../src/config');
const { createReceiptEnsurer } = require('../src/agent-receipt');

function paidOrder(overrides = {}) {
    return {
        id: 'paid-before-crash',
        address: '7stagenet-order-address',
        amount: '0.1',
        receivedXmr: 0.1,
        receivedPico: '100000000000',
        paid: true,
        paidAt: 1_700_000_000_000,
        status: 'paid',
        confirmations: 1,
        minConfirmations: 1,
        txids: ['paid-tx'],
        revision: 4,
        ...overrides,
    };
}

function agentFor(initial, { crashAfterPersist = false } = {}) {
    let live = { ...initial };
    let durable = { ...initial };
    let persistCalls = 0;
    let publishCalls = 0;
    const agent = {
        get: id => id === live.id ? { ...live } : null,
        update: (id, fields) => {
            assert.equal(id, live.id);
            publishCalls++;
            live = { ...live, ...fields, revision: live.revision + 1 };
            return { ...live };
        },
    };
    return {
        agent,
        persistOrder: async candidate => {
            persistCalls++;
            durable = { ...candidate };
            if (crashAfterPersist) throw Object.assign(new Error('simulated process crash'), { simulatedCrash: true });
        },
        durable: () => ({ ...durable }),
        live: () => ({ ...live }),
        counts: () => ({ persistCalls, publishCalls }),
    };
}

test('a receipt is durable before it becomes live', async () => {
    const key = generateSigningKey().privateKey;
    const runtime = agentFor(paidOrder());
    const sequence = [];
    const ensureReceipt = createReceiptEnsurer({
        agent: runtime.agent,
        persistOrder: async candidate => {
            sequence.push('persist');
            await runtime.persistOrder(candidate);
        },
        publishReceipt: (id, receipt) => {
            sequence.push('publish');
            return runtime.agent.update(id, { receipt });
        },
        receiptKey: key,
        receiptFingerprint: configFingerprint(require('node:crypto').createPublicKey(key).export({ type: 'spki', format: 'pem' })),
        network: 'stagenet',
        includeTxProofs: false,
    });

    const recovered = await ensureReceipt('paid-before-crash');
    assert.deepEqual(sequence, ['persist', 'publish']);
    assert.ok(runtime.durable().receipt);
    assert.deepEqual(recovered.receipt, runtime.durable().receipt);
    assert.equal(runtime.durable().revision, 5);
    assert.equal(recovered.revision, 5);
});

test('restart recovery reuses the receipt persisted before a crash without duplicate publication', async () => {
    const key = generateSigningKey().privateKey;
    const firstRuntime = agentFor(paidOrder(), { crashAfterPersist: true });
    const firstEnsure = createReceiptEnsurer({
        agent: firstRuntime.agent,
        persistOrder: firstRuntime.persistOrder,
        receiptKey: key,
        receiptFingerprint: 'test-fingerprint',
        network: 'stagenet',
        includeTxProofs: false,
    });

    await assert.rejects(() => firstEnsure('paid-before-crash'), error => error.simulatedCrash === true);
    assert.ok(firstRuntime.durable().receipt, 'the crash happens after the receipt is durable');
    assert.equal(firstRuntime.live().receipt, undefined, 'the old process never published the receipt');

    const restartedRuntime = agentFor(firstRuntime.durable());
    const restartedEnsure = createReceiptEnsurer({
        agent: restartedRuntime.agent,
        persistOrder: restartedRuntime.persistOrder,
        receiptKey: key,
        receiptFingerprint: 'test-fingerprint',
        network: 'stagenet',
        includeTxProofs: false,
    });
    const restored = await restartedEnsure('paid-before-crash');

    assert.ok(restored.receipt);
    assert.deepEqual(restartedRuntime.counts(), { persistCalls: 0, publishCalls: 0 });
});

test('unpaid orders never receive a receipt during recovery', async () => {
    const key = generateSigningKey().privateKey;
    const runtime = agentFor(paidOrder({ paid: false, status: 'pending' }));
    const ensureReceipt = createReceiptEnsurer({
        agent: runtime.agent,
        persistOrder: runtime.persistOrder,
        receiptKey: key,
        receiptFingerprint: 'test-fingerprint',
        network: 'stagenet',
        includeTxProofs: false,
    });

    const result = await ensureReceipt('paid-before-crash');
    assert.equal(result.receipt, undefined);
    assert.deepEqual(runtime.counts(), { persistCalls: 0, publishCalls: 0 });
});

test('concurrent live and sweep recovery coalesce to one durable receipt transition', async () => {
    const key = generateSigningKey().privateKey;
    const runtime = agentFor(paidOrder());
    let releasePersist;
    const persistGate = new Promise(resolve => { releasePersist = resolve; });
    const ensureReceipt = createReceiptEnsurer({
        agent: runtime.agent,
        persistOrder: async candidate => {
            await runtime.persistOrder(candidate);
            await persistGate;
        },
        receiptKey: key,
        receiptFingerprint: 'test-fingerprint',
        network: 'stagenet',
        includeTxProofs: false,
    });

    const live = ensureReceipt('paid-before-crash');
    const sweep = ensureReceipt('paid-before-crash');
    await new Promise(resolve => setImmediate(resolve));
    releasePersist();
    const [fromLive, fromSweep] = await Promise.all([live, sweep]);

    assert.deepEqual(fromLive.receipt, fromSweep.receipt);
    assert.deepEqual(runtime.counts(), { persistCalls: 1, publishCalls: 1 });
});
