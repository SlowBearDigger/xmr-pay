'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createScanner } = require('../src/scanner');
const { createPaymentAgent } = require('../src/agent');

const configPath = process.env.XMRPAY_STAGENET_CONFIG;
const moneroPath = process.env.XMRPAY_MONERO_TS;
if (!configPath || !fs.existsSync(configPath) || !moneroPath) {
    console.log('SKIP  live-authenticated-agent: external config or monero-ts path unavailable');
    process.exit(0);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
if (!config.expectedTxid) {
    console.log('SKIP  live-authenticated-agent: payment has not been sent');
    process.exit(0);
}
const monero = require(moneroPath);

let pass = 0, fail = 0;
function ok(name, condition, extra = '') {
    if (condition) { pass++; console.log(`PASS  ${name}`); return; }
    fail++;
    console.log(`FAIL  ${name}${extra ? `  ${extra}` : ''}`);
}
function lineCounts(dir) {
    const out = {};
    for (const name of ['open', 'basic-a', 'basic-b', 'digest-a', 'digest-b', 'redirect', 'collector']) {
        const file = path.join(dir, name + '.log');
        out[name] = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0;
    }
    return out;
}
function scannerOptions() {
    return {
        primaryAddress: config.primaryAddress,
        privateViewKey: config.privateViewKey,
        networkType: config.networkType,
        nodes: config.nodes,
        path: config.walletPath,
        password: '',
        syncTimeoutMs: Number(config.syncTimeoutMs || 120000),
        monero,
    };
}

async function main() {
    ok('configuration contains only one Basic node', config.nodes.length === 1 && config.nodes[0].auth === 'basic');
    ok('order was recorded pending before payment', config.job.order.status === 'pending' && config.job.order.paid === false);
    const baseline = lineCounts(config.gatewayLogDir);

    let scanner = await createScanner(scannerOptions());
    let settled;
    const store = new Map([[config.job.order.id, { ...config.job.order }]]);
    try {
        const agent = createPaymentAgent({ scanner, store, minConfirmations: 1 });
        settled = await agent.check(config.job.order.id);
        ok('agent finds the independent transaction', settled.txids.includes(config.expectedTxid), `confirmations=${settled.confirmations || 0}`);
        ok('agent settles after at least one confirmation', settled.paid && settled.confirmations >= 1, `confirmations=${settled.confirmations || 0}`);
        fs.writeFileSync(config.ordersPath, JSON.stringify([...store.values()], null, 2) + '\n', { mode: 0o600 });
    } finally {
        await scanner.close(true);
    }

    const persisted = JSON.parse(fs.readFileSync(config.ordersPath, 'utf8'));
    ok('paid state persists across restart', persisted.length === 1 && persisted[0].paid === true && persisted[0].txids.includes(config.expectedTxid));

    scanner = await createScanner(scannerOptions());
    let first, second, rechecked;
    try {
        first = await scanner.checkOrder({
            subaddressIndex: config.job.order.index,
            amount: config.job.order.amount,
            minConfirmations: 1,
            minHeight: config.job.order.birthdayHeight,
        });
        second = await scanner.checkOrder({
            subaddressIndex: config.job.order.index,
            amount: config.job.order.amount,
            minConfirmations: 1,
            minHeight: config.job.order.birthdayHeight,
        });
        ok('restarted scanner independently verifies paid state', first.paid && first.txids.includes(config.expectedTxid));
        ok('repeated scanner check is idempotent', second.paid && JSON.stringify(second.txids) === JSON.stringify(first.txids));

        const restartedStore = new Map(persisted.map(order => [order.id, order]));
        const restartedAgent = createPaymentAgent({ scanner, store: restartedStore, minConfirmations: 1 });
        rechecked = await restartedAgent.check(config.job.order.id, { sync: false });
        ok('restarted agent preserves one settled order', rechecked.paid && restartedAgent.list().length === 1 && rechecked.txids.includes(config.expectedTxid));
    } finally {
        await scanner.close(true);
    }

    const after = lineCounts(config.gatewayLogDir);
    const deltas = {};
    for (const [name, count] of Object.entries(after)) deltas[name] = count - baseline[name];
    let onlyBasicA = deltas['basic-a'] > 0;
    for (const [name, delta] of Object.entries(deltas)) if (name !== 'basic-a' && delta !== 0) onlyBasicA = false;
    ok('proxy audit records only basic-a requests', onlyBasicA, JSON.stringify(deltas));

    if (fail === 0) {
        const artifact = {
            platform: 'xmr-pay-js-agent',
            auth_scheme: 'basic',
            txid: config.expectedTxid,
            address: config.job.order.address,
            amount_atomic: config.job.destinations[0].amount_atomic,
            confirmations: Number(first.confirmations || settled.confirmations || 0),
            settlement_state: 'paid',
            restart_persistence: true,
            idempotent_recheck: JSON.stringify(second.txids) === JSON.stringify(first.txids),
            proxy_log_deltas: deltas,
        };
        fs.writeFileSync(config.artifactPath, JSON.stringify(artifact, null, 2) + '\n');
    }

    console.log(`\n${fail ? `FAILED (${fail})` : 'ALL GREEN'}  ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
}

main().catch(error => {
    console.error(`LIVE_AUTH_AGENT_ERROR ${error && error.code ? error.code : error && error.name ? error.name : 'Error'}`);
    process.exit(1);
});
