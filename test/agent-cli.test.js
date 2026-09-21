// the npx wizard CLI — config→env mapping + the line reader.
//   node test/agent-cli.test.js

const { applyConfig, hiddenAnswer, npmInstallEnv } = require('../bin/agent.js');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };

const cfg = {
    network: 'stagenet', address: '5addr', viewKey: 'a'.repeat(64), nodes: 'http://n1,http://n2',
    restoreHeight: 2141750, merchantName: 'Sat Coffee', webhookUrl: 'https://shop/wh',
    webhookSecret: 'whsec_x', token: 'deadbeef', port: 8790, minConfirmations: 1, pool: 8, expiryHours: 24, paidRetentionHours: 168,
};
const e = {};
applyConfig(cfg, '/data/xmr', e);

ok('network mapped', e.XMR_NETWORK === 'stagenet');
ok('address + view key mapped', e.XMR_PRIMARY_ADDRESS === '5addr' && e.XMR_VIEW_KEY === 'a'.repeat(64));
ok('nodes mapped verbatim (comma list)', e.XMR_NODES === 'http://n1,http://n2');
ok('restoreHeight stringified', e.XMR_RESTORE_HEIGHT === '2141750');
ok('wallet/orders/receipt paths under the data dir', e.XMR_WALLET_PATH === '/data/xmr/wallet' && e.XMR_ORDERS_FILE === '/data/xmr/orders.json' && e.XMR_RECEIPT_KEY === '/data/xmr/receipt-key.pem');
ok('merchant + webhook + token mapped', e.XMR_MERCHANT_NAME === 'Sat Coffee' && e.FULFILL_WEBHOOK_URL === 'https://shop/wh' && e.FULFILL_WEBHOOK_SECRET === 'whsec_x' && e.AGENT_TOKEN === 'deadbeef');
ok('port + conf + pool stringified', e.PORT === '8790' && e.XMR_MIN_CONFIRMATIONS === '1' && e.XMR_SUBADDRESS_POOL === '8');
ok('expiryHours mapped to XMR_EXPIRY_HOURS', e.XMR_EXPIRY_HOURS === '24');
ok('paidRetentionHours mapped to XMR_PAID_RETENTION_HOURS', e.XMR_PAID_RETENTION_HOURS === '168');

// no webhook → no webhook env vars (don't leak empty values)
const e2 = {};
applyConfig({ network: 'mainnet', address: '4a', viewKey: 'b'.repeat(64), nodes: 'http://n', token: 't', port: 8788 }, '/d', e2);
ok('no webhook → FULFILL_WEBHOOK_URL unset', e2.FULFILL_WEBHOOK_URL === undefined);
ok('defaults: minConf 1, pool 8 when absent', e2.XMR_MIN_CONFIRMATIONS === '1' && e2.XMR_SUBADDRESS_POOL === '8');

// existing env wallet path is respected (operator override wins)
const e3 = { XMR_WALLET_PATH: '/custom/w' };
applyConfig(cfg, '/data/xmr', e3);
ok('operator XMR_WALLET_PATH override respected', e3.XMR_WALLET_PATH === '/custom/w');

const protectedNodes = [{
    url: 'http://127.0.0.1:38091',
    auth: 'basic',
    username: 'merchant',
    password: 'node-password',
    allow_insecure_http: true,
}];
const e4 = { XMR_NODES: 'http://stale-node' };
applyConfig({ ...cfg, nodes: protectedNodes }, '/data/xmr', e4);
ok('structured nodes mapped to XMR_NODES_JSON', JSON.parse(e4.XMR_NODES_JSON)[0].auth === 'basic');
ok('structured config clears stale XMR_NODES', e4.XMR_NODES === undefined);

const e5 = { XMR_NODES_JSON: '[{"url":"http://stale"}]' };
applyConfig(cfg, '/data/xmr', e5);
ok('legacy config clears stale XMR_NODES_JSON', e5.XMR_NODES_JSON === undefined && e5.XMR_NODES === cfg.nodes);

ok('hidden password preserves leading and trailing spaces',
    typeof hiddenAnswer === 'function' && hiddenAnswer('  valid password  ') === '  valid password  ');

const installSource = {
    PATH: '/usr/bin', HOME: '/tmp/home', npm_config_cache: '/tmp/cache',
    XMR_VIEW_KEY: 'view-secret', XMR_NODES_JSON: '[{"password":"node-secret"}]',
    XMR_NODES: 'http://user:legacy-secret@node', XMR_WALLET_PASSWORD: 'wallet-secret',
    FULFILL_WEBHOOK_SECRET: 'webhook-secret', AGENT_TOKEN: 'agent-secret',
};
const installChild = typeof npmInstallEnv === 'function' ? npmInstallEnv(installSource) : {};
ok('npm install child keeps ordinary process settings', installChild.PATH === '/usr/bin' && installChild.npm_config_cache === '/tmp/cache');
ok('npm install child receives no payment or node secrets',
    !Object.keys(installChild).some(key => ['XMR_VIEW_KEY', 'XMR_NODES_JSON', 'XMR_NODES', 'XMR_WALLET_PASSWORD', 'FULFILL_WEBHOOK_SECRET', 'AGENT_TOKEN'].includes(key)));

const exposed = spawnSync(process.execPath, [path.join(__dirname, '../examples/scanner-agent.js')], {
    env: { XMR_NODES: 'http://127.0.0.1:18081', BIND: '0.0.0.0' }, encoding: 'utf8',
});
ok('agent rejects public bind without a token', exposed.status === 1 && exposed.stderr.includes('AGENT_TOKEN is required'));

const local = spawnSync(process.execPath, [path.join(__dirname, '../examples/scanner-agent.js')], {
    env: { XMR_NODES: 'http://127.0.0.1:18081' }, encoding: 'utf8',
});
ok('agent rejects loopback without a token', local.status === 1 && local.stderr.includes('AGENT_TOKEN is required'));

if (process.platform !== 'win32') {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xmr-agent-perms-'));
    try {
        const fresh = path.join(root, 'fresh');
        spawnSync(process.execPath, [path.join(__dirname, '../bin/agent.js'), 'start'], {
            env: { PATH: process.env.PATH || '', XMR_PAY_DIR: fresh }, encoding: 'utf8',
        });
        ok('agent creates a private data directory', (fs.statSync(fresh).mode & 0o777) === 0o700);
        const data = path.join(root, 'data');
        fs.mkdirSync(data, { mode: 0o755 });
        fs.writeFileSync(path.join(data, 'config.json'), '{', { mode: 0o644 });
        const started = spawnSync(process.execPath, [path.join(__dirname, '../bin/agent.js'), 'start'], {
            env: { PATH: process.env.PATH || '', XMR_PAY_DIR: data }, encoding: 'utf8',
        });
        ok('agent tightens an existing data directory and config before startup',
            (fs.statSync(data).mode & 0o777) === 0o700
            && (fs.statSync(path.join(data, 'config.json')).mode & 0o777) === 0o600
            && started.status !== 0);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

if (process.platform !== 'win32') {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xmr-engine-deps-'));
    try {
        const data = path.join(root, 'data'), bin = path.join(root, 'bin');
        fs.mkdirSync(data); fs.mkdirSync(bin);
        fs.writeFileSync(path.join(data, 'config.json'), '{}');
        fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
        spawnSync(process.execPath, [path.join(__dirname, '../bin/agent.js'), 'start'], {
            env: { PATH: bin + path.delimiter + (process.env.PATH || ''), XMR_PAY_DIR: data }, encoding: 'utf8',
        });
        const pkg = JSON.parse(fs.readFileSync(path.join(data, 'package.json'), 'utf8'));
        ok('automatic engine installation constrains vulnerable transitive dependencies',
            pkg.private === true && pkg.overrides['serialize-javascript'] === '^7.0.5' && pkg.overrides.uuid === '^11.1.1');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

console.log(`\n${fail === 0 ? 'ALL GREEN' : 'FAILED'}  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
