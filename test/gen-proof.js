// regenerate the InProof for the stagenet faucet payment and save it for the
// demo (examples/demo-proof.txt). message '' to match the verify endpoint's
// default. demo-only convenience — in production the BUYER brings the proof.
//
//   NODE_PATH=~/Documents/goxmr-landing/server/node_modules node test/gen-proof.js

const fs = require('fs');
const path = require('path');
const monerojs = require('monero-ts');

const POC = process.env.XMRPAY_POC || require('os').homedir() + '/Documents/goxmr-pay-poc';
const info = JSON.parse(fs.readFileSync(path.join(POC, 'stagenet/info.json'), 'utf8'));
const NODES = [info.node, 'http://node.monerodevs.org:38089', 'http://node2.monerodevs.org:38089'];
const FAUCET_TXID = '787a2f62d9dfec8b06e9cfbae7e2714c6109d60f66d39d7d8f06e9886af24525';

(async () => {
    const w = await monerojs.openWalletFull({ path: path.join(POC, 'stagenet/scanner'), password: 'poc-scanner', networkType: 'stagenet' });
    let ok = false;
    for (const u of NODES) {
        try { await w.setDaemonConnection(u); if (await w.isConnectedToDaemon()) { ok = true; break; } } catch { /* next */ }
    }
    if (!ok) throw new Error('no stagenet node reachable');
    await w.sync(info.restoreHeight);
    const proof = await w.getTxProof(FAUCET_TXID, info.orderSubaddress, '');
    await w.save();
    await w.close(false);
    const out = path.join(__dirname, '../examples/demo-proof.txt');
    fs.writeFileSync(out, proof.trim() + '\n');
    console.log(`proof (len ${proof.length}) → ${out}`);
    console.log(`txid: ${FAUCET_TXID}`);
    process.exit(0);
})().catch(e => { console.error('gen-proof error:', e); process.exit(1); });
