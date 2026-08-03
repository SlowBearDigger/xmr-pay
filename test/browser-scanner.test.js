'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
    createBrowserScanner,
    inferNetworkType,
    normalizeBrowserNode,
} = require('../src/browser-scanner');

const VIEW_KEY = 'a'.repeat(64);
const ADDRESSES = {
    mainnet: '4' + '1'.repeat(94),
    stagenet: '5' + '1'.repeat(94),
    testnet: '9' + '1'.repeat(94),
};

function transfer({ amount, index, height = 1200, confirmations = 4, pool = false, lockedUntil = 0, txid = 'a'.repeat(64) }) {
    return {
        getAmount: () => BigInt(amount),
        getSubaddressIndex: () => index,
        getTx: () => ({
            getNumConfirmations: () => confirmations,
            getIsConfirmed: () => !pool,
            getInTxPool: () => pool,
            getUnlockTime: () => lockedUntil,
            getHash: () => txid,
            getHeight: () => height,
            getIsDoubleSpendSeen: () => false,
        }),
    };
}

function fixture({ spendKey = '0'.repeat(64), transfers = [], connected = true, syncError = null } = {}) {
    const calls = { created: [], connections: [], fetches: [], syncs: [], transferQueries: [], closes: 0 };
    const wallet = {
        async setDaemonConnection(value) { calls.connections.push(value); },
        async isConnectedToDaemon() { return connected; },
        async getPrivateSpendKey() { return spendKey; },
        async getDaemonHeight() { return 1300; },
        async getHeight() { return 1295; },
        async sync(startHeight) { calls.syncs.push(startHeight); if (syncError) throw syncError; },
        async getAddress(accountIndex, subaddressIndex) { return `address-${accountIndex}-${subaddressIndex}`; },
        async createSubaddress(accountIndex, label) {
            return { getAddress: () => `fresh-${accountIndex}`, getIndex: () => 7, label };
        },
        async getTransfers(query) { calls.transferQueries.push(query); return transfers; },
        async close(save) { calls.closes++; calls.closeSave = save; },
    };
    const monero = {
        async createWalletFull(options) { calls.created.push(options); return wallet; },
    };
    const fetchImpl = async (url, options) => {
        calls.fetches.push({ url, options });
        return { ok: true, status: 200, redirected: false, json: async () => ({ height: 1234 }) };
    };
    return { calls, wallet, monero, fetchImpl };
}

test('infers Monero network from standard primary addresses', () => {
    assert.equal(inferNetworkType(ADDRESSES.mainnet), 'mainnet');
    assert.equal(inferNetworkType(ADDRESSES.stagenet), 'stagenet');
    assert.equal(inferNetworkType(ADDRESSES.testnet), 'testnet');
    assert.throws(() => inferNetworkType('6' + '1'.repeat(94)), /cannot infer network/i);
    assert.throws(() => inferNetworkType('8' + '1'.repeat(94)), /primary standard address/i);
    assert.throws(() => inferNetworkType('7' + '1'.repeat(94)), /primary standard address/i);
    assert.throws(() => inferNetworkType('B' + '1'.repeat(94)), /primary standard address/i);
});

test('normalizes only credential-free HTTP and HTTPS node URLs', () => {
    assert.equal(normalizeBrowserNode('https://node.example/rpc/').url, 'https://node.example/rpc');
    assert.equal(normalizeBrowserNode({ url: 'http://192.168.1.10:18081', auth: 'none' }).url, 'http://192.168.1.10:18081');
    assert.throws(() => normalizeBrowserNode({ url: 'https://node.example', auth: 'basic', username: 'u', password: 'p' }), /authentication is not supported/i);
    assert.throws(() => normalizeBrowserNode('https://user:pass@node.example'), /credentials/i);
    assert.throws(() => normalizeBrowserNode('ws://node.example'), /http or https/i);
    assert.throws(() => normalizeBrowserNode('https:/node.example'), /invalid node URL/i);
    assert.throws(() => normalizeBrowserNode('https://node.example?token=secret'), /query or fragment/i);
});

test('creates an in-memory view-only scanner at the browser-fetched tip', async () => {
    const f = fixture();
    const scanner = await createBrowserScanner({
        primaryAddress: ADDRESSES.stagenet,
        privateViewKey: VIEW_KEY,
        node: 'https://node.example/',
        monero: f.monero,
        fetchImpl: f.fetchImpl,
    });

    assert.deepEqual(f.calls.created, [{
        networkType: 'stagenet',
        primaryAddress: ADDRESSES.stagenet,
        privateViewKey: VIEW_KEY,
        restoreHeight: 1234,
    }]);
    assert.deepEqual(f.calls.connections, ['https://node.example']);
    assert.equal(f.calls.fetches[0].url, 'https://node.example/get_height');
    assert.equal(f.calls.fetches[0].options.credentials, 'omit');
    assert.equal(f.calls.fetches[0].options.redirect, 'error');
    assert.equal(scanner.networkType, 'stagenet');
    assert.equal(scanner.birthdayHeight, 1234);
    assert.equal(scanner.viewOnly, true);
    assert.equal(await scanner.height(), 1295);
    assert.equal(await scanner.tip(), 1234);
    assert.equal(await scanner.addressAt(4), 'address-0-4');
    assert.deepEqual(await scanner.newSubaddress('order 7'), { address: 'fresh-0', index: 7, atHeight: 1300 });

    await scanner.sync();
    assert.deepEqual(f.calls.syncs, [1234]);
    await scanner.close();
    await scanner.close();
    assert.equal(f.calls.closes, 1);
    assert.equal(f.calls.closeSave, false);
});

test('accepts an explicit matching network and rejects a mismatch', async () => {
    const f = fixture();
    const scanner = await createBrowserScanner({
        primaryAddress: ADDRESSES.mainnet,
        privateViewKey: VIEW_KEY,
        nodeUrl: 'http://127.0.0.1:18081',
        networkType: 'MAINNET',
        restoreHeight: 99,
        monero: f.monero,
        fetchImpl: f.fetchImpl,
    });
    assert.equal(scanner.networkType, 'mainnet');
    assert.equal(scanner.birthdayHeight, 99);
    assert.equal(f.calls.fetches.length, 0);
    await scanner.close();

    await assert.rejects(createBrowserScanner({
        primaryAddress: ADDRESSES.mainnet,
        privateViewKey: VIEW_KEY,
        node: 'https://node.example',
        networkType: 'stagenet',
        monero: f.monero,
        fetchImpl: f.fetchImpl,
    }), /does not match/i);
});

test('fails closed for malformed secrets, unreachable nodes, and spend-capable wallets', async () => {
    const f = fixture({ spendKey: 'b'.repeat(64), connected: true });
    await assert.rejects(createBrowserScanner({
        primaryAddress: ADDRESSES.stagenet,
        privateViewKey: VIEW_KEY,
        node: 'https://node.example',
        restoreHeight: 100,
        monero: f.monero,
        fetchImpl: f.fetchImpl,
    }), /not view-only/i);
    assert.equal(f.calls.closes, 1);

    await assert.rejects(createBrowserScanner({
        primaryAddress: ADDRESSES.stagenet,
        privateViewKey: 'not-a-key',
        node: 'https://node.example',
        monero: f.monero,
        fetchImpl: f.fetchImpl,
    }), /private view key/i);

    const unreachable = fixture({ connected: false });
    await assert.rejects(createBrowserScanner({
        primaryAddress: ADDRESSES.stagenet,
        privateViewKey: VIEW_KEY,
        node: 'https://node.example',
        restoreHeight: 100,
        monero: unreachable.monero,
        fetchImpl: unreachable.fetchImpl,
    }), /node is not reachable/i);
    assert.equal(unreachable.calls.closes, 1);
});

test('can close after a failed sync and rejects operations after close', async () => {
    const f = fixture({ syncError: new Error('daemon disconnected') });
    const scanner = await createBrowserScanner({
        primaryAddress: ADDRESSES.stagenet,
        privateViewKey: VIEW_KEY,
        node: 'https://node.example',
        restoreHeight: 100,
        monero: f.monero,
        fetchImpl: f.fetchImpl,
    });

    await assert.rejects(scanner.sync(), /daemon disconnected/i);
    await scanner.close();
    assert.equal(f.calls.closes, 1);
    await assert.rejects(scanner.addressAt(1), /scanner is closed/i);
    await assert.rejects(scanner.height(), /scanner is closed/i);
    await assert.rejects(scanner.tip(), /scanner is closed/i);
    await assert.rejects(scanner.newSubaddress('late'), /scanner is closed/i);
    await assert.rejects(scanner.checkOrder({ subaddressIndex: 1, amount: '0.1' }), /scanner is closed/i);
    await assert.rejects(scanner.checkOrders([]), /scanner is closed/i);
});

test('checkOrder preserves birthday filtering and installment summing', async () => {
    const half = 5000000000n;
    const f = fixture({ transfers: [
        transfer({ amount: half, index: 3, height: 800, txid: '1'.repeat(64) }),
        transfer({ amount: half, index: 3, height: 1201, txid: '2'.repeat(64) }),
        transfer({ amount: half, index: 3, height: 1202, txid: '3'.repeat(64) }),
    ] });
    const scanner = await createBrowserScanner({
        primaryAddress: ADDRESSES.stagenet,
        privateViewKey: VIEW_KEY,
        node: 'https://node.example',
        restoreHeight: 1000,
        monero: f.monero,
        fetchImpl: f.fetchImpl,
    });

    const result = await scanner.checkOrder({ subaddressIndex: 3, amount: '0.01', minHeight: 1200, sync: false });
    assert.equal(result.paid, true);
    assert.equal(result.receivedPico, '10000000000');
    assert.deepEqual(result.txids, ['2'.repeat(64), '3'.repeat(64)]);
    assert.deepEqual(f.calls.transferQueries[0], { accountIndex: 0, subaddressIndex: 3, isIncoming: true });
    await scanner.close();
});

test('checkOrders scans once and classifies each subaddress independently', async () => {
    const f = fixture({ transfers: [
        transfer({ amount: 10000000000n, index: 1, height: 1201, confirmations: 3, txid: '4'.repeat(64) }),
        transfer({ amount: 10000000000n, index: 2, height: 1202, confirmations: 0, pool: true, txid: '5'.repeat(64) }),
    ] });
    const scanner = await createBrowserScanner({
        primaryAddress: ADDRESSES.stagenet,
        privateViewKey: VIEW_KEY,
        node: 'https://node.example',
        restoreHeight: 1000,
        monero: f.monero,
        fetchImpl: f.fetchImpl,
    });

    const results = await scanner.checkOrders([
        { id: 'paid', index: 1, amount: '0.01', birthdayHeight: 1200 },
        { id: 'pool', index: 2, amount: '0.01', birthdayHeight: 1200 },
    ], { sync: false });

    assert.equal(results.get('paid').status, 'paid');
    assert.equal(results.get('pool').status, 'mempool');
    assert.equal(f.calls.transferQueries.length, 1);
    assert.deepEqual(f.calls.transferQueries[0], { accountIndex: 0, isIncoming: true, txQuery: { minHeight: 1200 } });
    await scanner.close();
});

test('the browser export has no Node transport or cryptography dependency', () => {
    const root = path.join(__dirname, '..');
    const combined = ['browser-scanner.js', 'scanner-common.js', 'verify.js', 'watch.js']
        .map(file => fs.readFileSync(path.join(root, 'src', file), 'utf8'))
        .join('\n');
    assert.doesNotMatch(combined, /node:(?:http|https|crypto)|require\(['"](?:http|https|crypto)['"]\)/);
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.equal(pkg.exports['./browser-scanner'], './src/browser-scanner.js');
});
