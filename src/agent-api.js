'use strict';

const { saveOrderLedger } = require('./order-ledger');

function persistenceError(error) {
    if (error && typeof error === 'object') error.code = 'ORDER_PERSIST_FAILED';
    return error;
}

function acceptSavedState(ledgerState, saved) {
    ledgerState.generation = saved.generation;
    ledgerState.legacy = saved.legacy;
    ledgerState.recoveredFromBackup = saved.recoveredFromBackup;
}

async function createDurableOrder({ agent, ledgerState, ledgerFile, order } = {}) {
    if (!agent || typeof agent.createOrder !== 'function' || typeof agent.usedSubaddressHighWater !== 'function') throw new Error('payment agent is required');
    const created = await agent.createOrder(order);
    ledgerState.usedSubaddressHighWater = agent.usedSubaddressHighWater();
    try { saveOrderLedger(ledgerFile, ledgerState); }
    catch (error) {
        // The allocated subaddress stays burned, but an unacknowledged order must
        // not remain observable or reach the poller. A compensating save also
        // replaces any newer backup written before the primary rename failed.
        ledgerState.store.delete(created.id);
        try { saveOrderLedger(ledgerFile, ledgerState); } catch { /* best effort while storage is unavailable */ }
        throw persistenceError(error);
    }
    return agent.get(created.id);
}

function persistOrderTransition({ ledgerState, ledgerFile, order } = {}) {
    if (!ledgerState || !(ledgerState.store instanceof Map)) throw new Error('order ledger state is required');
    if (!order || typeof order.id !== 'string' || !ledgerState.store.has(order.id)) throw new Error('an existing order transition is required');
    const staged = { ...ledgerState, store: new Map(ledgerState.store) };
    staged.store.set(order.id, { ...order });
    try { saveOrderLedger(ledgerFile, staged); }
    catch (error) { throw persistenceError(error); }
    acceptSavedState(ledgerState, staged);
    return { ...order };
}

function persistOrderRetirement({ ledgerState, ledgerFile, orderId } = {}) {
    if (!ledgerState || !(ledgerState.store instanceof Map)) throw new Error('order ledger state is required');
    if (typeof orderId !== 'string' || !ledgerState.store.has(orderId)) throw new Error('an existing order retirement is required');
    const staged = { ...ledgerState, store: new Map(ledgerState.store) };
    staged.store.delete(orderId);
    try { saveOrderLedger(ledgerFile, staged); }
    catch (error) { throw persistenceError(error); }
    acceptSavedState(ledgerState, staged);
}

function buildStatusSnapshot(order, { minConfirmations = 1 } = {}) {
    if (!order) return null;
    return {
        id: order.id,
        address: order.address,
        amount: order.amount,
        paid: !!order.paid,
        status: order.status,
        receivedXmr: order.receivedXmr == null ? 0 : order.receivedXmr,
        lockedXmr: order.lockedXmr == null ? 0 : order.lockedXmr,
        shortfallXmr: order.shortfallXmr,
        overpaid: !!order.overpaid,
        overpaidXmr: order.overpaidXmr || '0',
        confirmations: order.confirmations == null ? 0 : order.confirmations,
        minConfirmations: Number.isSafeInteger(order.minConfirmations) ? order.minConfirmations : minConfirmations,
        syncing: !!order.syncing,
        txids: Array.isArray(order.txids) ? order.txids : [],
        webhookDelivered: order.webhookDelivered !== false,
        birthdayHeight: order.birthdayHeight == null ? null : order.birthdayHeight,
        revision: order.revision,
    };
}

module.exports = { createDurableOrder, persistOrderTransition, persistOrderRetirement, buildStatusSnapshot };
