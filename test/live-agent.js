// live end-to-end of the merchant PAYMENT AGENT against stagenet: boot the
// view-only scanner ONCE, wrap it in the agent, and drive orders against real
// chain data — a fresh order (pending), an order bound to the funded subaddress
// (the summed 0.1 + 0.01), and a small order that is already paid (fires onPaid).
//   NODE_PATH=~/Documents/goxmr-landing/server/node_modules node test/live-agent.js

const fs = require('fs');
const path = require('path');
const { createScanner } = require('../src/scanner');
const { createPaymentAgent } = require('../src/agent');

const POC = process.env.XMRPAY_POC || require('os').homedir() + '/Documents/goxmr-pay-poc';
const info = JSON.parse(fs.readFileSync(path.join(POC, 'stagenet/info.json'), 'utf8'));
const NODES = [info.node, 'http://node.monerodevs.org:38089', 'http://node2.monerodevs.org:38089', 'http://stagenet.xmr-tw.org:38081'];
const IDX = info.orderSubaddressIndex;

let pass = 0, fail = 0, warn = 0;
const check = (n, c, x = '') => { (c ? pass++ : fail++); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`); };
const note = (n, x = '') => { warn++; console.log(`WARN  ${n}${x ? '  — ' + x : ''}`); };

(async () => {
    process.stdout.write('booting agent scanner (one-time WASM cold start)… ');
    const scanner = await createScanner({
        primaryAddress: info.primaryAddress, privateViewKey: info.privateViewKey,
        networkType: 'stagenet', nodes: NODES, restoreHeight: info.restoreHeight,
        path: path.join(POC, 'stagenet/scanner'), password: 'poc-scanner',
    });
    await scanner.sync();
    console.log(`up · view-only=${scanner.viewOnly} · birthday ${scanner.birthdayHeight}`);
    check('agent scanner is view-only (non-custodial)', scanner.viewOnly === true);

    const paid = [];
    const agent = createPaymentAgent({ scanner, minConfirmations: 1, onPaid: (o) => paid.push(o.id) });

    // a FRESH order → its own subaddress, pending
    const fresh = await agent.createOrder({ id: 'agent_fresh', amount: '0.05' });
    check('createOrder mints a fresh subaddress', !!fresh.address && fresh.status === 'pending', `idx ${fresh.index}`);
    let r = await agent.check('agent_fresh');
    check('fresh order → pending (no payment yet)', r.status === 'pending' && !r.paid);

    // bind an order to the FUNDED subaddress — the confirmed on-chain total covers it.
    await agent.createOrder({ id: 'agent_funded', amount: '0.11', index: IDX });
    r = await agent.check('agent_funded');
    check('agent surfaces the SUMMED payments on the funded subaddress (owes 0)', r.shortfallXmr === '0' && (r.status === 'locked' || r.status === 'paid'), `status ${r.status}`);
    if (r.status === 'paid') {
        check('onPaid fired EXACTLY ONCE for the settled order', paid.filter(x => x === 'agent_funded').length === 1);
        // re-check is idempotent — no double settlement
        await agent.check('agent_funded');
        check('re-check does not re-fire onPaid', paid.filter(x => x === 'agent_funded').length === 1);
    } else {
        note('0.11 order still locked — the payment is maturing; onPaid fires once it unlocks (re-run later)');
    }

    // the agent REFUSES to bind a second order to a subaddress already in use — two
    // orders sharing a subaddress could both credit the same payment (a double-settle).
    let rejected = false;
    try { await agent.createOrder({ id: 'agent_dup', amount: '0.05', index: IDX }); }
    catch (e) { rejected = /already assigned/.test(String(e.message)); }
    check('a second order on the SAME subaddress is REJECTED (one address per order)', rejected);

    agent.stop();
    await scanner.close(false);
    console.log(`\n${fail === 0 ? 'ALL GREEN' : 'FAILED'}  ${pass} passed, ${fail} failed, ${warn} warnings`);
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('live-agent error:', e); process.exit(2); });
