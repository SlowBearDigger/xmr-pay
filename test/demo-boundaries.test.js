// Check static demo paths without serving files outside its public directory.
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
let handler;
const reads = [];
vm.runInNewContext(fs.readFileSync(require.resolve('../demo/server.js'), 'utf8'), {
    require(name) {
        if (name === 'http') return { createServer(callback) { handler = callback; return { listen() {} }; } };
        if (name === 'fs') return { readFile(file) { reads.push(file); } };
        if (name === './verify-handler') return {};
        return require(name);
    },
    __dirname: path.resolve(__dirname, '../demo'), process: { env: {} },
    setInterval: () => ({ unref() {} }),
});
(async () => {
    let code;
    const response = { writeHead(value) { code = value; }, end() {} };
    await handler({ method: 'GET', url: '/../public-private/secret' }, response);
    assert.equal(code, 403);
    assert.equal(reads.length, 0);
    await handler({ method: 'GET', url: '/' }, response);
    assert.deepEqual(reads, [path.resolve(__dirname, '../demo/public/index.html')]);
    console.log('demo static path containment passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
