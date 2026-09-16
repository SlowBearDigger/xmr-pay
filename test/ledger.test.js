const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadOrders, saveOrders } = require('../src/ledger');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xmrpay-ledger-'));
const file = path.join(dir, 'orders.json');
try {
    assert.strictEqual(loadOrders(file).size, 0);
    saveOrders(file, new Map([['one', { id: 'one', paid: false }]]));
    assert.strictEqual(loadOrders(file).get('one').paid, false);
    assert.strictEqual(fs.readdirSync(dir).length, 1);
    const rename = fs.renameSync;
    fs.renameSync = () => { throw new Error('simulated rename failure'); };
    try { assert.throws(() => saveOrders(file, new Map()), /simulated rename failure/); }
    finally { fs.renameSync = rename; }
    assert.strictEqual(loadOrders(file).size, 1);
    assert.strictEqual(fs.readdirSync(dir).length, 1);
    fs.writeFileSync(file, '{');
    assert.throws(() => loadOrders(file), SyntaxError);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), '{');
    console.log('order ledger persistence OK');
} finally {
    fs.rmSync(dir, { recursive: true, force: true });
}
