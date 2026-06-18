#!/usr/bin/env node
'use strict';
// xmr-pay — the one-command, non-custodial Monero payment agent.
//
//   npx xmr-pay           first run → setup wizard, then start
//   npx xmr-pay start     run with the saved config
//   npx xmr-pay init      (re)run the wizard only
//
// non-custodial: it holds ONLY your view key — it can SEE payments, never spend
// them. funds land straight in your wallet. your config + view key never leave
// this machine. it serves a tiny localhost API your store talks to.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const DATA_DIR = process.env.XMR_PAY_DIR || path.resolve(process.cwd(), 'xmr-pay-data');
const CONFIG = path.join(DATA_DIR, 'config.json');

const A = { rst: '\x1b[0m', o: '\x1b[38;5;208m', dim: '\x1b[2m', b: '\x1b[1m', g: '\x1b[32m', r: '\x1b[31m' };
const say = (s = '') => console.log(s);
const orange = s => A.o + s + A.rst;
const dim = s => A.dim + s + A.rst;
// trim trailing slashes without a regex (avoids the /\/+$/ polynomial-ReDoS pattern on node URLs)
const rtrimSlash = u => { u = String(u); let e = u.length; while (e > 0 && u.charCodeAt(e - 1) === 47) e--; return u.slice(0, e); };

// a line reader robust to BOTH an interactive TTY and piped/buffered stdin
// (rl.question loses lines that arrive before it is called; a queue does not).
function makeReader() {
    const rl = readline.createInterface({ input: process.stdin });
    const queue = [], waiters = [];
    let closed = false;
    rl.on('line', l => { const w = waiters.shift(); if (w) w(l); else queue.push(l); });
    rl.on('close', () => { closed = true; let w; while ((w = waiters.shift())) w(null); });
    return {
        next: () => new Promise(res => { if (queue.length) res(queue.shift()); else if (closed) res(null); else waiters.push(res); }),
        close: () => rl.close(),
    };
}

async function ask(rd, q, { def = '', validate, hint } = {}) {
    if (hint) say(dim('  ' + hint));
    for (; ;) {
        process.stdout.write(`  ${q}${def ? dim(' [' + def + ']') : ''}: `);
        const line = await rd.next();
        const ans = (line === null ? '' : String(line).trim()) || def;   // EOF → default
        if (validate) { const err = validate(ans); if (err) { say(A.r + '  ✗ ' + err + A.rst); continue; } }
        return ans;
    }
}

// loose Monero address sanity — the wallet does the real check on boot.
const addrCheck = a => /^[1-9A-HJ-NP-Za-km-z]{95,106}$/.test(a) ? null : 'that does not look like a Monero address';
const viewKeyCheck = k => /^[0-9a-fA-F]{64}$/.test(k) ? null : 'a private view key is exactly 64 hex characters';

async function nodeHeight(node) {
    try {
        const base = rtrimSlash(node);
        const res = await fetch(base + '/get_height', { signal: AbortSignal.timeout(6000) });
        const j = await res.json();
        return Number(j && j.height) || 0;
    } catch { return 0; }
}

async function wizard() {
    const rd = makeReader();
    say();
    say('  ' + orange('xmr-pay') + dim(' — non-custodial Monero payments'));
    say(dim('  Holds only your VIEW key: it can see payments, never spend them.'));
    say(dim('  Funds go straight to your wallet. Everything stays on this machine.'));
    say();

    const network = await ask(rd,'Network', { def: 'mainnet', validate: a => ['mainnet', 'stagenet', 'testnet'].includes(a) ? null : 'mainnet, stagenet, or testnet' });
    const defNode = network === 'stagenet' ? 'http://node.monerodevs.org:38089'
        : network === 'testnet' ? 'http://node.monerodevs.org:28089'
            : 'http://node.monerodevs.org:18089';
    const address = await ask(rd,'Your wallet primary address', { validate: addrCheck });
    const viewKey = await ask(rd,'Your private VIEW key', { hint: 'view key only — never your spend key or seed', validate: viewKeyCheck });
    const nodes = await ask(rd,'Monero node URL(s), comma-separated', { def: defNode });
    const merchantName = await ask(rd,'Store name (shown on receipts, optional)', { def: '' });
    const webhookUrl = await ask(rd,'Store webhook URL (blank to add later)', { def: '' });
    const port = await ask(rd,'Port', { def: '8788', validate: a => /^\d+$/.test(a) ? null : 'a port number' });
    const toleranceXmr = await ask(rd,'Underpayment tolerance in XMR', { def: '0', hint: 'accept if the buyer is short by up to this (dust/fee/rounding); 0 = exact', validate: a => /^\d+(\.\d{1,12})?$/.test(a) ? null : 'an XMR amount like 0 or 0.0001' });
    // settlement speed = how many confirmations before an order is "paid" (the
    // value-at-risk knob, like BTCPay's SpeedPolicy). instant accepts a mempool tx
    // (0-conf) — still gated by double_spend_seen + unlock_time, so it's safer than
    // a naive 0-conf, but a mempool tx can still be dropped; use it for small/digital.
    const speed = await ask(rd,'Settlement speed', { def: 'fast', hint: 'instant = 0-conf, accept on sight (~instant, small amounts) · fast = 1 block (~2 min) · secure = 10 blocks (fully unlocked)', validate: a => ['instant', 'fast', 'secure'].includes(a) ? null : 'instant, fast, or secure' });
    const minConfirmations = speed === 'instant' ? 0 : speed === 'secure' ? 10 : 1;
    rd.close();

    // restore height = the node's current tip, so it scans from NOW — instant, no
    // historical rescan. that "scan from genesis" wait is the #1 setup footgun.
    say();
    say(dim('  Checking the current block height…'));
    const tip = await nodeHeight(String(nodes).split(',')[0].trim());
    const restoreHeight = tip ? Math.max(0, tip - 10) : 0;
    say(tip ? dim(`  Scanning from block ${restoreHeight} (now) — new payments only.`)
        : dim('  Could not reach the node; will scan from genesis (slow). Edit restoreHeight in the config to fix.'));

    const cfg = {
        network, address, viewKey, nodes, restoreHeight,
        merchantName: merchantName || undefined,
        webhookUrl: webhookUrl || undefined,
        webhookSecret: webhookUrl ? 'whsec_' + crypto.randomBytes(16).toString('hex') : undefined,
        token: crypto.randomBytes(16).toString('hex'),
        port: Number(port), minConfirmations, pool: 8, toleranceXmr,
        expiryHours: 24,           // drop unpaid orders after a day (bounds work + memory; 0 = never)
        paidRetentionHours: 168,   // retire settled orders after a week (store stays bounded; 0 = keep)
    };
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    say();
    say('  ' + A.g + '✓' + A.rst + ' Saved ' + dim(CONFIG) + dim(' (holds your view key — mode 600, keep it private)'));
    printConnect(cfg);
    return cfg;
}

function printConnect(cfg) {
    say();
    say('  ' + A.b + 'Connect your store' + A.rst + dim('  (WooCommerce → Settings → Payments → Monero):'));
    say('    Agent URL       ' + orange(`http://127.0.0.1:${cfg.port}`));
    say('    Agent token     ' + orange(cfg.token));
    if (cfg.webhookSecret) say('    Webhook secret  ' + orange(cfg.webhookSecret));
    if (cfg.webhookSecret) say(dim('    (set the SAME webhook secret on the store)'));
    say();
}

// make sure the Monero engine (monero-ts, a large WASM peer dep) is available;
// install it once into the data dir if missing, so `npx xmr-pay` is truly one
// command. then make require('monero-ts') resolve from there.
function ensureMonero() {
    try { require.resolve('monero-ts'); return; } catch { /* not in the usual place */ }
    const localNM = path.join(DATA_DIR, 'node_modules');
    let present = false;
    try { require.resolve('monero-ts', { paths: [localNM] }); present = true; } catch { /* install below */ }
    if (!present) {
        say(orange('  Setting up the Monero engine (one-time download)…'));
        fs.mkdirSync(DATA_DIR, { recursive: true });
        // execFileSync (args array, no shell) so DATA_DIR can never be interpreted
        // by a shell — it's a path, not a command fragment.
        const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
        require('child_process').execFileSync(
            npm, ['install', 'monero-ts@^0.11', '--no-save', '--no-audit', '--no-fund', '--loglevel=error', '--prefix', DATA_DIR],
            { stdio: 'inherit' });
    }
    process.env.NODE_PATH = [localNM, process.env.NODE_PATH || ''].filter(Boolean).join(path.delimiter);
    require('module').Module._initPaths();
}

// map the saved config onto the env vars the agent reads (kept pure + exported
// so it can be unit-tested without booting the wallet).
function applyConfig(cfg, dataDir = DATA_DIR, e = process.env) {
    e.XMR_NETWORK = cfg.network;
    e.XMR_PRIMARY_ADDRESS = cfg.address;
    e.XMR_VIEW_KEY = cfg.viewKey;
    e.XMR_NODES = cfg.nodes;
    if (cfg.restoreHeight != null) e.XMR_RESTORE_HEIGHT = String(cfg.restoreHeight);
    e.XMR_WALLET_PATH = e.XMR_WALLET_PATH || path.join(dataDir, 'wallet');
    e.XMR_ORDERS_FILE = e.XMR_ORDERS_FILE || path.join(dataDir, 'orders.json');
    e.XMR_RECEIPT_KEY = e.XMR_RECEIPT_KEY || path.join(dataDir, 'receipt-key.pem');
    if (cfg.merchantName) e.XMR_MERCHANT_NAME = cfg.merchantName;
    if (cfg.webhookUrl) e.FULFILL_WEBHOOK_URL = cfg.webhookUrl;
    if (cfg.webhookSecret) e.FULFILL_WEBHOOK_SECRET = cfg.webhookSecret;
    e.AGENT_TOKEN = cfg.token || '';
    e.PORT = String(cfg.port || 8788);
    e.XMR_MIN_CONFIRMATIONS = String(cfg.minConfirmations || 1);
    if (cfg.toleranceXmr != null && cfg.toleranceXmr !== '') e.XMR_TOLERANCE_XMR = String(cfg.toleranceXmr);
    e.XMR_SUBADDRESS_POOL = String(cfg.pool || 8);
    if (cfg.expiryHours != null) e.XMR_EXPIRY_HOURS = String(cfg.expiryHours);
    if (cfg.paidRetentionHours != null) e.XMR_PAID_RETENTION_HOURS = String(cfg.paidRetentionHours);
    return e;
}

function start() {
    if (!fs.existsSync(CONFIG)) { say(A.r + '  No config yet — run: ' + A.rst + orange('npx xmr-pay')); process.exit(1); }
    const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    applyConfig(cfg);
    ensureMonero();
    require('../examples/scanner-agent.js'); // reads process.env at load
}

async function main() {
    const cmd = process.argv[2];
    if (cmd === '--help' || cmd === '-h') {
        say('xmr-pay — one-command non-custodial Monero payment agent');
        say('  npx xmr-pay          setup wizard (first run), then start');
        say('  npx xmr-pay start    run with the saved config');
        say('  npx xmr-pay init     re-run the wizard');
        say('  data + view key live in ./xmr-pay-data  (override: XMR_PAY_DIR=/path)');
        return;
    }
    if (cmd === 'init') { await wizard(); say(dim('  Then run: ') + orange('npx xmr-pay start')); return; }
    if (cmd === 'start') { start(); return; }
    if (!fs.existsSync(CONFIG)) { await wizard(); say('  ' + orange('Starting…')); }
    start();
}

module.exports = { applyConfig, makeReader };  // for tests; CLI only runs when invoked directly

if (require.main === module) {
    main().catch(e => { console.error(e); process.exit(1); });
}
