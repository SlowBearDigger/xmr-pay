// demonstrates the start-at-tip ("birthday") fast sync: a FRESH merchant scanner
// starts at the current chain height, so its first sync scans ZERO history and is
// near-instant — it then only ever scans FORWARD as new blocks arrive. contrast
// with restoring from a historical height (what a normal wallet must do).
//   NODE_PATH=~/Documents/goxmr-landing/server/node_modules node test/scanner-fastsync.js

const fs = require('fs');
const path = require('path');
const { createScanner } = require('../src/scanner');

const POC = process.env.XMRPAY_POC || require('os').homedir() + '/Documents/goxmr-pay-poc';
const info = JSON.parse(fs.readFileSync(path.join(POC, 'stagenet/info.json'), 'utf8'));
const NODES = ['http://node.monerodevs.org:38089', 'http://node2.monerodevs.org:38089', 'http://stagenet.xmr-tw.org:38081'];

let pass = 0, fail = 0;
const check = (n, c, x = '') => { (c ? pass++ : fail++); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`); };

(async () => {
    const t0 = Date.now();
    // NO restoreHeight → start at "now"
    const s = await createScanner({
        primaryAddress: info.primaryAddress,
        privateViewKey: info.privateViewKey,
        networkType: 'stagenet',
        nodes: NODES,
    });
    const tip = await s.daemonHeight();
    const toScan = Math.max(0, tip - s.birthdayHeight);
    console.log(`daemon tip      : ${tip}`);
    console.log(`birthday height : ${s.birthdayHeight}  (fresh scanner starts here)`);
    console.log(`blocks to scan  : ${toScan}  (vs ${tip - info.restoreHeight} if restoring from the historical height)`);

    // THE optimization: history is no longer scanned (0 blocks vs thousands)
    check('fresh scanner starts at the tip — 0 history blocks to scan', toScan <= 5, `${toScan} blocks`);
    check('scanner is view-only', s.viewOnly === true);

    await s.sync();
    const cold = (Date.now() - t0) / 1000;
    console.log(`\ncold start (WASM create + connect + first sync): ${cold.toFixed(1)}s`);
    console.log('  → this is a ONE-TIME cost for a long-running scanner agent, NOT per order.');
    console.log('  → it is WASM wallet creation + the node handshake, not block scanning (which is 0).');

    const order = await s.newSubaddress('fast order');
    check('new order carries its birthday height', Number.isInteger(order.atHeight) && order.atHeight >= s.birthdayHeight, `atHeight ${order.atHeight}`);

    // warm: a per-order re-check on the already-running scanner only does an
    // incremental refresh — this is the latency a buyer actually sees.
    const tw = Date.now();
    const r = await s.checkOrder({ subaddressIndex: order.index, amount: '0.1' });
    const warm = (Date.now() - tw) / 1000;
    console.log(`warm per-order check (incremental refresh): ${warm.toFixed(1)}s`);
    check('warm per-order check is fast (agent already running)', warm < 15, `${warm.toFixed(1)}s`);
    check('fresh order → pending (live, scanning forward for the payment)', r.status === 'pending' && r.shortfallXmr === '0.1', `${r.status} short ${r.shortfallXmr}`);

    await s.close(false);
    console.log(`\n${fail === 0 ? 'ALL GREEN' : 'FAILED'}  ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('fastsync error:', e); process.exit(2); });
