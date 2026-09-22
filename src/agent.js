// Manage payment orders and their settlement lifecycle.
const { randomUUID } = require('node:crypto');
const { xmrToPico, picoToXmrString } = require('./verify');
const { toInvoiceState } = require('./state');

function createPaymentAgent({ scanner, store, minConfirmations = 1, pollMs = 15000, activePollMs = 15000, activeWindowMs = 1800000, activeHint, onPaid, onUpdate, onExpire, idgen, subaddressPool = 0, poolLabel = '', expiryMs = 0, paidRetentionMs = 0, toleranceXmr = '0', now = Date.now } = {}) {
    if (!scanner || typeof scanner.checkOrder !== 'function' || typeof scanner.newSubaddress !== 'function') {
        throw new Error('a scanner with newSubaddress() and checkOrder() is required');
    }
    const orders = store || new Map();
    const reserving = new Set();

    const usedIndexes = new Set();
    for (const o of orders.values()) { if (o && o.index != null) usedIndexes.add(o.index); }
    const nextId = idgen || (() => `ord_${randomUUID()}`);

    const pool = [];
    let filling = false;
    const poolFloor = Math.max(2, Math.ceil(subaddressPool / 4));
    async function fillPool(n) {
        if (filling || n <= 0) return;
        filling = true;
        try { for (let i = 0; i < n; i++) { const s = await scanner.newSubaddress(poolLabel); pool.push({ address: s.address, index: s.index, atHeight: s.atHeight }); } }
        catch {   }
        finally { filling = false; }
    }

    async function createOrder({ amount, id, index, label } = {}) {
        if (id != null && !((typeof id === 'string' && id.length > 0 && id.length <= 2048) || (Number.isSafeInteger(id) && id >= 0))) throw new Error('invalid order id');
        if (index != null && (!Number.isSafeInteger(index) || index < 0)) throw new Error('invalid subaddress index');
        if (label != null && (typeof label !== 'string' || label.length > 256)) throw new Error('invalid order label');
        if (amount == null || amount === '') throw new Error('amount is required');

        let expectedPico;
        try { expectedPico = xmrToPico(amount); }
        catch { throw new Error(`amount is not a valid XMR value: ${amount}`); }
        if (expectedPico <= 0n) throw new Error('amount must be greater than 0');
        const oid = id ?? nextId();

        if (orders.has(oid) || reserving.has(oid)) throw new Error(`order ${oid} already exists`);
        reserving.add(oid);
        try {
            let address, idx, birthdayHeight = null;
            if (index != null) {

                if (usedIndexes.has(index)) throw new Error(`subaddress index ${index} is already assigned to another order`);
                usedIndexes.add(index);
                idx = index;
                try { address = await scanner.addressAt(index); }
                catch (e) { usedIndexes.delete(index); throw e; }
            } else {

                let tries = 0;
                while (idx == null) {
                    if (++tries > 10000) throw new Error('could not obtain an unused subaddress index');
                    let cand;
                    if (pool.length) {
                        cand = pool.shift();
                        if (subaddressPool && pool.length < poolFloor) fillPool(subaddressPool - pool.length);
                    } else {
                        cand = await scanner.newSubaddress(label || oid);
                    }
                    if (!usedIndexes.has(cand.index)) { usedIndexes.add(cand.index); idx = cand.index; address = cand.address; birthdayHeight = cand.atHeight; }

                }
            }

            const amountStr = picoToXmrString(expectedPico);
            const order = { id: oid, amount: amountStr, address, index: idx, birthdayHeight, createdAt: now(), status: 'pending', state: 'created', paid: false, receivedXmr: 0, shortfallXmr: amountStr, txids: [] };
            orders.set(oid, order);
            kick();
            return { ...order };
        } finally {
            reserving.delete(oid);
        }
    }

    function applyResult(order, r) {
        const wasPaid = order.paid;

        if (wasPaid && !r.paid) {
            if (r.confirmations != null) order.confirmations = r.confirmations;
            const kept = { ...order };
            if (onUpdate) { try { onUpdate(kept); } catch {   } }
            return kept;
        }
        order.status = r.status;

        const nextState = toInvoiceState(r.status);
        if (nextState) order.state = nextState;
        order.paid = r.paid;
        order.receivedXmr = r.receivedXmr;
        if (r.receivedPico != null) order.receivedPico = r.receivedPico;
        order.pendingXmr = r.pendingXmr;
        order.lockedXmr = r.lockedXmr;
        order.shortfallXmr = r.shortfallXmr;
        order.overpaid = !!r.overpaid;
        order.overpaidXmr = r.overpaidXmr != null ? r.overpaidXmr : '0';
        order.confirmations = r.confirmations;
        order.txids = r.txids;
        if (r.paid && !wasPaid) order.paidAt = now();
        const result = { ...order };
        if (r.paid && !wasPaid) {

            if (onPaid) { Promise.resolve().then(() => onPaid(result)).catch(() => {}); }
        } else if (onUpdate) { try { onUpdate(result); } catch {   } }
        return result;
    }

    async function check(id, { sync = true } = {}) {
        const order = orders.get(id);
        if (!order) return null;
        const r = await scanner.checkOrder({ subaddressIndex: order.index, amount: order.amount, minConfirmations, minHeight: order.birthdayHeight, sync, toleranceXmr });
        return applyResult(order, r);
    }

    async function tick() {
        if (typeof scanner.sync === 'function') {
            try { await scanner.sync(); } catch { return; }
        }
        const nowMs = (expiryMs > 0 || paidRetentionMs > 0) ? now() : 0;
        const toCheck = [];
        const checked = new Set();
        for (const order of orders.values()) {

            if (order.paid) {

                if (order.webhookDelivered !== false && paidRetentionMs > 0 && order.paidAt != null && (nowMs - order.paidAt) >= paidRetentionMs) {
                    orders.delete(order.id);
                }
                continue;
            }
            toCheck.push(order);
        }
        if (toCheck.length === 0) return;

        if (typeof scanner.checkOrders === 'function') {
            let results;
            try { results = await scanner.checkOrders(toCheck.map(o => ({ id: o.id, index: o.index, amount: o.amount, birthdayHeight: o.birthdayHeight })), { minConfirmations, toleranceXmr, sync: false }); }
            catch { return; }
            for (const order of toCheck) { const r = results.get(order.id); if (r) { applyResult(order, r); checked.add(order.id); } }
        } else {

            for (const order of toCheck) { try { await check(order.id, { sync: false }); checked.add(order.id); } catch {   } }
        }

        if (expiryMs > 0) {
            for (const order of toCheck) {
                if (order.paid || !checked.has(order.id)) continue;
                const hasFunds = Number(order.receivedXmr) > 0 || Number(order.pendingXmr) > 0 || Number(order.lockedXmr) > 0 || (order.receivedPico != null && BigInt(order.receivedPico) > 0n);
                if (order.createdAt != null && (nowMs - order.createdAt) >= expiryMs && !hasFunds) {
                    order.status = 'expired';
                    order.state = 'expired';
                    orders.delete(order.id);
                    if (onExpire) { try { await onExpire({ ...order }); } catch {   } }
                }
            }
        }
    }

    let timer = null, running = false, ticking = false;

    function nextDelay() {
        if (activePollMs >= pollMs) return pollMs;
        if (typeof activeHint === 'function') { try { if (activeHint()) return activePollMs; } catch {   } }
        const t = now();
        for (const o of orders.values()) {
            if (!o.paid && o.createdAt != null && (t - o.createdAt) < activeWindowMs) return activePollMs;
        }
        return pollMs;
    }
    function schedule(ms) { if (timer) clearTimeout(timer); timer = setTimeout(loop, ms); if (timer.unref) timer.unref(); }

    function kick() { if (!running || ticking) return; schedule(Math.min(activePollMs, 1500)); }
    async function loop() {
        if (!running) return;
        ticking = true;
        try { await tick(); } finally { ticking = false; }
        if (running) schedule(nextDelay());
    }
    function start() {
        if (running) return;
        running = true;
        if (subaddressPool > 0) fillPool(subaddressPool);
        schedule(nextDelay());
    }
    function stop() { running = false; if (timer) { clearTimeout(timer); timer = null; } }

    return {
        createOrder,
        check,
        tick,
        get: (id) => { const o = orders.get(id); return o ? { ...o } : null; },
        list: () => [...orders.values()].map(o => ({ ...o })),
        poolReady: () => pool.length,
        kick,
        start,
        stop,
    };
}

module.exports = { createPaymentAgent };
