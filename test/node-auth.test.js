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

        // the redirect test above is a GET; POST must behave the same: a 3xx answer to an
        // authenticated POST is refused outright and the target never sees the credentials.
        let postRedirectError;
        try {
            await requestNode({ ...digestNode, url: redirect.url }, { method: 'POST', path: '/json_rpc', body: JSON.stringify({ method: 'get_info' }) });
        } catch (error) { postRedirectError = error; }
        ok('authenticated POST redirect is rejected', postRedirectError && postRedirectError.code === 'node-redirect');
        ok('POST redirect target receives no request', collectorHits === 0);

        // digest fails closed: a challenge the client cannot answer safely is an error with a
        // specific code, never a downgraded or guessed second request.
        const badChallenges = [
            ['node-auth-challenge', 'Bearer realm="node"'],
            ['node-auth-challenge', 'Digest realm="node"'],
            ['node-auth-algorithm', 'Digest realm="node", nonce="n", algorithm=SHA-512'],
            ['node-auth-qop', 'Digest realm="node", nonce="n", algorithm=MD5, qop="auth-int"'],
        ];
        for (const [expected, header] of badChallenges) {
            let strictHits = 0;
            const strict = await listen((req, res) => {
                strictHits++;
                res.writeHead(401, { 'www-authenticate': header });
                res.end('challenge');
            });
            let failure;
            try {
                await requestNode({ ...digestNode, url: strict.url }, { path: '/get_height' });
            } catch (error) { failure = error; }
            await strict.close();
            ok(`unanswerable digest challenge fails closed (${expected})`, failure && failure.code === expected && strictHits === 1);
        }

        // pin redaction on the whole error object, not just the message: nothing serializable
        // on a rejection may carry a password.
        let wrongPassError;
        try {
            await requestNode({ ...digestNode, password: 'deliberately-wrong' }, { path: '/get_height' });
        } catch (error) { wrongPassError = error; }
        const serialized = JSON.stringify(wrongPassError, Object.getOwnPropertyNames(wrongPassError || {}));
        ok('wrong digest password has a specific code', wrongPassError && wrongPassError.code === 'node-auth');
        ok('rejection carries no password anywhere on the error', !serialized.includes('deliberately-wrong') && !serialized.includes(digestPass));

        // RFC 7616 SHA-256: same handshake, stronger hash. A modern proxy works as-is.
        const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
        let shaAccepted = 0;
        const shaNode = await listen((req, res) => {
            if (!req.headers.authorization) {
                res.writeHead(401, { 'www-authenticate': 'Digest realm="node", nonce="sha-nonce", algorithm=SHA-256, qop="auth"' });
                res.end('challenge');
                return;
            }
            const values = parseDigest(req.headers.authorization);
            const ha1 = sha256(`${digestUser}:node:${digestPass}`);
            const ha2 = sha256(`${req.method}:${values.uri}`);
            const expected = sha256(`${ha1}:sha-nonce:${values.nc}:${values.cnonce}:auth:${ha2}`);
            if (values.response !== expected) { res.writeHead(403); res.end('bad'); return; }
            shaAccepted++;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ height: 34567 }));
        });
        const shaResult = await requestNode({ ...digestNode, url: shaNode.url }, { path: '/get_height' });
        await shaNode.close();
        ok('SHA-256 digest authenticates', shaResult.json.height === 34567 && shaAccepted === 1);

        // an -sess HA1 folds the cnonce in, so even without qop the header must carry the
        // cnonce or the server cannot recompute the response.
        let sessAccepted = 0;
        const sessNode = await listen((req, res) => {
            if (!req.headers.authorization) {
                res.writeHead(401, { 'www-authenticate': 'Digest realm="node", nonce="sess-nonce", algorithm=MD5-sess' });
                res.end('challenge');
                return;
            }
            const values = parseDigest(req.headers.authorization);
            const ha1 = md5(`${md5(`${digestUser}:node:${digestPass}`)}:sess-nonce:${values.cnonce}`);
            const expected = md5(`${ha1}:sess-nonce:${md5(`${req.method}:${values.uri}`)}`);
            if (!values.cnonce || values.response !== expected) { res.writeHead(403); res.end('bad'); return; }
            sessAccepted++;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ height: 45678 }));
        });
        const sessResult = await requestNode({ ...digestNode, url: sessNode.url }, { path: '/get_height' });
        await sessNode.close();
        ok('MD5-sess without qop still carries the cnonce the server needs', sessResult.json.height === 45678 && sessAccepted === 1);

        // an expired nonce (401 stale=true) gets exactly one retry with the fresh nonce.
        let staleAuthed = 0;
        const staleNode = await listen((req, res) => {
            if (!req.headers.authorization) {
                res.writeHead(401, { 'www-authenticate': 'Digest realm="node", nonce="old", algorithm=MD5, qop="auth"' });
                res.end('challenge');
                return;
            }
            staleAuthed++;
            if (parseDigest(req.headers.authorization).nonce === 'old') {
                res.writeHead(401, { 'www-authenticate': 'Digest realm="node", nonce="fresh", algorithm=MD5, qop="auth", stale=true' });
                res.end('stale');
                return;
            }
            if (!verifyDigest(req, digestUser, digestPass, 'node', 'fresh')) { res.writeHead(403); res.end('bad'); return; }
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ height: 56789 }));
        });
        const staleResult = await requestNode({ ...digestNode, url: staleNode.url }, { path: '/get_height' });
        await staleNode.close();
        ok('expired nonce retries once with the fresh nonce', staleResult.json.height === 56789 && staleAuthed === 2);

        // a server that always answers stale=true gets that one retry and then a hard
        // node-auth, never a loop.
        let loopAuthed = 0;
        const loopNode = await listen((req, res) => {
            if (!req.headers.authorization) {
                res.writeHead(401, { 'www-authenticate': 'Digest realm="node", nonce="n1", algorithm=MD5, qop="auth"' });
                res.end('challenge');
                return;
            }
            loopAuthed++;
            res.writeHead(401, { 'www-authenticate': `Digest realm="node", nonce="n${loopAuthed + 1}", algorithm=MD5, qop="auth", stale=true` });
            res.end('stale again');
        });
        let loopError;
        try {
            await requestNode({ ...digestNode, url: loopNode.url }, { path: '/get_height' });
        } catch (error) { loopError = error; }
        await loopNode.close();
        ok('perpetual stale cannot loop requests', loopError && loopError.code === 'node-auth' && loopAuthed === 2);

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
