// Exercise the real HTTP agent with a local scanner double.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { once } = require('node:events');

if (process.env.XMR_HTTP_TEST_CHILD) {
    let index = 0;
    const scanner = {
        viewOnly: true, birthdayHeight: 100, node: 'http://127.0.0.1',
        async newSubaddress() { return { address: 'test-address', index: ++index, atHeight: 100 }; },
        async checkOrder() { return { paid: false, status: 'pending', receivedXmr: 0 }; },
        async tipHeight() { return 100; }, async height() { return 100; },
        async sync() {}, async save() {}, async close() {},
    };
    require.cache[require.resolve('../src/scanner')] = { exports: { createScanner: async () => scanner } };
    const http = require('node:http');
    const create = http.createServer;
    http.createServer = (...args) => {
        const server = create(...args);
        server.once('listening', () => process.send(server.address().port));
        return server;
    };
    require('../examples/scanner-agent');
} else {
    (async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xmr-http-'));
        const child = fork(__filename, [], {
            env: {
                PATH: process.env.PATH, XMR_HTTP_TEST_CHILD: '1',
                XMR_PRIMARY_ADDRESS: 'test', XMR_VIEW_KEY: 'test',
                XMR_NODES: 'http://127.0.0.1:1', AGENT_TOKEN: 'test-token',
                XMR_ORDERS_FILE: path.join(dir, 'orders.json'),
                XMR_RECEIPT_KEY: path.join(dir, 'receipt.pem'), PORT: '0',
            }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
        });
        try {
            const [port] = await once(child, 'message', { signal: AbortSignal.timeout(10000) });
            const base = `http://127.0.0.1:${port}`;
            const post = (body, token = 'test-token', type = 'application/json') => fetch(base + '/order', {
                method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': type },
                body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
            });
            assert.equal((await post({ amount: '1' }, 'wrong')).status, 401);
            for (const body of [null, [], { amount: [1] }, { amount: '1', id: {} }]) {
                const response = await post(body);
                assert.ok(response.status >= 400 && response.status < 500);
            }
            assert.equal((await post({ amount: '1' }, 'test-token', 'text/plain')).status, 415);
            const response = await post({ amount: '1' });
            assert.equal(response.status, 200);
            const order = await response.json();
            assert.equal(order.amount, '1');
            assert.equal((await fetch(base + '/order/' + order.id)).status, 401);
            assert.equal((await fetch(base + '/healthz')).status, 401);
            const numbered = await post({ amount: '1', id: 42 });
            assert.equal(numbered.status, 200);
            assert.equal((await numbered.json()).id, '42');
            assert.equal((await fetch(base + '/order/42', { headers: { authorization: 'Bearer test-token' } })).status, 200);
            console.log('HTTP authentication, malformed input and valid creation passed');
        } finally {
            const exited = once(child, 'exit');
            child.kill('SIGTERM');
            if (child.exitCode === null && child.signalCode === null) await exited;
            fs.rmSync(dir, { recursive: true, force: true });
        }
    })().catch(error => { console.error(error); process.exitCode = 1; });
}
