# Storage & persistence

`xmr-pay` imposes **no database**. The library is storage-agnostic: you decide
where state lives. This doc explains exactly what is stored, where, what is
authoritative vs. reconstructable, and how to swap in your own store.

## TL;DR

- **Funds** live on the **Monero blockchain** — never in this library. The view
  key only *reads* them. Nothing here can lose a payment.
- The agent keeps two pieces of local state, both **files** in the default
  (zero-dependency) setup:
  1. an **order ledger** (which order ⇢ which subaddress, amount, status), and
  2. the **wallet scan cache** (which blocks were scanned, transfers seen).
- The order ledger is just a `store` you inject. Default in the example is a
  flat JSON file; swap in Redis / Postgres / SQLite by passing your own.

---

## The two pieces of state

### 1. The order ledger (the `store`)

`createPaymentAgent({ store })` accepts any **Map-like** object. The agent only
ever calls four methods:

```
store.has(id)   store.set(id, order)   store.get(id)   store.values()
```

Default (no `store` given): an in-memory `Map` — **lost on restart**.

Each entry is a plain order object:

```json
{
  "id": "ord_42",
  "amount": "0.01",
  "address": "75a4WYbe…",      // the per-order subaddress handed to the buyer
  "index": 1,                   // its subaddress index in the wallet
  "birthdayHeight": 2141578,    // only payments AT/AFTER this height count
  "status": "pending",          // pending | partial | mempool | locked | paid
  "paid": false,
  "receivedXmr": 0,
  "shortfallXmr": "0.01",
  "confirmations": 0,
  "txids": []
}
```

`examples/scanner-agent.js` persists this to a JSON file
(`XMR_ORDERS_FILE`, default `orders.json`): loaded at boot, saved on every
create / update / paid, on `SIGINT`, and every 30 s. Zero dependencies, fine for
small/medium volume.

### 2. The wallet scan cache (`XMR_WALLET_PATH`)

The monero-ts wallet (the scanner) persists its scan state — last scanned
height, subaddress allocation, transfers seen — to `XMR_WALLET_PATH` (a
monero-ts cache file, not our format). Without a path it runs **in memory** and
starts at the chain tip every boot.

**These two go together.** The ledger says "order 42 is on subaddress #1
awaiting 0.01"; the wallet cache holds the on-chain scan that proves whether #1
got paid. Persist **both** for restart-safety (see Recovery below).

---

## Restart recovery

On agent restart:

1. The ledger reloads → the agent remembers every pending order and its
   subaddress.
2. The wallet reopens from `XMR_WALLET_PATH` and **syncs forward** from its last
   height → it catches any payment that landed while the agent was down.
3. The poller re-checks each pending order against the (now caught-up) wallet →
   anything paid during the downtime transitions to paid → `onPaid` fires →
   your webhook fulfils the order.

> If you persist the ledger but **not** the wallet (`XMR_WALLET_PATH` unset), a
> restarted wallet starts at the tip and cannot see a payment that arrived
> during the downtime until it's re-derived. Always set both in production. The
> example logs a warning when `XMR_WALLET_PATH` is missing.

**A payment is never lost either way** — it is on-chain in your wallet. What
persistence protects is the **automatic completion** of the matching order.

---

## Bring your own store

Anything Map-shaped works. A Redis-backed example:

```js
const { createPaymentAgent } = require('xmr-pay/agent');

function redisStore(redis, ns = 'xmrpay:') {
  const cache = new Map();                       // hot copy the agent reads/writes
  return {
    has: (id) => cache.has(id),
    get: (id) => cache.get(id),
    values: () => cache.values(),
    keys: () => cache.keys(),
    set: (id, order) => { cache.set(id, order); redis.set(ns + id, JSON.stringify(order)); },
    // call hydrate() once at boot, before agent.start()
    async hydrate() { for (const k of await redis.keys(ns + '*')) cache.set(k.slice(ns.length), JSON.parse(await redis.get(k))); },
  };
}

const store = redisStore(redis);
await store.hydrate();
const agent = createPaymentAgent({ scanner, store, onUpdate: () => {}, /* … */ });
```

The agent mutates order objects in place during a check, then calls
`onUpdate`/`onPaid` — that's your hook to flush to the backing store (the
JSON example writes the whole file there; a DB store can upsert the one order).

SQLite, Postgres, Mongo follow the same shape: a small in-memory map the agent
touches, mirrored to your durable store on `set` / `onUpdate`.

---

## WooCommerce: two layers

The WooCommerce plugin is a thin HTTP client of the agent, so order state lives
in **two** places — linked by the order id + the signed webhook:

```
WordPress DB (MySQL)   ← source of truth for the ORDER (fulfilment, refunds, email).
        │                 stores _xmrpay_address / _amount / _received / _txids.
        │  order_id  ──POST /order──▶  agent      ──order.paid webhook──▶  WP
        ▼
Agent (separate process)  ← orders.json (detection tracker) + wallet cache
        │  view key
        ▼
Monero blockchain         ← source of truth for the FUNDS
```

The merchant's store already owns the order (WP). The agent only needs enough to
*detect* the payment and call back. If the agent's ledger were wiped but the
wallet survived, you'd lose the id⇢subaddress mapping for in-flight orders — so
the agent persists its ledger too.

---

## Source-of-truth hierarchy

1. **Blockchain** — the funds. Absolute.
2. **Order DB** (WP MySQL, or your system) — fulfilment state.
3. **Agent store** (`orders.json` / your DB) — a **reconstructable cache**: it
   maps order ids to subaddresses and caches detection state.

## Backups & ops

- Back up `XMR_ORDERS_FILE` and the `XMR_WALLET_PATH` directory together.
- The wallet cache can be rebuilt from the keys + `XMR_RESTORE_HEIGHT` (re-scan),
  but that costs a full re-sync — backing it up avoids that.
- **Always set `XMR_RESTORE_HEIGHT`** to the address' creation height (or a tip
  snapshot) — an unset/over-low birthday makes the wallet rescan the whole chain.
- The view key in the agent's `.env` can read all incoming payments; keep the
  agent on localhost / behind auth, `.env` at mode 600.
