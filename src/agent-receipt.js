'use strict';

const { receiptFromOrder, signReceipt } = require('./receipt');

function createReceiptEnsurer({
    agent,
    persistOrder,
    publishReceipt,
    receiptKey,
    receiptFingerprint,
    scanner = null,
    network,
    merchantName,
    includeTxProofs = true,
    onProofError = () => {},
    now = Date.now,
} = {}) {
    if (!agent || typeof agent.get !== 'function' || typeof agent.update !== 'function') {
        throw new TypeError('agent with get/update is required');
    }
    if (typeof persistOrder !== 'function') throw new TypeError('persistOrder is required');
    const publish = publishReceipt || ((id, receipt) => agent.update(id, { receipt }));
    const inflight = new Map();

    async function ensureReceiptNow(orderId) {
        const order = agent.get(orderId);
        if (!order || !order.paid || order.receipt || !receiptKey) return order;

        const txProofs = [];
        if (includeTxProofs && scanner && typeof scanner.txProof === 'function') {
            for (const txid of order.txids || []) {
                try { txProofs.push(await scanner.txProof(txid, order.index)); }
                catch (error) { onProofError(error, txid, order); }
            }
        }

        const merchant = { fingerprint: receiptFingerprint };
        if (merchantName) merchant.name = merchantName;
        const receipt = signReceipt(receiptFromOrder(order, {
            merchant,
            network,
            paidAt: order.paidAt == null ? now() : order.paidAt,
            txProofs,
        }), receiptKey);
        const revision = Number(order.revision);
        if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('order revision is invalid');
        const candidate = { ...order, receipt, revision: revision + 1 };

        await persistOrder(candidate);
        return publish(order.id, receipt);
    }

    return function ensureReceipt(orderId) {
        if (inflight.has(orderId)) return inflight.get(orderId);
        const pending = ensureReceiptNow(orderId).then(
            result => { inflight.delete(orderId); return result; },
            error => { inflight.delete(orderId); throw error; },
        );
        inflight.set(orderId, pending);
        return pending;
    };
}

module.exports = { createReceiptEnsurer };
