'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createAgentHealthMonitor } = require('../src/agent-health');

test('stale successful heights fail closed after the daemon becomes unavailable', async () => {
    let now = 0;
    let daemonAvailable = true;
    const monitor = createAgentHealthMonitor({
        readDaemonHeight: async () => {
            if (!daemonAvailable) throw new Error('node offline');
            return 100;
        },
        readWalletHeight: async () => 100,
        daemonCacheMs: 5_000,
        walletCacheMs: 3_000,
        syncGap: 2,
        now: () => now,
    });

    assert.deepEqual(await monitor.snapshot(), {
        state: 'ready',
        synced: true,
        nodeReachable: true,
        walletReadable: true,
        daemonHeight: 100,
        walletHeight: 100,
        lastDaemonHeight: 100,
        lastWalletHeight: 100,
        daemonHeightUpdatedAt: 0,
        walletHeightUpdatedAt: 0,
    });

    daemonAvailable = false;
    now = 5_001;
    const offline = await monitor.snapshot();
    assert.equal(offline.state, 'node-unavailable');
    assert.equal(offline.synced, null);
    assert.equal(offline.nodeReachable, false);
    assert.equal(offline.daemonHeight, null);
    assert.equal(offline.lastDaemonHeight, 100);
    assert.equal(offline.daemonHeightUpdatedAt, 0);
});

test('an unreadable wallet height cannot retain a ready health verdict', async () => {
    let now = 0;
    let walletReadable = true;
    const monitor = createAgentHealthMonitor({
        readDaemonHeight: async () => 200,
        readWalletHeight: async () => {
            if (!walletReadable) throw new Error('wallet unavailable');
            return 200;
        },
        daemonCacheMs: 5_000,
        walletCacheMs: 3_000,
        now: () => now,
    });

    assert.equal((await monitor.snapshot()).synced, true);
    walletReadable = false;
    now = 3_001;
    const unavailable = await monitor.snapshot();
    assert.equal(unavailable.state, 'wallet-unavailable');
    assert.equal(unavailable.synced, null);
    assert.equal(unavailable.walletReadable, false);
    assert.equal(unavailable.walletHeight, null);
    assert.equal(unavailable.lastWalletHeight, 200);
});

test('a live wallet behind the live daemon reports syncing with current heights', async () => {
    const monitor = createAgentHealthMonitor({
        readDaemonHeight: async () => 250,
        readWalletHeight: async () => 240,
        syncGap: 2,
    });

    const health = await monitor.snapshot();
    assert.equal(health.state, 'syncing');
    assert.equal(health.synced, false);
    assert.equal(health.nodeReachable, true);
    assert.equal(health.walletReadable, true);
});

test('a wallet implausibly ahead of its daemon fails closed as syncing', async () => {
    const monitor = createAgentHealthMonitor({
        readDaemonHeight: async () => 100,
        readWalletHeight: async () => 500,
        syncGap: 2,
    });

    const health = await monitor.snapshot();
    assert.equal(health.state, 'syncing');
    assert.equal(health.synced, false);
});
