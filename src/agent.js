// a long-running PAYMENT AGENT: wraps a view-only scanner, manages per-order
// subaddresses + state, and fires a ONE-TIME callback when an order settles. the
// scanner's WASM cold start is paid ONCE at startup; per-order checks are
// incremental (fast). reusable + testable with anything exposing newSubaddress()
// and checkOrder() — so the order lifecycle is unit-tested without monero-ts.
//
//   const agent = createPaymentAgent({ scanner, minConfirmations: 1, onPaid });
//   const o = await agent.createOrder({ id: 'ord_42', amount: '0.05' });  // → {address, ...}
//   const r = await agent.check('ord_42');   // {paid, status, receivedXmr, shortfallXmr, ...}
//   agent.start();   // background poller transitions orders to paid + calls onPaid once

function createPaymentAgent({ scanner, store, minConfirmations = 1, pollMs = 15000, onPaid, onUpdate, idgen } = {}) {
    if (!scanner || typeof scanner.checkOrder !== 'function' || typeof scanner.newSubaddress !== 'function') {
        throw new Error('a scanner with newSubaddress() and checkOrder() is required');
    }
    const orders = store || new Map();
    let counter = 0;
    const nextId = idgen || (() => `ord_${(++counter).toString(36)}`);

    // create an order: derive a fresh per-order subaddress (or bind a given index),
    // record the amount + birthday height. hand `address` to the buyer.
    async function createOrder({ amount, id, index, label } = {}) {
        if (amount == null || amount === '') throw new Error('amount is required');
        const oid = id || nextId();
        if (orders.has(oid)) throw new Error(`order ${oid} already exists`);
        let address, idx, birthdayHeight = null;
        if (index != null) {
            idx = index;
            address = await scanner.addressAt(index);
        } else {
            const sub = await scanner.newSubaddress(label || oid);
            address = sub.address; idx = sub.index; birthdayHeight = sub.atHeight;
        }
        const order = { id: oid, amount: String(amount), address, index: idx, birthdayHeight, status: 'pending', paid: false, receivedXmr: 0, shortfallXmr: String(amount), txids: [] };
        orders.set(oid, order);
        return { ...order };
    }

    // live-check an order against the chain and fold the result into its state.
    // fires onPaid exactly ONCE, on the pending→paid transition. `sync:false`
    // skips the wallet refresh (the poller syncs once per tick — see below).
    async function check(id, { sync = true } = {}) {
        const order = orders.get(id);
        if (!order) return null;
        const r = await scanner.checkOrder({ subaddressIndex: order.index, amount: order.amount, minConfirmations, minHeight: order.birthdayHeight, sync });
        const wasPaid = order.paid;
        order.status = r.status;
        order.paid = r.paid;
        order.receivedXmr = r.receivedXmr;
        order.pendingXmr = r.pendingXmr;
        order.lockedXmr = r.lockedXmr;
        order.shortfallXmr = r.shortfallXmr;
        order.txids = r.txids;
        const result = { ...order };
        if (r.paid && !wasPaid) {
            if (onPaid) { try { await onPaid(result); } catch (e) { /* webhook retries are the caller's job */ } }
        } else if (onUpdate) { try { await onUpdate(result); } catch { /* ignore */ } }
        return result;
    }

    // poll every pending order. sync the wallet ONCE per tick, then check each
    // order WITHOUT re-syncing — O(1) chain round-trips per poll, not O(orders).
    async function tick() {
        if (typeof scanner.sync === 'function') {
            try { await scanner.sync(); } catch { return; }   // node down — skip this tick, keep state
        }
        for (const order of orders.values()) {
            if (order.paid) continue;          // settled — nothing more to do
            try { await check(order.id, { sync: false }); } catch { /* transient; keep polling */ }
        }
    }

    let timer = null, running = false;
    function start() {
        if (running) return;
        running = true;
        const loop = async () => {
            if (!running) return;
            await tick();
            if (running) { timer = setTimeout(loop, pollMs); if (timer.unref) timer.unref(); }
        };
        timer = setTimeout(loop, pollMs); if (timer.unref) timer.unref();
    }
    function stop() { running = false; if (timer) { clearTimeout(timer); timer = null; } }

    return {
        createOrder,
        check,
        tick,
        get: (id) => { const o = orders.get(id); return o ? { ...o } : null; },
        list: () => [...orders.values()].map(o => ({ ...o })),
        start,
        stop,
    };
}

module.exports = { createPaymentAgent };
