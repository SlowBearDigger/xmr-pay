// uri compatibility: our dependency-light makePaymentURI must parse cleanly in
// the official wallet code (monero-ts wraps wallet2's parse_uri). if wallet2
// reads our uris, every wallet built on it reads them too.
//   NODE_PATH=~/Documents/goxmr-landing/server/node_modules node test/uri-compat.test.js

const fs = require('fs');
const monerojs = require('monero-ts');
const core = require('../src/core');

const info = JSON.parse(fs.readFileSync((process.env.XMRPAY_POC || require('os').homedir() + '/Documents/goxmr-pay-poc') + '/stagenet/info.json', 'utf8'));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };

(async () => {
    const w = await monerojs.createWalletFull({ networkType: 'stagenet', password: '' });

    const uri = core.makePaymentURI({
        address: info.orderSubaddress,
        amount: '0.050000004821',          // nonce-grade decimals must survive
        recipientName: 'GoXMR Demo',
        description: 'Order #42 — café',   // unicode + uri-encoding
        networkType: 'stagenet',
    });
    console.log('uri:', uri.slice(0, 72) + '…\n');

    let cfg;
    try { cfg = await w.parsePaymentUri(uri); } catch (e) { cfg = null; console.log('parse error:', e.message); }
    ok('official wallet2 parses our uri', !!cfg);

    if (cfg) {
        const dest = cfg.getDestinations()[0];
        ok('address survives', dest.getAddress() === info.orderSubaddress);
        ok('amount survives to the piconero', dest.getAmount().toString() === '50000004821');
        ok('description survives (unicode + encoding)', cfg.getNote() === 'Order #42 — café', JSON.stringify(cfg.getNote()));
        ok('recipient name survives', cfg.getRecipientName() === 'GoXMR Demo', JSON.stringify(cfg.getRecipientName()));

        // round-trip: wallet2's own generator from the parsed config
        try {
            const theirs = await w.getPaymentUri(cfg);
            ok('wallet2 can regenerate a uri from the parsed config', typeof theirs === 'string' && theirs.startsWith('monero:') && theirs.includes(info.orderSubaddress));
        } catch (e) { ok('wallet2 can regenerate a uri from the parsed config', false, e.message); }
    }

    // amount-less uri (tips) must parse too
    let tipCfg = null;
    try { tipCfg = await w.parsePaymentUri(core.makePaymentURI({ address: info.primaryAddress })); } catch { /* fail below */ }
    ok('amount-less (tips) uri parses', !!tipCfg);

    await w.close();
    console.log(`\n${fail === 0 ? 'ALL GREEN' : 'FAILED'}  ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('uri compat error:', e); process.exit(2); });
