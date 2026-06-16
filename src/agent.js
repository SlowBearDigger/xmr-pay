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

const { xmrToPico } = require('./verify');   // pure parser; does NOT load monero-ts

function createPaymentAgent({ scanner, store, minConfirmations = 1, pollMs = 15000, onPaid, onUpdate, onExpire, idgen, subaddressPool = 0, poolLabel = '', expiryMs = 0, paidRetentionMs = 0, toleranceXmr = '0', now = Date.now } = {}) {
    if (!scanner || typeof scanner.checkOrder !== 'function' || typeof scanner.newSubaddress !== 'function') {
        throw new Error('a scanner with newSubaddress() and checkOrder() is required');
    }
    const orders = store || new Map();
    const reserving = new Set();   // ids in-flight (created but not yet stored) — closes the create-order TOCTOU
    // every subaddress index EVER bound to an order. a Monero subaddress must back
    // AT MOST ONE order: if two orders shared an index, a single payment to it
    // would credit BOTH (double-credit — the merchant ships twice for one payment).
    // this set is the guard. it's rebuilt from the store on boot and only GROWS —
    // a used index is never reassigned, even after its order is paid/expired, so a
    // late payment to an old subaddress can't credit a fresh order.
    const usedIndexes = new Set();
    for (const o of orders.values()) { if (o && o.index != null) usedIndexes.add(o.index); }
    let counter = 0;
    const nextId = idgen || (() => `ord_${(++counter).toString(36)}`);

    // OPTIONAL pre-warmed subaddress pool. createSubaddress() is slow while a
    // wallet sync holds the lock, so an order created mid-sync can stall for
    // seconds. pre-creating subaddresses (before the poller starts, and topping
    // up in the background) makes createOrder instant. each entry keeps its
    // birthday height, so the order/birthday binding is preserved.
    const pool = [];
    let filling = false;
    const poolFloor = Math.max(2, Math.ceil(subaddressPool / 4));
    async function fillPool(n) {
        if (filling || n <= 0) return;
        filling = true;
        try { for (let i = 0; i < n; i++) { const s = await scanner.newSubaddress(poolLabel); pool.push({ address: s.address, index: s.index, atHeight: s.atHeight }); } }
        catch { /* node busy — top up on the next createOrder/tick */ }
        finally { filling = false; }
    }

    // create an order: derive a fresh per-order subaddress (or bind a given index),
    // record the amount + birthday height. hand `address` to the buyer.
    async function createOrder({ amount, id, index, label } = {}) {
        if (amount == null || amount === '') throw new Error('amount is required');
        // validate the amount BEFORE allocating a subaddress: a bad value would
        // otherwise waste a pool entry and wedge the poller (it throws every tick),
        // and amount "0" would summarize as instantly-paid (0 >= 0) with no funds.
        let expectedPico;
        try { expectedPico = xmrToPico(amount); }
        catch { throw new Error(`amount is not a valid XMR value: ${amount}`); }
        if (expectedPico <= 0n) throw new Error('amount must be greater than 0');
        const oid = id || nextId();
        // reject duplicates AND reserve the id BEFORE any await — otherwise two
        // concurrent createOrder calls with the same id both pass the has() check
        // and both allocate a subaddress (the order would point at only the last).
        if (orders.has(oid) || reserving.has(oid)) throw new Error(`order ${oid} already exists`);
        reserving.add(oid);
        try {
            let address, idx, birthdayHeight = null;
            if (index != null) {
                // explicit bind: refuse an index already held by another order —
                // reusing it would let one payment settle two orders. RESERVE it
                // synchronously (before any await) so two concurrent binds of the
                // same index can't both pass the check (a check-then-act TOCTOU).
                if (usedIndexes.has(index)) throw new Error(`subaddress index ${index} is already assigned to another order`);
                usedIndexes.add(index);
                idx = index;
                try { address = await scanner.addressAt(index); }
                catch (e) { usedIndexes.delete(index); throw e; }   // roll back the reservation if the lookup fails
            } else {
                // take a FRESH subaddress (pool if warm, else create one), skipping
                // any candidate whose index is already in use — defends against a
                // pool/wallet-counter collision (e.g. a lost wallet cache re-issuing
                // low indices that overlap reloaded orders). reserve each chosen
                // index synchronously (no await between the has() check and add()).
                let tries = 0;
                while (idx == null) {
                    if (++tries > 10000) throw new Error('could not obtain an unused subaddress index');
                    let cand;
                    if (pool.length) {
                        cand = pool.shift();
                        if (subaddressPool && pool.length < poolFloor) fillPool(subaddressPool - pool.length);   // top up in the background
                    } else {
                        cand = await scanner.newSubaddress(label || oid);
                    }
                    if (!usedIndexes.has(cand.index)) { usedIndexes.add(cand.index); idx = cand.index; address = cand.address; birthdayHeight = cand.atHeight; }
                    // else: collision → discard this candidate and take the next
                }
            }
            const order = { id: oid, amount: String(amount), address, index: idx, birthdayHeight, createdAt: now(), status: 'pending', paid: false, receivedXmr: 0, shortfallXmr: String(amount), txids: [] };
            orders.set(oid, order);
            return { ...order };
        } finally {
            reserving.delete(oid);
        }
    }

    // live-check an order against the chain and fold the result into its state.
    // fires onPaid exactly ONCE, on the pending→paid transition. `sync:false`
    // skips the wallet refresh (the poller syncs once per tick — see below).
    // fold a check result into an order's state; fire onPaid EXACTLY ONCE on the
    // pending→paid transition. shared by the single check() and the batch tick().
    function applyResult(order, r) {
        const wasPaid = order.paid;
        order.status = r.status;
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
        if (r.paid && !wasPaid) order.paidAt = now();   // stamp settlement (for the retention sweep)
        const result = { ...order };
        if (r.paid && !wasPaid) {
            // fire without awaiting so a slow webhook delivery never stalls the poll.
            if (onPaid) { Promise.resolve().then(() => onPaid(result)).catch(() => {}); }
        } else if (onUpdate) { try { onUpdate(result); } catch { /* ignore */ } }
        return result;
    }

    async function check(id, { sync = true } = {}) {
        const order = orders.get(id);
        if (!order) return null;
        const r = await scanner.checkOrder({ subaddressIndex: order.index, amount: order.amount, minConfirmations, minHeight: order.birthdayHeight, sync, toleranceXmr });
        return applyResult(order, r);
    }

    // poll: sync ONCE per tick, sweep expiry/retention, then check ALL pending
    // orders in ONE batch getTransfers — O(1) wallet queries per poll, not O(orders).
    // (the old path did one getTransfers PER order: 1000 pending orders → 1000
    // queries/tick → detection latency grew linearly. now 1000 orders = 1 query.)
    async function tick() {
        if (typeof scanner.sync === 'function') {
            try { await scanner.sync(); } catch { return; }   // node down — skip this tick, keep state
        }
        const nowMs = (expiryMs > 0 || paidRetentionMs > 0) ? now() : 0;
        const toCheck = [];
        for (const order of orders.values()) {
            // LATCH: a settled order is never re-checked. minConfirmations is the
            // reorg defence — an order only settles once its payment is that deep,
            // so a reorg shallower than minConfirmations can't falsely complete it
            // (the pre-settlement path re-evaluates every tick). a reorg DEEPER
            // than minConfirmations after settlement is the merchant's accepted
            // risk, bounded by minConfirmations — we don't un-capture a sale. set
            // minConfirmations to your value-at-risk. (see docs/AGENT.md → reorgs)
            if (order.paid) {
                // RETENTION: a settled order's work is done (onPaid already fired,
                // the store/webhook holds the record). keeping it forever leaks
                // memory + bloats every ledger save. drop it once it's older than
                // paidRetentionMs. 0 = keep forever (default). GET /order|/receipt
                // 404s after this, so set it well past your buyers' poll window.
                if (paidRetentionMs > 0 && order.paidAt != null && (nowMs - order.paidAt) >= paidRetentionMs) {
                    orders.delete(order.id);
                }
                continue;
            }
            // EXPIRY: drop a still-unpaid order once it's older than expiryMs. this
            // bounds both the per-tick work and memory — without it, abandoned
            // orders accumulate forever and every poll checks all of them. a late
            // payment to an expired order still lands on-chain in YOUR wallet; it
            // just won't auto-complete (reconcile via onExpire). off by default.
            // NEVER expire an order that already RECEIVED funds (a partial payment):
            // dropping it would orphan a top-up and lose the buyer's money on a
            // vanished order. keep it alive so a top-up still completes it — the
            // principle both MoneroPay (never auto-deletes) and BTCPay (preserves the
            // payment record past expiry) hold to: a payment is never orphaned.
            const hasFunds = Number(order.receivedXmr) > 0 || (order.receivedPico != null && BigInt(order.receivedPico) > 0n);
            if (expiryMs > 0 && order.createdAt != null && (nowMs - order.createdAt) >= expiryMs && !hasFunds) {
                order.status = 'expired';
                orders.delete(order.id);                                  // safe to delete the current entry mid-iteration
                if (onExpire) { try { await onExpire({ ...order }); } catch { /* caller's job */ } }
                continue;
            }
            toCheck.push(order);   // collect; checked in ONE batch below
        }
        if (toCheck.length === 0) return;
        // ONE account-wide getTransfers, distributed across every pending order.
        if (typeof scanner.checkOrders === 'function') {
            let results;
            try { results = await scanner.checkOrders(toCheck.map(o => ({ id: o.id, index: o.index, amount: o.amount, birthdayHeight: o.birthdayHeight })), { minConfirmations, toleranceXmr, sync: false }); }
            catch { return; }   // transient; keep state, retry next tick
            for (const order of toCheck) { const r = results.get(order.id); if (r) applyResult(order, r); }
        } else {
            // fallback for a scanner without batch support (e.g. a test mock): per-order
            for (const order of toCheck) { try { await check(order.id, { sync: false }); } catch { /* transient */ } }
        }
    }

    let timer = null, running = false;
    function start() {
        if (running) return;
        running = true;
        if (subaddressPool > 0) fillPool(subaddressPool);   // pre-warm BEFORE the first sync holds the wallet lock
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
        poolReady: () => pool.length,
        start,
        stop,
    };
}

module.exports = { createPaymentAgent };
