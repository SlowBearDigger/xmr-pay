'use strict';

const { normalizeNodes, nodesFromEnv, publicNodes, toMoneroConnection } = require('../src/nodes');

let pass = 0, fail = 0;
function ok(name, condition, extra = '') {
    if (condition) { pass++; console.log(`PASS  ${name}`); return; }
    fail++;
    console.log(`FAIL  ${name}${extra ? `  ${extra}` : ''}`);
}
function rejects(name, value, code) {
    try {
        normalizeNodes(value);
        ok(name, false, 'accepted invalid input');
    } catch (error) {
        ok(name, error && error.code === code, error && `${error.name}:${error.code || error.message}`);
    }
}

const legacy = normalizeNodes('https://node-a.example\nhttp://127.0.0.1:38090, https://node-b.example/');
ok('legacy comma and newline list', legacy.length === 3);
ok('legacy rows are unauthenticated', legacy[0].auth === 'none' && legacy[0].username === '' && legacy[0].password === '');
ok('trailing slash normalized', legacy[2].url === 'https://node-b.example');

const digest = normalizeNodes({
    url: 'http://127.0.0.1:38093',
    auth: 'DIGEST',
    username: 'digest-a',
    password: 'secret-a',
    allow_insecure_http: true,
});
ok('single object row accepted', digest.length === 1);
ok('digest normalized', digest[0].auth === 'digest');
ok('credentials remain bound to their row', digest[0].username === 'digest-a' && digest[0].password === 'secret-a');

const json = normalizeNodes(JSON.stringify([
    { url: 'https://node-a.example', auth: 'basic', username: 'a', password: 'one' },
    { url: 'https://node-b.example', auth: 'basic', username: 'b', password: 'two' },
]));
ok('JSON credentials stay isolated', json[0].password === 'one' && json[1].password === 'two');
const swapped = normalizeNodes([json[1], json[0]]);
ok('credential swapping keeps each row intact', swapped[0].url.endsWith('node-b.example') && swapped[0].username === 'b' && swapped[0].password === 'two');

const safe = publicNodes(digest);
const safeJson = JSON.stringify(safe);
ok('public nodes redact password', !safeJson.includes('secret-a'));
ok('public nodes redact username', !safeJson.includes('digest-a'));
ok('public nodes preserve safe metadata', safe[0].url === 'http://127.0.0.1:38093' && safe[0].auth === 'digest' && safe[0].allow_insecure_http === true);

const none = normalizeNodes({ url: 'https://node.example', auth: 'none', username: 'clear-me', password: 'clear-me' });
ok('auth none clears credentials', none[0].username === '' && none[0].password === '');
ok('unauthenticated monero connection stays a string', toMoneroConnection(none[0]) === 'https://node.example');
const connection = toMoneroConnection(digest[0]);
ok('authenticated monero connection uses an object', connection.uri === digest[0].url && connection.username === 'digest-a' && connection.password === 'secret-a');
ok('monero connection does not expose auth-only flags', Object.keys(connection).sort().join(',') === 'password,uri,username');

rejects('invalid scheme rejected', 'ftp://node.example', 'invalid-scheme');
rejects('embedded credentials rejected', 'https://user:pass@node.example', 'embedded-credentials');
rejects('missing password rejected', [{ url: 'https://node.example', auth: 'basic', username: 'a' }], 'missing-credentials');
rejects('invalid auth rejected', [{ url: 'https://node.example', auth: 'bearer', username: 'a', password: 'b' }], 'invalid-auth');
rejects('colon in authenticated username rejected', [{ url: 'https://node.example', auth: 'basic', username: 'shop:eu', password: 'b' }], 'invalid-username');
rejects('authenticated HTTP requires opt in', [{ url: 'http://127.0.0.1:38091', auth: 'basic', username: 'a', password: 'b' }], 'insecure-http-auth');
rejects('query rejected', 'https://node.example/rpc?token=no', 'invalid-url');
rejects('fragment rejected', 'https://node.example/rpc#token', 'invalid-url');
rejects('empty userinfo rejected', 'https://@node.example', 'embedded-credentials');
rejects('empty query rejected', 'https://node.example?', 'invalid-url');
rejects('empty fragment rejected', 'https://node.example#', 'invalid-url');
rejects('backslashes rejected', 'https:\\\\node.example', 'invalid-url');
rejects('unbracketed IPv6 host rejected', 'https://::1:18081', 'invalid-url');
rejects('single-slash scheme rejected', 'https:/node.example', 'invalid-url');
rejects('slashless scheme rejected', 'https:node.example', 'invalid-url');
rejects('invalid JSON rejected', '[not-json]', 'invalid-json');
rejects('empty list rejected', '', 'empty-node-list');
rejects('invalid list rejected', 42, 'invalid-node-list');

const fromJson = nodesFromEnv({
    XMR_NODES_JSON: JSON.stringify([{ url: 'https://private.example', auth: 'digest', username: 'json-user', password: 'json-pass' }]),
    XMR_NODES: 'https://legacy.example',
});
ok('XMR_NODES_JSON takes precedence over XMR_NODES', fromJson[0].username === 'json-user' && fromJson[0].url === 'https://private.example');
const fromLegacy = nodesFromEnv({ XMR_NODES: 'https://legacy-a.example,https://legacy-b.example' });
ok('XMR_NODES legacy environment remains supported', fromLegacy.length === 2 && fromLegacy.every(node => node.auth === 'none'));
let malformedCode = '';
try { nodesFromEnv({ XMR_NODES_JSON: '[invalid]', XMR_NODES: 'https://legacy.example' }); } catch (error) { malformedCode = error.code; }
ok('malformed XMR_NODES_JSON fails closed without fallback', malformedCode === 'invalid-json');

console.log(`\n${fail ? `FAILED (${fail})` : 'ALL GREEN'}  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
