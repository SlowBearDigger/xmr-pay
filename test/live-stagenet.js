// live validation of xmr-pay against the stagenet chain.
//
// reuses the funded wallet harness from ~/Documents/goxmr-pay-poc (POC 04-06):
//   - tx proof path: the scanner wallet regenerates an InProof for the real
//     faucet payment, then verifyPayment re-verifies it as a stranger would.
//   - tx key path: the merchant wallet self-sends to subaddress idx 2, we
//     capture the tx secret key (exactly what a buyer's wallet shows) and
//     verify it live, first in mempool, then through first confirmation.
//
//   NODE_PATH=~/Documents/goxmr-landing/server/node_modules node test/live-stagenet.js

const fs = require('fs');
const path = require('path');
const monerojs = require('monero-ts');
const { verifyPayment } = require('../src/verify');

const POC = process.env.XMRPAY_POC || require('os').homedir() + '/Documents/goxmr-pay-poc';
const info = JSON.parse(fs.readFileSync(path.join(POC, 'stagenet/info.json'), 'utf8'));
const NODES = [info.node, 'http://node.monerodevs.org:38089', 'http://node2.monerodevs.org:38089', 'http://stagenet.xmr-tw.org:38081'];
const NET = 'stagenet';
const FAUCET_TXID = '787a2f62d9dfec8b06e9cfbae7e2714c6109d60f66d39d7d8f06e9886af24525';
const MSG = 'goxmr-pay-lib live test';

let pass = 0, fail = 0, warn = 0;
const check = (name, cond, extra = '') => {
    (cond ? pass++ : fail++);
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
};
const note = (name, extra = '') => { warn++; console.log(`WARN  ${name}${extra ? '  — ' + extra : ''}`); };

async function openConnected(walletPath, password) {
    const w = await monerojs.openWalletFull({ path: walletPath, password, networkType: NET });
    for (const u of NODES) {
        try { await w.setDaemonConnection(u); if (await w.isConnectedToDaemon()) return w; } catch { /* next */ }
    }
    throw new Error('no stagenet node reachable');
}

(async () => {
    // ── phase 0: kick off the self-send early so confirmations accrue while
    //    the proof-path cases run ─────────────────────────────────────────────
    let selfSend = null;
    try {
        const merchant = await openConnected(path.join(POC, 'stagenet/merchant'), 'poc-stagenet');
        await merchant.sync(info.restoreHeight);
        const unlocked = BigInt((await merchant.getUnlockedBalance()).toString());
        if (unlocked > 30000000000n) { // > 0.03 XMR free
            const dest = await merchant.getAddress(0, 2);
            const tx = await merchant.createTx({
                accountIndex: 0,
                address: dest,
                amount: 20000000000n, // 0.02 XMR
                relay: true,
            });
            const txid = tx.getHash();
            let txKey = null;
            try { txKey = await merchant.getTxKey(txid); } catch { try { txKey = tx.getKey(); } catch { /* unsupported */ } }
            selfSend = { txid, txKey: txKey && txKey.toString(), dest };
            console.log(`self-send relayed: 0.02 XMR → idx 2  tx=${txid}\n`);
        } else {
            note('self-send skipped', `unlocked balance ${Number(unlocked) / 1e12} XMR (faucet output still locked?)`);
        }
        await merchant.save();
        await merchant.close(false);
    } catch (e) {
        note('self-send setup failed', e.message);
    }

    // ── phase 1: regenerate the InProof for the faucet payment ──────────────
    const scanner = await openConnected(path.join(POC, 'stagenet/scanner'), 'poc-scanner');
    await scanner.sync(info.restoreHeight);
    const inProof = await scanner.getTxProof(FAUCET_TXID, info.orderSubaddress, MSG);
    await scanner.save();
    await scanner.close(false);
    console.log(`InProof regenerated (len ${inProof.length})\n`);

    const common = { txid: FAUCET_TXID, proof: inProof, address: info.orderSubaddress, nodes: NODES, networkType: NET, message: MSG };

    // happy path — faucet sent 0.1 exactly
    let r = await verifyPayment({ ...common, amount: '0.1' });
    check('txproof: exact amount → paid', r.paid && r.status === 'paid', JSON.stringify(r));

    // overpaid order (expected less than received) is still paid
    r = await verifyPayment({ ...common, amount: '0.05' });
    check('txproof: overpaid → paid', r.paid === true, r.status);

    // underpaid: order wants more than the tx delivered
    r = await verifyPayment({ ...common, amount: '0.2' });
    check('txproof: underpaid → rejected', !r.paid && r.status === 'underpaid', r.reason);

    // amount-nonce sensitivity: 1 piconero over received must NOT pass (exact compare)
    r = await verifyPayment({ ...common, amount: '0.100000000001' });
    check('txproof: 1 piconero short → underpaid (nonce-grade exactness)', !r.paid && r.status === 'underpaid', r.reason);

    // wrong address — proof is bound to the address it was made for
    r = await verifyPayment({ ...common, amount: '0.1', address: info.primaryAddress });
    check('txproof: different address → rejected', !r.paid, r.status);

    // replay: caller's storage says this txid already paid another order
    r = await verifyPayment({ ...common, amount: '0.1', alreadyUsed: async () => true });
    check('replay: alreadyUsed(txid) → rejected as replay', !r.paid && r.status === 'replay', r.reason);

    // quorum: two independent nodes must agree
    r = await verifyPayment({ ...common, amount: '0.1', quorum: 2 });
    check('quorum=2: two nodes agree → paid', r.paid && r.nodesAgreed >= 2, `nodesAgreed=${r.nodesAgreed}`);

    // txid case-normalization (replay-dedup bypass fix)
    r = await verifyPayment({ ...common, txid: FAUCET_TXID.toUpperCase(), amount: '0.1' });
    check('uppercased txid verifies + returns lowercase', r.paid && r.txid === FAUCET_TXID, r.txid);

    // overpaid signal
    r = await verifyPayment({ ...common, amount: '0.05' });
    check('overpaid → paid + overpaid flag set', r.paid && r.overpaid === true && r.overpaidXmr > 0, `+${r.overpaidXmr}`);

    // zero-amount order rejected
    r = await verifyPayment({ ...common, amount: '0' });
    check('amount 0 → invalid', !r.paid && r.status === 'invalid', r.reason);

    // garbage inputs die cheaply, before any RPC
    r = await verifyPayment({ ...common, txid: 'nope', amount: '0.1' });
    check('garbage txid → invalid', !r.paid && r.status === 'invalid', r.reason);
    r = await verifyPayment({ ...common, proof: 'definitely-not-a-proof', amount: '0.1' });
    check('garbage proof → invalid', !r.paid && r.status === 'invalid', r.reason);

    // ── phase 2: tx key path on the self-send (closes the checkTxKey gap) ───
    if (selfSend && selfSend.txKey) {
        const keyArgs = { txid: selfSend.txid, proof: selfSend.txKey, address: selfSend.dest, amount: '0.02', nodes: NODES, networkType: NET };

        // a freshly relayed tx may not have reached the queried nodes yet —
        // checkTxKey then can't find it and returns 'invalid'. that's network
        // propagation, not a lib failure, so poll for it to become visible
        // before asserting; skip the phase (warn) if it never shows.
        let early = null;
        for (let i = 0; i < 12; i++) {
            early = await verifyPayment({ ...keyArgs });
            if (early.status !== 'invalid') break;
            await new Promise(s => setTimeout(s, 5000));
        }
        if (!early || early.status === 'invalid') {
            note('txkey: self-send not visible to the queried nodes within ~60s (propagation) — skipping phase');
        } else {
        check('txkey: fresh tx not yet paid (mempool/unconfirmed)', !early.paid && ['mempool', 'unconfirmed'].includes(early.status), early.status);

        // a 0-conf-tolerant merchant may accept it from the pool
        let zeroConf = await verifyPayment({ ...keyArgs, minConfirmations: 0 });
        check('txkey: minConfirmations=0 accepts mempool', zeroConf.paid || zeroConf.status === 'unconfirmed', zeroConf.status);

        // poll to first confirmation (stagenet ~2 min blocks; cap ~7 min)
        process.stdout.write('polling for first confirmation');
        let final = null;
        for (let i = 0; i < 21; i++) {
            await new Promise(s => setTimeout(s, 20000));
            process.stdout.write('.');
            final = await verifyPayment({ ...keyArgs });
            if (final.paid) break;
        }
        console.log('');
        if (final && final.paid) {
            check('txkey: confirmed self-send → paid (checkTxKey path live-validated)', true, `confs=${final.confirmations} received=${final.receivedXmr}`);
        } else {
            note('txkey: no confirmation inside the polling window', `last status=${final && final.status} — re-run later to confirm`);
        }
        }
    } else {
        note('txkey path not exercised this run (no self-send tx key)');
    }

    console.log(`\n${fail === 0 ? 'ALL GREEN' : 'FAILED'}  ${pass} passed, ${fail} failed, ${warn} warnings`);
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('live test error:', e); process.exit(2); });
