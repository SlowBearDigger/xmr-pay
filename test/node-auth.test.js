'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { requestNode, createNodeBridge } = require('../src/node-transport');
const { createScanner } = require('../src/scanner');
const { probeNodeHeights } = require('../bin/agent.js');

let pass = 0, fail = 0;
function ok(name, condition, extra = '') {
    if (condition) { pass++; console.log(`PASS  ${name}`); return; }
    fail++;
    console.log(`FAIL  ${name}${extra ? `  ${extra}` : ''}`);
}

const md5 = value => crypto.createHash('md5').update(value).digest('hex');
function parseDigest(header) {
    const out = {};
    const source = String(header || '').replace(/^Digest\s+/i, '');
    const pattern = /([a-z0-9_-]+)=(?:"((?:\\.|[^"\\])*)"|([^,\s]+))/gi;
    let match;
    while ((match = pattern.exec(source))) out[match[1].toLowerCase()] = match[2] === undefined ? match[3] : match[2].replace(/\\(.)/g, '$1');
    return out;
}

function verifyDigest(req, username, password, realm, nonce) {
    const values = parseDigest(req.headers.authorization);
    if (values.username !== username || values.realm !== realm || values.nonce !== nonce || values.qop !== 'auth') return false;
    const ha1 = md5(`${username}:${realm}:${password}`);
    const ha2 = md5(`${req.method}:${values.uri}`);
    const expected = md5(`${ha1}:${nonce}:${values.nc}:${values.cnonce}:auth:${ha2}`);
    return values.response === expected;
}

async function listen(handler) {
    const server = http.createServer(handler);
    const sockets = new Set();
    server.on('connection', socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    return {
        url: `http://127.0.0.1:${address.port}`,
        close: () => {
            for (const socket of sockets) socket.destroy();
            return new Promise(resolve => server.close(resolve));
        },
    };
}

async function main() {
    const basicUser = 'basic-a', basicPass = 'basic-secret-a';
    let basicHits = 0;
    const basic = await listen((req, res) => {
        basicHits++;
        const expected = 'Basic ' + Buffer.from(`${basicUser}:${basicPass}`).toString('base64');
        if (req.headers.authorization !== expected) {
            res.writeHead(401, { 'www-authenticate': 'Basic realm="node"' });
            res.end('unauthorized');
            return;
        }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ height: 12345 }));
    });

    const digestUser = 'digest-a', digestPass = 'digest-secret-a';
    const realm = 'monero"rpc', realmHeader = realm.replace(/(["\\])/g, '\\$1'), nonce = 'fixed-test-nonce';
    let digestChallenges = 0, digestAccepted = 0;
    const digest = await listen((req, res) => {
        if (!req.headers.authorization) {
            digestChallenges++;
            res.writeHead(401, { 'www-authenticate': `Digest realm="${realmHeader}", nonce="${nonce}", algorithm=MD5, qop="auth", Basic realm="fallback"` });
            res.end('challenge');
            return;
        }
        if (!verifyDigest(req, digestUser, digestPass, realm, nonce)) {
            res.writeHead(401, { 'www-authenticate': `Digest realm="${realmHeader}", nonce="${nonce}", algorithm=MD5, qop="auth", Basic realm="fallback"` });
            res.end('bad digest');
            return;
        }
        digestAccepted++;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ height: 23456 }));
    });

    let collectorHits = 0;
    const collector = await listen((req, res) => { collectorHits++; res.end('{"height":99999}'); });
    const redirect = await listen((req, res) => { res.writeHead(302, { location: collector.url + '/get_height' }); res.end(); });
    let unavailableHits = 0;
    const unavailable = await listen((req, res) => { unavailableHits++; res.writeHead(503).end('down'); });

    const basicNode = { url: basic.url, auth: 'basic', username: basicUser, password: basicPass, allow_insecure_http: true };
    const digestNode = { url: digest.url, auth: 'digest', username: digestUser, password: digestPass, allow_insecure_http: true };
    try {
        const basicResult = await requestNode(basicNode, { path: '/get_height' });
        ok('Basic request authenticates', basicResult.json.height === 12345 && basicHits === 1);

        const digestResult = await requestNode(digestNode, { path: '/get_height' });
        ok('Digest request isolates its challenge from a following Basic challenge', digestResult.json.height === 23456 && digestChallenges === 1 && digestAccepted === 1);

        const probeBasicBefore = basicHits, probeDigestBefore = digestAccepted;
        const heights = typeof probeNodeHeights === 'function'
            ? await probeNodeHeights([{ url: unavailable.url, auth: 'none' }, basicNode, digestNode])
            : [];
        ok('setup probes every configured node', heights.length === 3 && unavailableHits > 0 && basicHits > probeBasicBefore && digestAccepted > probeDigestBefore);
        ok('setup preserves configured order and usable secondary heights', heights[0] === 0 && heights[1] === 12345 && heights[2] === 23456);

        const swapped = [
            { ...digestNode, url: basic.url, auth: 'basic' },
            { ...basicNode, url: digest.url, auth: 'digest' },
        ];
        const settled = await Promise.allSettled(swapped.map(node => requestNode(node, { path: '/get_height' })));
        ok('credentials never cross node rows', settled.every(result => result.status === 'rejected'));
        ok('authentication errors redact passwords', settled.every(result => !String(result.reason && result.reason.message).includes('secret')));

        let redirectError;
        try {
            await requestNode({ ...digestNode, url: redirect.url }, { path: '/get_height' });
        } catch (error) { redirectError = error; }
        ok('authenticated redirect is rejected', redirectError && redirectError.code === 'node-redirect');
        ok('redirect target receives no request', collectorHits === 0);

        const bridge = await createNodeBridge(basicNode);
        try {
            const response = await fetch(bridge.url + '/get_height', { redirect: 'manual' });
            const body = await response.json();
            ok('loopback bridge authenticates upstream', response.ok && body.height === 12345);
            ok('loopback bridge binds to localhost', new URL(bridge.url).hostname === '127.0.0.1');

            const beforeDenied = basicHits;
            const denied = await fetch(bridge.url + '/json_rpc', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: '0', method: 'start_mining', params: {} }),
            });
            ok('loopback bridge denies mutating daemon RPC', denied.status === 403);
            ok('denied daemon RPC never reaches the protected node', basicHits === beforeDenied);
        } finally {
            await bridge.close();
        }

        const trickle = await listen((req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            const timer = setInterval(() => res.write(' '), 10);
            setTimeout(() => { clearInterval(timer); res.end(); }, 250);
            res.on('close', () => clearInterval(timer));
        });
        try {
            const startedAt = Date.now();
            let timeoutError;
            try { await requestNode({ url: trickle.url, auth: 'none' }, { path: '/get_height', timeoutMs: 50 }); }
            catch (error) { timeoutError = error; }
            ok('node timeout is an absolute deadline, not an idle timeout', timeoutError && timeoutError.code === 'node-timeout' && Date.now() - startedAt < 200);
        } finally {
            await trickle.close();
        }

        const slowDigest = await listen((req, res) => {
            if (!req.headers.authorization) {
                setTimeout(() => {
                    res.writeHead(401, { 'www-authenticate': 'Digest realm="slow", nonce="slow-nonce", algorithm=MD5, qop="auth"' });
                    res.end('challenge');
                }, 40);
                return;
            }
            setTimeout(() => {
                res.setHeader('content-type', 'application/json');
                res.end('{"height":34567}');
            }, 40);
        });
        try {
            const startedAt = Date.now();
            let timeoutError;
            try {
                await requestNode({ url: slowDigest.url, auth: 'digest', username: 'u', password: 'p', allow_insecure_http: true },
                    { path: '/get_height', timeoutMs: 60 });
            } catch (error) { timeoutError = error; }
            ok('Digest challenge and authenticated retry share one deadline', timeoutError && timeoutError.code === 'node-timeout' && Date.now() - startedAt < 110);
        } finally {
            await slowDigest.close();
        }

        let slowStartedResolve, slowClosedResolve;
        const slowStarted = new Promise(resolve => { slowStartedResolve = resolve; });
        const slowClosed = new Promise(resolve => { slowClosedResolve = resolve; });
        const slow = await listen((req, res) => {
            slowStartedResolve();
            res.on('close', slowClosedResolve);
        });
        const slowBridge = await createNodeBridge({ url: slow.url, auth: 'basic', username: 'u', password: 'p', allow_insecure_http: true }, { timeoutMs: 5000 });
        try {
            const pending = fetch(slowBridge.url + '/get_height').catch(error => error);
            await slowStarted;
            await slowBridge.close();
            const upstreamClosed = await Promise.race([
                slowClosed.then(() => true),
                new Promise(resolve => setTimeout(() => resolve(false), 300)),
            ]);
            await pending;
            ok('closing bridge aborts its in-flight authenticated upstream request', upstreamClosed);
        } finally {
            await slowBridge.close();
            await slow.close();
        }

        let daemonConnection = null;
        let walletClosed = false;
        let createdWith = null;
        const fakeWallet = {
            async setDaemonConnection(connection) { daemonConnection = connection; },
            async isConnectedToDaemon() {
                try {
                    const uri = typeof daemonConnection === 'string' ? daemonConnection : daemonConnection.uri;
                    const response = await fetch(uri + '/get_height', { redirect: 'manual' });
                    return response.ok;
                } catch { return false; }
            },
            async getPrivateSpendKey() { return '0'.repeat(64); },
            async close() { walletClosed = true; },
        };
        const fakeMonero = {
            async createWalletFull(options) { createdWith = options; return fakeWallet; },
        };
        const scanner = await createScanner({
            primaryAddress: '5'.repeat(95),
            privateViewKey: 'a'.repeat(64),
            networkType: 'stagenet',
            nodes: [basicNode, digestNode],
            monero: fakeMonero,
        });
        const bridgeUri = typeof daemonConnection === 'string' ? daemonConnection : daemonConnection.uri;
        ok('scanner reads its birthday through authenticated Basic', scanner.birthdayHeight === 12345 && createdWith.restoreHeight === 12345);
        ok('scanner reports the public upstream, not bridge or credentials', scanner.node === basicNode.url);
        ok('scanner connects wallet through loopback bridge', new URL(bridgeUri).hostname === '127.0.0.1' && bridgeUri !== basicNode.url);
        ok('scanner status reads authenticated daemon height', await scanner.tipHeight() === 12345);
        await scanner.close(false);
        ok('scanner closes its wallet', walletClosed);
        let bridgeStillOpen = true;
        try { await fetch(bridgeUri + '/get_height'); } catch { bridgeStillOpen = false; }
        ok('scanner closes its authenticated bridge', bridgeStillOpen === false);

        let failoverSetCalls = 0;
        const failoverWallet = {
            async setDaemonConnection() { failoverSetCalls++; },
            async isConnectedToDaemon() { return failoverSetCalls >= 2; },
            async getPrivateSpendKey() { return '0'.repeat(64); },
            async close() {},
        };
        const failoverScanner = await createScanner({
            primaryAddress: '5'.repeat(95),
            privateViewKey: 'a'.repeat(64),
            networkType: 'stagenet',
            nodes: [basicNode, digestNode],
            monero: { async createWalletFull() { return failoverWallet; } },
        });
        try {
            ok('scanner reports the secondary selected by wallet failover', failoverScanner.node === digestNode.url);
            ok('scanner tip reads the active secondary before the failed primary', await failoverScanner.tipHeight() === 23456);
        } finally {
            await failoverScanner.close(false);
        }
    } finally {
        await Promise.all([basic.close(), digest.close(), redirect.close(), collector.close(), unavailable.close()]);
    }

    console.log(`\n${fail ? `FAILED (${fail})` : 'ALL GREEN'}  ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
}

main().catch(error => {
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
});
