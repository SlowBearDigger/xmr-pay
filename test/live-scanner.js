// live stagenet validation of the view-only SCANNER (Modo A / Level 2): build a
// watch-only wallet from (primary address + view key) ONLY — no spend key — scan
// the order subaddress for the real faucet payment, and prove the SUMMING + EXACT
// shortfall math against real chain data. optionally self-sends a second payment
// to prove LIVE summing of two on-chain payments.
//
//   NODE_PATH=~/Documents/goxmr-landing/server/node_modules node test/live-scanner.js

const fs = require('fs');
const path = require('path');
const { createScanner } = require('../src/scanner');

const POC = process.env.XMRPAY_POC || require('os').homedir() + '/Documents/goxmr-pay-poc';
const info = JSON.parse(fs.readFileSync(path.join(POC, 'stagenet/info.json'), 'utf8'));
const NODES = [info.node, 'http://node.monerodevs.org:38089', 'http://node2.monerodevs.org:38089', 'http://stagenet.xmr-tw.org:38081'];
const NET = 'stagenet';
const IDX = info.orderSubaddressIndex;   // the faucet paid 0.1 XMR to this index

let pass = 0, fail = 0, warn = 0;
const check = (n, c, x = '') => { (c ? pass++ : fail++); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`); };
const note = (n, x = '') => { warn++; console.log(`WARN  ${n}${x ? '  — ' + x : ''}`); };

(async () => {
    const scanner = await createScanner({
        primaryAddress: info.primaryAddress,
        privateViewKey: info.privateViewKey,
        networkType: NET,
        nodes: NODES,
        restoreHeight: info.restoreHeight,
        // reuse the POC's already-synced view-only wallet so this is fast and
        // non-destructive (closed without saving); createScanner opens it by path.
        path: path.join(POC, 'stagenet/scanner'),
        password: 'poc-scanner',
    });
    console.log(`scanner connected: ${scanner.node}`);
    check('scanner is view-only (no spend key — non-custodial)', scanner.viewOnly === true);

    // the per-order subaddress derived from (address + view key) alone must match
    const derived = await scanner.addressAt(IDX);
    check(`view-only derives the order subaddress (idx ${IDX})`, derived === info.orderSubaddress, derived);

    process.stdout.write('syncing the view-only wallet (first run loads WASM + scans)… ');
    await scanner.sync();
    console.log('done @ height ' + (await scanner.height()));

    // read the EXACT on-chain total in piconero (via the shortfall against a large
    // order) so the assertions are robust to however many payments are present.
    const { xmrToPico, picoToXmrString } = require('../src/verify');
    const probe = await scanner.checkOrder({ subaddressIndex: IDX, amount: '1000', sync: false });
    const totalPico = xmrToPico('1000') - xmrToPico(probe.shortfallXmr);
    const totalStr = picoToXmrString(totalPico);
    const plus = (d) => picoToXmrString(totalPico + xmrToPico(d));
    console.log(`scanner sees ${probe.txids.length} payment(s), total ${totalStr} XMR on idx ${IDX}`);
    check('scanner detected at least the faucet 0.1 via the view key', totalPico >= xmrToPico('0.1'), `${totalStr} XMR`);

    // an order for the exact total → covered (paid, or locked if still maturing)
    let r = await scanner.checkOrder({ subaddressIndex: IDX, amount: totalStr, sync: false });
    check('order == on-chain total → covered, shortfall 0', r.shortfallXmr === '0' && (r.paid || r.status === 'locked'), `status ${r.status}`);

    // total + 0.1 → partial, EXACT shortfall 0.1
    r = await scanner.checkOrder({ subaddressIndex: IDX, amount: plus('0.1'), sync: false });
    check('order = total + 0.1 → not paid, EXACT shortfall 0.1', !r.paid && r.shortfallXmr === '0.1', `short ${r.shortfallXmr}`);

    // nonce-grade — shortfall exact to the piconero against real chain data
    r = await scanner.checkOrder({ subaddressIndex: IDX, amount: plus('0.050000004821'), sync: false });
    check('nonce order → EXACT shortfall 0.050000004821', r.shortfallXmr === '0.050000004821', r.shortfallXmr);

    // a tiny order is always covered by the total
    r = await scanner.checkOrder({ subaddressIndex: IDX, amount: '0.01', sync: false });
    check('small order 0.01 → covered by the total', r.paid || r.status === 'locked', `status ${r.status}`);

    // a fresh per-order subaddress with no payment → pending, shortfall = full amount
    const freshSub = await scanner.newSubaddress('live-scanner order');
    check('newSubaddress returns an address + index', !!freshSub.address && Number.isInteger(freshSub.index), JSON.stringify(freshSub));
    r = await scanner.checkOrder({ subaddressIndex: freshSub.index, amount: '0.3', sync: false });
    check('fresh order → pending, shortfall = full 0.3', !r.paid && r.status === 'pending' && r.shortfallXmr === '0.3', `${r.status} short ${r.shortfallXmr}`);

    // ── optional: prove LIVE summing of a SECOND on-chain payment ────────────
    // self-send a little to the order subaddress, then re-scan: the scanner must
    // SEE and SUM it on top of the faucet 0.1. needs the merchant spend wallet +
    // funds; WARN-skip otherwise (the math itself is covered by fuzz + watch tests).
    try {
        const monerojs = require('monero-ts');
        const merchant = await monerojs.openWalletFull({ path: path.join(POC, 'stagenet/merchant'), password: 'poc-stagenet', networkType: NET });
        for (const u of NODES) { try { await merchant.setDaemonConnection(u); if (await merchant.isConnectedToDaemon()) break; } catch { /* next */ } }
        await merchant.sync(info.restoreHeight);
        const unlocked = BigInt((await merchant.getUnlockedBalance()).toString());
        if (unlocked > 30000000000n) {
            const tx = await merchant.createTx({ accountIndex: 0, address: info.orderSubaddress, amount: 10000000000n, relay: true }); // 0.01
            console.log(`\nself-sent 0.01 XMR → order subaddress  tx=${tx.getHash()}\n  polling the scanner to SUM the second payment…`);
            let summed = false, seen = 0;
            for (let i = 0; i < 14; i++) {
                await new Promise(s => setTimeout(s, 5000));
                const rr = await scanner.checkOrder({ subaddressIndex: IDX, amount: '0.11', minConfirmations: 0, sync: true });
                seen = rr.receivedXmr + rr.pendingXmr;
                process.stdout.write(`  seen so far: ${seen} XMR   \r`);
                if (seen >= 0.109999) { summed = true; break; }   // 0.1 faucet + 0.01 self-send
            }
            console.log('');
            check('scanner SUMS a second live on-chain payment (0.1 + 0.01 seen)', summed, `total seen ${seen} XMR`);
        } else {
            note('live second-payment skipped — merchant unlocked balance too low', `${Number(unlocked) / 1e12} XMR`);
        }
        await merchant.close(false);
    } catch (e) {
        note('live second-payment summing skipped', e.message);
    }

    await scanner.close(false);
    console.log(`\n${fail === 0 ? 'ALL GREEN' : 'FAILED'}  ${pass} passed, ${fail} failed, ${warn} warnings`);
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('live-scanner error:', e); process.exit(2); });
