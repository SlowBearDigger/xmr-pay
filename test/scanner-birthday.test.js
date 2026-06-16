// regression guard for the order/birthday binding: an order can only ever be
// paid by money that ARRIVES AFTER it exists. without this, a view-only agent
// that reuses a subaddress index (e.g. restarted in-memory) would settle a brand
// new order with a STALE payment already sitting on that subaddress — the
// false-instant-paid bug. covers toRow (height extraction) + creditableRows
// (the pure filter) + summarizeTransfers downstream.
//   node test/scanner-birthday.test.js

const { toRow, creditableRows } = require('../src/scanner');
const { summarizeTransfers } = require('../src/watch');
const { xmrToPico } = require('../src/verify');

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { (c ? pass++ : fail++); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`); };

// a fake monero-ts incoming transfer (getter style)
const xfer = ({ amount, height, conf = 10, pool = false, unlock = 0 }) => ({
    getAmount: () => BigInt(amount),
    getTx: () => ({
        getNumConfirmations: () => conf,
        getIsConfirmed: () => !pool,
        getInTxPool: () => pool,
        getUnlockTime: () => unlock,
        getHash: () => 'a'.repeat(64),
        getHeight: () => height,
    }),
});

// --- toRow extracts the block height ---
ok('toRow reads confirmed height', toRow(xfer({ amount: 1n, height: 2000 })).height === 2000);
ok('toRow in-pool height is 0', toRow(xfer({ amount: 1n, height: 0, pool: true })).height === 0);

// --- unlock_time: locked ONLY while still in the future (elapsed = spendable) ---
ok('unlock_time 0 → not locked', toRow(xfer({ amount: 1n, height: 2000, unlock: 0 })).locked === false);
ok('FUTURE block-height unlock → locked', toRow(xfer({ amount: 1n, height: 2000, conf: 10, unlock: 10000000 })).locked === true);
ok('PAST/elapsed block-height unlock → NOT locked (was wrongly rejected before)', toRow(xfer({ amount: 1n, height: 2000, conf: 10, unlock: 1010 })).locked === false);
ok('FUTURE timestamp unlock → locked', toRow(xfer({ amount: 1n, height: 2000, conf: 10, unlock: Math.floor(Date.now() / 1000) + 99999 })).locked === true);
ok('PAST timestamp unlock → NOT locked', toRow(xfer({ amount: 1n, height: 2000, conf: 10, unlock: 1600000000 })).locked === false);

// --- creditableRows: the pure filter ---
const rows = [
    { height: 1000, amountPico: 5n, inPool: false },  // stale (old session)
    { height: 2050, amountPico: 5n, inPool: false },  // after birthday
    { height: 0, amountPico: 5n, inPool: true },      // fresh mempool
];
const BIRTHDAY = 2048;
const kept = creditableRows(rows, BIRTHDAY);
ok('drops the stale pre-birthday transfer', !kept.some(r => r.height === 1000));
ok('keeps the post-birthday transfer', kept.some(r => r.height === 2050));
ok('keeps the in-pool transfer', kept.some(r => r.height === 0));
ok('null minHeight keeps everything', creditableRows(rows, null).length === 3);

// grace boundary: a payment a few blocks under the recorded birthday is a
// tip/timing race, NOT a stale payment — keep it (never drop a legit payment).
ok('grace keeps a payment 2 blocks under birthday', creditableRows([{ height: BIRTHDAY - 2, amountPico: 1n, inPool: false }], BIRTHDAY).length === 1);
ok('drops a payment well under birthday', creditableRows([{ height: BIRTHDAY - 50, amountPico: 1n, inPool: false }], BIRTHDAY).length === 0);

// --- end to end: stale payment must NOT settle a new order ---
const required = xmrToPico('0.01'); // 10000000000 pico
const stale = [toRow(xfer({ amount: required, height: 1000 }))];          // full amount, but OLD
const sumStale = summarizeTransfers(creditableRows(stale, BIRTHDAY), required, 1);
ok('stale full payment does NOT pay a new order', sumStale.paid === false && sumStale.status === 'pending');

const fresh = [toRow(xfer({ amount: required, height: 2050 }))];          // full amount, AFTER birthday
const sumFresh = summarizeTransfers(creditableRows(fresh, BIRTHDAY), required, 1);
ok('fresh full payment DOES pay the order', sumFresh.paid === true);

// installments straddling the birthday: only the post-birthday part counts
const half = xmrToPico('0.005');
const split = [
    toRow(xfer({ amount: half, height: 1000 })),  // stale half — ignored
    toRow(xfer({ amount: half, height: 2050 })),  // fresh half — counted
];
const sumSplit = summarizeTransfers(creditableRows(split, BIRTHDAY), required, 1);
ok('only the post-birthday installment is credited', sumSplit.paid === false && sumSplit.shortfallXmr === '0.005' && Number(sumSplit.receivedXmr) === 0.005);

console.log(`\n${fail ? 'FAIL' : 'ALL GREEN'} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
