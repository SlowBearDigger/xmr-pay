'use strict';

const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');

class NodeTransportError extends Error {
    constructor(code, message = code) {
        super(message);
        this.name = 'NodeTransportError';
        this.code = code;
    }
}

// RFC 7616 algorithm tokens and the Node hash that computes each. Anything else fails
// closed as node-auth-algorithm rather than guessing.
const DIGEST_HASHES = { 'MD5': 'md5', 'MD5-SESS': 'md5', 'SHA-256': 'sha256', 'SHA-256-SESS': 'sha256' };

function challengeParameters(header, wantedScheme) {
    const headers = Array.isArray(header) ? header : [header];
    for (const raw of headers) {
        const headerValue = String(raw == null ? '' : raw);
        let quoted = false, escaped = false;
        for (let i = 0; i < headerValue.length; i++) {
            const ch = headerValue[i];
            if (quoted) {
                if (escaped) escaped = false;
                else if (ch === '\\') escaped = true;
                else if (ch === '"') quoted = false;
                continue;
            }
            if (ch === '"') { quoted = true; continue; }
            if (i !== 0 && headerValue[i - 1] !== ',') continue;

            let tokenStart = i;
            while (/\s/.test(headerValue[tokenStart] || '')) tokenStart++;
            const scheme = /^([a-z][a-z0-9_-]*)\s+/i.exec(headerValue.slice(tokenStart));
            if (!scheme || scheme[1].toLowerCase() !== wantedScheme.toLowerCase()) continue;
            const start = tokenStart + scheme[0].length;

            quoted = false;
            escaped = false;
            for (let end = start; end < headerValue.length; end++) {
                const value = headerValue[end];
                if (quoted) {
                    if (escaped) escaped = false;
                    else if (value === '\\') escaped = true;
                    else if (value === '"') quoted = false;
                    continue;
                }
                if (value === '"') { quoted = true; continue; }
                if (value === ',' && /^\s*[a-z][a-z0-9_-]*\s+/i.test(headerValue.slice(end + 1))) {
                    return headerValue.slice(start, end);
                }
            }
            return headerValue.slice(start);
        }
    }
    return null;
}

function parseDigestChallenge(header) {
    const source = challengeParameters(header, 'digest');
    if (!source) throw new NodeTransportError('node-auth-challenge');
    const values = {};
    const pattern = /([a-z0-9_-]+)=(?:"((?:\\.|[^"\\])*)"|([^,\s]+))/gi;
    let match;
    while ((match = pattern.exec(source))) {
        values[match[1].toLowerCase()] = match[2] === undefined ? match[3] : match[2].replace(/\\(.)/g, '$1');
    }
    if (!values.realm || !values.nonce) throw new NodeTransportError('node-auth-challenge');
    return values;
}

function quote(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function digestAuthorization(node, challenge, method, requestUri) {
    const algorithm = String(challenge.algorithm || 'MD5').toUpperCase();
    if (!DIGEST_HASHES[algorithm]) throw new NodeTransportError('node-auth-algorithm');
    const h = value => crypto.createHash(DIGEST_HASHES[algorithm]).update(value).digest('hex');
    const session = algorithm.endsWith('-SESS');

    const qops = String(challenge.qop || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
    if (qops.length && !qops.includes('auth')) throw new NodeTransportError('node-auth-qop');

    const cnonce = crypto.randomBytes(12).toString('hex');
    const nc = '00000001';
    let ha1 = h(`${node.username}:${challenge.realm}:${node.password}`);
    if (session) ha1 = h(`${ha1}:${challenge.nonce}:${cnonce}`);
    const ha2 = h(`${method}:${requestUri}`);
    const response = qops.length
        ? h(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:auth:${ha2}`)
        : h(`${ha1}:${challenge.nonce}:${ha2}`);

    const fields = [
        `username="${quote(node.username)}"`,
        `realm="${quote(challenge.realm)}"`,
        `nonce="${quote(challenge.nonce)}"`,
        `uri="${quote(requestUri)}"`,
        `response="${response}"`,
        `algorithm=${algorithm}`,
    ];
    if (challenge.opaque) fields.push(`opaque="${quote(challenge.opaque)}"`);
    if (qops.length) fields.push('qop=auth', `nc=${nc}`);
    // a -sess HA1 folds the cnonce in, so the header must carry it even without qop;
    // otherwise the server cannot recompute the response at all.
    if (qops.length || session) fields.push(`cnonce="${cnonce}"`);
    return 'Digest ' + fields.join(', ');
}

function joinUrl(base, path) {
    const upstream = new URL(base);
    const request = new URL(String(path || '/'), 'http://localhost');
    const prefix = upstream.pathname.replace(/\/+$/, '');
    upstream.pathname = `${prefix}/${request.pathname.replace(/^\/+/, '')}`;
    upstream.search = request.search;
    upstream.hash = '';
    return upstream;
}

const BRIDGE_ROUTES = new Map([
    ['/get_height', new Set(['GET', 'POST'])],
    ['/getheight', new Set(['GET', 'POST'])],
    ['/get_info', new Set(['GET', 'POST'])],
    ['/getinfo', new Set(['GET', 'POST'])],
    ['/getblocks.bin', new Set(['POST'])],
    ['/gethashes.bin', new Set(['POST'])],
    ['/getblocks_by_height.bin', new Set(['POST'])],
    ['/get_transaction_pool_hashes.bin', new Set(['POST'])],
    ['/gettransactions', new Set(['POST'])],
    ['/get_transactions', new Set(['POST'])],
    ['/get_outs.bin', new Set(['POST'])],
    ['/get_output_distribution.bin', new Set(['POST'])],
    ['/is_key_image_spent', new Set(['POST'])],
]);

const BRIDGE_JSON_RPC_METHODS = new Set([
    'get_version', 'get_info', 'hard_fork_info', 'get_fee_estimate',
    'getblockheaderbyheight', 'get_block_header_by_height',
    'getblockheadersrange', 'get_block_headers_range',
    'get_output_histogram', 'get_output_distribution', 'get_txpool_backlog',
]);

function bridgeRequestAllowed(method, path, body) {
    let target;
    try { target = new URL(String(path || '/'), 'http://localhost'); }
    catch { return false; }
    if (target.search || target.hash) return false;
    const upperMethod = String(method || '').toUpperCase();
    if (target.pathname === '/json_rpc') {
        if (upperMethod !== 'POST' || !body || !body.length) return false;
        let request;
        try { request = JSON.parse(body.toString('utf8')); } catch { return false; }
        return request && !Array.isArray(request)
            && BRIDGE_JSON_RPC_METHODS.has(String(request.method || '').toLowerCase());
    }
    const methods = BRIDGE_ROUTES.get(target.pathname);
    return !!methods && methods.has(upperMethod);
}

const HOP_HEADERS = new Set([
    'authorization', 'connection', 'content-length', 'host', 'keep-alive',
    'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
    'transfer-encoding', 'upgrade',
]);

function forwardHeaders(headers) {
    const out = {};
    for (const [name, value] of Object.entries(headers || {})) {
        const lower = name.toLowerCase();
        if (!HOP_HEADERS.has(lower) && value !== undefined) out[lower] = value;
    }
    return out;
}

function requestOnce(url, { method, headers, body, timeoutMs, maxResponseBytes, signal }) {
    return new Promise((resolve, reject) => {
        const transport = url.protocol === 'https:' ? https : http;
        const requestHeaders = { ...headers };
        if (body && body.length) requestHeaders['content-length'] = String(body.length);
        let settled = false;
        let timer;
        const finish = (callback, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            callback(value);
        };
        const req = transport.request(url, { method, headers: requestHeaders, signal }, res => {
            const chunks = [];
            let size = 0;
            res.on('data', chunk => {
                size += chunk.length;
                if (size > maxResponseBytes) {
                    res.destroy(new NodeTransportError('node-response-too-large'));
                    return;
                }
                chunks.push(chunk);
            });
            res.on('end', () => finish(resolve, { status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks) }));
            res.on('error', error => finish(reject, error));
        });
        req.on('error', error => finish(reject,
            error && error.name === 'AbortError' ? new NodeTransportError('node-aborted') : error));
        timer = setTimeout(() => req.destroy(new NodeTransportError('node-timeout')), Math.max(1, Number(timeoutMs) || 1));
        if (timer.unref) timer.unref();
        if (body && body.length) req.write(body);
        req.end();
    });
}

function validateResponse(response) {
    if (response.status >= 300 && response.status < 400) throw new NodeTransportError('node-redirect');
    if (response.status === 401 || response.status === 403) throw new NodeTransportError('node-auth');
    if (response.status < 200 || response.status >= 300) throw new NodeTransportError(`node-http-${response.status}`);
    let json = null;
    try { json = JSON.parse(response.body.toString('utf8')); } catch { }
    return { ...response, json };
}

async function requestNode(node, { method = 'GET', path = '/', headers = {}, body, timeoutMs = 20000, maxResponseBytes = 128 * 1024 * 1024, signal } = {}) {
    const upperMethod = String(method).toUpperCase();
    const payload = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(body);
    const upstream = joinUrl(node.url, path);
    const baseHeaders = forwardHeaders(headers);
    const deadline = Date.now() + Math.max(1, Number(timeoutMs) || 1);
    const remaining = () => {
        const value = deadline - Date.now();
        if (value <= 0) throw new NodeTransportError('node-timeout');
        return value;
    };

    if (node.auth === 'basic') {
        baseHeaders.authorization = 'Basic ' + Buffer.from(`${node.username}:${node.password}`).toString('base64');
        return validateResponse(await requestOnce(upstream, { method: upperMethod, headers: baseHeaders, body: payload, timeoutMs: remaining(), maxResponseBytes, signal }));
    }

    if (node.auth === 'digest') {
        const challengeResponse = await requestOnce(upstream, { method: upperMethod, headers: baseHeaders, body: payload, timeoutMs: remaining(), maxResponseBytes, signal });
        if (challengeResponse.status >= 300 && challengeResponse.status < 400) throw new NodeTransportError('node-redirect');
        if (challengeResponse.status !== 401) return validateResponse(challengeResponse);
        let challenge = parseDigestChallenge(challengeResponse.headers['www-authenticate']);
        // stale=true on a 401 means the credentials were fine and only the nonce expired
        // between challenge and reply (RFC 7616 section 3.3): retry once with the fresh nonce,
        // never more, so a server that always claims stale cannot loop us.
        for (let attempt = 0; ; attempt++) {
            const authHeaders = { ...baseHeaders, authorization: digestAuthorization(node, challenge, upperMethod, upstream.pathname + upstream.search) };
            const response = await requestOnce(upstream, { method: upperMethod, headers: authHeaders, body: payload, timeoutMs: remaining(), maxResponseBytes, signal });
            if (response.status === 401 && attempt === 0) {
                let renewed = null;
                try { renewed = parseDigestChallenge(response.headers['www-authenticate']); } catch { renewed = null; }
                if (renewed && String(renewed.stale || '').toLowerCase() === 'true') { challenge = renewed; continue; }
            }
            return validateResponse(response);
        }
    }

    return validateResponse(await requestOnce(upstream, { method: upperMethod, headers: baseHeaders, body: payload, timeoutMs: remaining(), maxResponseBytes, signal }));
}

async function createNodeBridge(node, { timeoutMs = 120000, maxRequestBytes = 64 * 1024 * 1024 } = {}) {
    const sockets = new Set();
    const controllers = new Set();
    const server = http.createServer((req, res) => {
        const chunks = [];
        let size = 0, ended = false;
        req.on('data', chunk => {
            size += chunk.length;
            if (size > maxRequestBytes) {
                ended = true;
                res.writeHead(413).end();
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', async () => {
            if (ended) return;
            const body = chunks.length ? Buffer.concat(chunks) : null;
            if (!bridgeRequestAllowed(req.method, req.url, body)) {
                const payload = Buffer.from(JSON.stringify({ error: 'bridge-rpc-denied' }));
                res.writeHead(403, { 'content-type': 'application/json', 'content-length': String(payload.length) });
                res.end(payload);
                return;
            }
            const controller = new AbortController();
            controllers.add(controller);
            const abort = () => controller.abort();
            req.once('aborted', abort);
            res.once('close', () => { if (!res.writableEnded) abort(); });
            try {
                const upstream = await requestNode(node, {
                    method: req.method || 'GET',
                    path: req.url || '/',
                    headers: req.headers,
                    body,
                    timeoutMs,
                    signal: controller.signal,
                });
                const responseHeaders = {};
                for (const name of ['content-type', 'content-encoding']) {
                    if (upstream.headers[name] !== undefined) responseHeaders[name] = upstream.headers[name];
                }
                responseHeaders['content-length'] = String(upstream.body.length);
                if (!res.destroyed) {
                    res.writeHead(upstream.status, responseHeaders);
                    res.end(upstream.body);
                }
            } catch (error) {
                const code = error && error.code ? error.code : 'node-transport';
                const payload = Buffer.from(JSON.stringify({ error: code }));
                if (!res.destroyed && !res.writableEnded) {
                    res.writeHead(502, { 'content-type': 'application/json', 'content-length': String(payload.length) });
                    res.end(payload);
                }
            } finally {
                controllers.delete(controller);
            }
        });
    });
    server.on('connection', socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    let closePromise = null;
    return {
        url: `http://127.0.0.1:${address.port}`,
        async close() {
            if (closePromise) return closePromise;
            closePromise = (async () => {
                for (const controller of controllers) controller.abort();
                for (const socket of sockets) socket.destroy();
                if (server.listening) await new Promise(resolve => server.close(resolve));
            })();
            return closePromise;
        },
    };
}

module.exports = { NodeTransportError, requestNode, createNodeBridge };
