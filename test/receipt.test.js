// signed payment receipt — offline, deterministic.
//   node test/receipt.test.js

const { receiptFromOrder, signReceipt, verifyReceipt, verifyReceiptOnChain, RECEIPT_TYP } = require('../src/receipt');
const { signConfig, generateSigningKey } = require('../src/config');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };

const merchant = generateSigningKey();
const attacker = generateSigningKey();
const txid = 'a'.repeat(64);

const order = {
    id: 'ord_42',
    amount: '0.05',
    address: '8' + 'A'.repeat(94),
    receivedXmr: 0.05,
    confirmations: 12,
    birthdayHeight: 3000000,
    txids: [txid],
};

const body = receiptFromOrder(order, { merchant: { name: 'Sat Shop' }, network: 'mainnet', paidAt: 1700000000000 });
const env = signReceipt(body, merchant.privateKey);

ok('signs and round-trips', verifyReceipt(env).valid);
ok('body is domain-tagged', body.typ === RECEIPT_TYP);
ok('amount pinned in exact pico (no float)', body.amountPico === '50000000000', body.amountPico);
ok('received pinned in exact pico', body.receivedPico === '50000000000', body.receivedPico);
ok('keeps the on-chain txids', JSON.stringify(body.txids) === JSON.stringify([txid]));
ok('fingerprint is stable + readable', /^[0-9a-f]{4}(-[0-9a-f]{4}){5}$/.test(env.fingerprint), env.fingerprint);

// tamper the amount after signing
const tampered = JSON.parse(JSON.stringify(env));
tampered.receipt.amountPico = '1';
ok('tampered amount fails', !verifyReceipt(tampered).valid, verifyReceipt(tampered).reason);

// attacker re-signs a doctored receipt with their own key
const forged = signReceipt(receiptFromOrder({ ...order, amount: '5.0' }, { network: 'mainnet', paidAt: 1700000000000 }), attacker.privateKey);
ok('forged-but-valid passes WITHOUT a pin (tamper-evidence only)', verifyReceipt(forged).valid);
ok('forged rejected WHEN pinned to merchant fingerprint',
    !verifyReceipt(forged, { expectedFingerprint: env.fingerprint }).valid,
    verifyReceipt(forged, { expectedFingerprint: env.fingerprint }).reason);
ok('genuine receipt passes the merchant pin', verifyReceipt(env, { expectedFingerprint: env.fingerprint }).valid);

// canonical: field order does not change the signature bytes
const reordered = signReceipt({ merchant: { name: 'Sat Shop' }, paidAt: 1700000000000, address: body.address, receivedPico: body.receivedPico, amountPico: body.amountPico, confirmations: 12, birthdayHeight: 3000000, network: 'mainnet', orderId: 'ord_42', txids: [txid], typ: RECEIPT_TYP }, merchant.privateKey);
ok('canonical: field order does not change the signature bytes', reordered.sig === env.sig);

// domain separation: a signed CONFIG must not pass as a receipt, and vice versa
const cfgEnv = signConfig({ address: body.address, amount: '0.05' }, merchant.privateKey);
ok('a signed config is rejected as a receipt', !verifyReceipt(cfgEnv).valid, verifyReceipt(cfgEnv).reason);
const asConfigShaped = JSON.parse(JSON.stringify(env)); // receipt envelope is not a config envelope either
ok('a receipt envelope has no config field', asConfigShaped.config === undefined);

// junk
ok('non-envelope rejected', !verifyReceipt({ nope: 1 }).valid);
ok('signReceipt refuses a non-receipt body', (() => { try { signReceipt({ foo: 1 }, merchant.privateKey); return false; } catch { return true; } })());

async function contributionPolicyTests() {
    // Exercise the real receipt and verification policies; only native RPC answers are simulated.
    const Module = require('node:module');
    const originalLoad = Module._load;
    const originalFetch = global.fetch;
    const otherTxid = 'b'.repeat(64);
    let amounts = { [txid]: 20000000n, [otherTxid]: 30000000n };
    let confirmations = { [txid]: 25, [otherTxid]: 5 };
    let unlock = {}, inPool = false, missingUnlock = false;
    const native = {
        async createWalletFull() {
            return {
                async setDaemonConnection() {}, async isConnectedToDaemon() { return true; },
                async checkTxProof(id) { return { isGood: true, receivedAmount: amounts[id].toString(), numConfirmations: confirmations[id], inTxPool: inPool }; },
            };
        },
    };
    Module._load = function (name) { return name === 'monero-ts' ? native : originalLoad.apply(this, arguments); };
    global.fetch = async (url, options) => {
        if (String(url).endsWith('/get_height')) return { ok: true, json: async () => ({ height: 5000 }) };
        const id = JSON.parse(options.body).txs_hashes[0];
        return { ok: !missingUnlock, json: async () => ({ txs: [{ tx_hash: id, as_json: JSON.stringify({ unlock_time: unlock[id] || 0 }) }] }) };
    };
    const splitReceipt = amount => signReceipt(receiptFromOrder({ ...order, amount, receivedPico: (amounts[txid] + amounts[otherTxid]).toString(), txids: [txid, otherTxid] }, {
        network: 'mainnet', txProofs: [txid, otherTxid].map(id => ({ txid: id, signature: 'InProofV2abc', message: '' })),
    }), merchant.privateKey);
    const check = (receipt, depth) => verifyReceiptOnChain(receipt, { nodes: ['http://receipt-policy-node'], minConfirmations: depth });
    try {
        const split = splitReceipt('0.00005');
        let result = await check(split, 1);
        ok('split receipt sums exact confirmed contributions', result.valid && result.confirmedPico === '50000000');
        ok('split receipt preserves per-transaction underpaid status', result.perTx.every(tx => tx.status === 'underpaid' && tx.ok));
        for (const amountPico of ['0', '-1']) {
            const invalidAmount = signReceipt({ ...split.receipt, amountPico }, merchant.privateKey);
            ok('nonpositive receipt amount remains rejected: ' + amountPico, !(await check(invalidAmount, 1)).valid);
        }
        result = await check(split, 100);
        ok('split receipt rejects a depth above every contribution', !result.valid && result.confirmedPico === '0');
        result = await check(split, 10);
        ok('split receipt counts only contributions meeting the requested depth', !result.valid && result.confirmedPico === '20000000');

        confirmations = { [txid]: 0, [otherTxid]: 0 }; inPool = true;
        result = await check(split, 1);
        ok('unconfirmed partial contributions cannot satisfy a confirmed receipt', !result.valid && result.confirmedPico === '0');
        result = await check(split, 0);
        ok('explicit zero-confirmation policy remains supported', result.valid && result.confirmedPico === '50000000');
        confirmations = { [txid]: 25, [otherTxid]: 5 }; inPool = false;

        unlock = { [txid]: 6000 };
        result = await check(split, 1);
        ok('future height lock excludes a partial contribution', !result.valid && result.confirmedPico === '30000000');
        unlock = { [txid]: 4000 };
        ok('elapsed height lock remains acceptable', (await check(split, 1)).valid);
        unlock = { [txid]: Math.floor(Date.now() / 1000) + 3600 };
        result = await check(split, 1);
        ok('future timestamp lock excludes a partial contribution', !result.valid && result.confirmedPico === '30000000');
        unlock = { [txid]: 1000000000 };
        ok('elapsed timestamp lock remains acceptable', (await check(split, 1)).valid);
        missingUnlock = true;
        result = await check(split, 1);
        ok('unavailable unlock policy fails closed for partial contributions', !result.valid && result.confirmedPico === '0');
        missingUnlock = false; unlock = {};

        amounts = { [txid]: 1n, [otherTxid]: 9007199254740992n };
        result = await check(splitReceipt('9007.199254740993'), 1);
        ok('one-pico and above-safe-integer contributions retain exact sums', result.valid && result.confirmedPico === '9007199254740993');
    } finally {
        Module._load = originalLoad;
        global.fetch = originalFetch;
    }
}

// on-chain leg: structural guards without a live node
(async () => {
    const noProofs = await verifyReceiptOnChain(env, { nodes: ['http://x'] });
    ok('on-chain: no tx_proofs → cannot verify on-chain', !noProofs.valid && /no tx_proofs/.test(noProofs.reason));

    const withProof = signReceipt(receiptFromOrder(order, { network: 'mainnet', paidAt: 1700000000000, txProofs: [{ txid, signature: 'InProofV2abc', message: '' }] }), merchant.privateKey);
    ok('receipt carries the buyer tx_proof', Array.isArray(withProof.receipt.txProofs) && withProof.receipt.txProofs.length === 1);
    const noNodes = await verifyReceiptOnChain(withProof, { nodes: [] });
    ok('on-chain: no nodes → reason given', !noNodes.valid && /node/.test(noNodes.reason));

    // tamper detection still applies on the on-chain path (sig checked first)
    const t2 = JSON.parse(JSON.stringify(withProof));
    t2.receipt.amountPico = '1';
    const bad = await verifyReceiptOnChain(t2, { nodes: ['http://x'] });
    ok('on-chain: tampered receipt fails on the signature first', !bad.valid && /signature/.test(bad.reason));
    await contributionPolicyTests();

    console.log(`\n${fail === 0 ? 'ALL GREEN' : 'FAILED'}  ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
})();
