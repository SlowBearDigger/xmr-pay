// live test of MULTI-payment SUMMING on the order subaddress. the scanner sums
// every payment to a subaddress, so a buyer who tops up an underpayment (or pays
// in installments) completes the order. to exercise it with TWO real on-chain
// payments:
//
//   1. the faucet already sent 0.1 XMR to the order subaddress below.
//   2. send a SECOND stagenet payment to the SAME address from any wallet/faucet:
//        75a4WYbeKsdGjdFHqxpgNMSi3oqb1z9yx9m6qvNt3ZbTBpoFnD7EqicUZtCVsQoNPKXF5cMcTLJaTCkYiZVzddby9zc7bFV
//      stagenet faucet: https://stagenet-faucet.xmr-tw.org/send_tx/?addr=<addr>
//   3. wait ~1 block, then run this (re-run to poll):
//        NODE_PATH=~/Documents/goxmr-landing/server/node_modules node test/live-summing.js
//
// with 1 payment it tells you to fund + re-run; with 2+ it proves the summing.

const fs = require('fs');
const path = require('path');
const { createScanner } = require('../src/scanner');

const POC = process.env.XMRPAY_POC || require('os').homedir() + '/Documents/goxmr-pay-poc';
const info = JSON.parse(fs.readFileSync(path.join(POC, 'stagenet/info.json'), 'utf8'));
const NODES = [info.node, 'http://node.monerodevs.org:38089', 'http://node2.monerodevs.org:38089', 'http://stagenet.xmr-tw.org:38081'];
const IDX = info.orderSubaddressIndex;

let pass = 0, fail = 0, warn = 0;
const check = (n, c, x = '') => { (c ? pass++ : fail++); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`); };
const note = (n, x = '') => { warn++; console.log(`WARN  ${n}${x ? '  — ' + x : ''}`); };

(async () => {
    const s = await createScanner({
        primaryAddress: info.primaryAddress, privateViewKey: info.privateViewKey,
        networkType: 'stagenet', nodes: NODES, restoreHeight: info.restoreHeight,
        path: path.join(POC, 'stagenet/scanner'), password: 'poc-scanner',   // reuse synced wallet
    });
    process.stdout.write('syncing… ');
    await s.sync();
    console.log('done @ ' + (await s.height()));

    // a tiny order just to read the running total + the per-tx list
    const r0 = await s.checkOrder({ subaddressIndex: IDX, amount: '0.000000000001', minConfirmations: 0, sync: false });
    console.log(`\norder subaddress idx ${IDX}: ${info.orderSubaddress}`);
    console.log(`payments seen     : ${r0.txids.length}`);
    console.log(`confirmed total   : ${r0.receivedXmr} XMR   (pending ${r0.pendingXmr} XMR)`);
    r0.txids.forEach((t, i) => console.log(`  [${i}] ${t}`));

    if (r0.txids.length < 2) {
        note(`only ${r0.txids.length} payment seen — send a 2nd stagenet payment to the address above and re-run`);
        console.log('\n(the SUMMING MATH itself is already proven by test/fuzz.test.js (92k cases) + watch.test.js.)');
        await s.close(false);
        console.log(`\n${fail === 0 ? 'OK' : 'FAILED'}  ${pass} passed, ${fail} failed, ${warn} warnings`);
        process.exit(fail === 0 ? 0 : 1);
    }

    // 2+ real payments present → prove the scanner SUMS them. a freshly-confirmed
    // payment is LOCKED for ~10 blocks (Monero's standard output lock), so the 2nd
    // one shows as locked, not yet spendable-confirmed.
    const seen = r0.receivedXmr + r0.pendingXmr + r0.lockedXmr;
    console.log(`  spendable ${r0.receivedXmr} + locked ${r0.lockedXmr} + pool ${r0.pendingXmr}  =  ${seen} XMR on-chain`);
    check('scanner sees BOTH payments', r0.txids.length >= 2);
    check('scanner SUMS them to the full 0.11 on-chain', Math.abs(seen - 0.11) < 1e-9, `seen ${seen}`);

    // order for the full 0.11: the sum is recognized and the buyer owes NOTHING
    // more (shortfall 0). status is 'locked' until the 0.01 matures, then 'paid'.
    let r = await s.checkOrder({ subaddressIndex: IDX, amount: '0.11', sync: false });
    check('order 0.11 → sum recognized, shortfall 0 (nothing more to pay)', r.shortfallXmr === '0' && (r.status === 'locked' || r.status === 'paid'), `status ${r.status}`);
    console.log(`  → order 0.11: ${r.status}${r.status === 'locked' ? '  (the 0.01 is maturing — flips to paid in ~10 blocks)' : '  ✓ fully unlocked'}`);

    // a bigger order than what actually arrived → genuine partial, EXACT shortfall
    r = await s.checkOrder({ subaddressIndex: IDX, amount: '0.16', sync: false });
    check('order 0.16 → partial, EXACT shortfall 0.05', !r.paid && r.status === 'partial' && r.shortfallXmr === '0.05', `status ${r.status} short ${r.shortfallXmr}`);

    await s.close(false);
    console.log(`\n${fail === 0 ? 'ALL GREEN' : 'FAILED'}  ${pass} passed, ${fail} failed, ${warn} warnings`);
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('live-summing error:', e); process.exit(2); });
