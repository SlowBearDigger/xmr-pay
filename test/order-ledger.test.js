// Durable order-ledger regression tests. These exercise real filesystem writes
// in a private temp directory and deliberately corrupt both primary and backup
// copies to prove startup fails closed when recovery is impossible.

const fs = require('fs');
const os = require('os');
const path = require('path');

let ledger = {};
try { ledger = require('../src/order-ledger'); } catch { /* RED: module not implemented yet */ }

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  - ' + extra : ''}`); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xmr-pay-ledger-'));
const file = path.join(tmp, 'orders.json');
const order = (id, index, revision = 0) => ({
    id, amount: '0.01', address: `sub_${index}`, index, birthdayHeight: 1000,
    createdAt: 1, status: 'pending', state: 'created', paid: false,
    receivedXmr: 0, shortfallXmr: '0.01', minConfirmations: 1, syncing: false,
    txids: [], revision,
});

try {
    const { loadOrderLedger, saveOrderLedger } = ledger;
    ok('exports durable ledger load/save helpers', typeof loadOrderLedger === 'function' && typeof saveOrderLedger === 'function');
    if (typeof loadOrderLedger !== 'function' || typeof saveOrderLedger !== 'function') throw new Error('ledger helpers unavailable');

    const fresh = loadOrderLedger(file);
    ok('missing primary and backup starts a fresh empty ledger', fresh.store instanceof Map && fresh.store.size === 0 && fresh.usedSubaddressHighWater === 0 && fresh.generation === 0);

    fresh.store.set('a', order('a', 7));
    fresh.usedSubaddressHighWater = 12;
    saveOrderLedger(file, fresh);
    ok('save advances the durable generation', fresh.generation === 1);
    ok('save creates a primary and recovery copy', fs.existsSync(file) && fs.existsSync(file + '.bak'));

    const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
    ok('new ledger envelope persists metadata and order revision', disk.version === 1 && disk.generation === 1 && disk.usedSubaddressHighWater === 12 && disk.orders[0].revision === 0);

    const loaded = loadOrderLedger(file);
    ok('valid envelope reloads orders and high-water mark', loaded.store.get('a').index === 7 && loaded.usedSubaddressHighWater === 12 && loaded.generation === 1);

    // A power loss may leave one atomic copy newer than the other. Recovery must
    // select the valid highest generation, not blindly prefer a stale primary.
    const newer = { version: 1, generation: 2, usedSubaddressHighWater: 13, orders: [order('a', 7), order('b', 13)] };
    fs.writeFileSync(file + '.bak', JSON.stringify(newer));
    const recoveredNewer = loadOrderLedger(file);
    ok('recovery selects the newest valid generation', recoveredNewer.generation === 2 && recoveredNewer.store.has('b') && recoveredNewer.usedSubaddressHighWater === 13 && recoveredNewer.recoveredFromBackup === true);

    fs.writeFileSync(file, '{truncated');
    const recovered = loadOrderLedger(file);
    ok('corrupt primary recovers from a valid backup without losing state', recovered.store.has('b') && recovered.usedSubaddressHighWater === 13 && recovered.recoveredFromBackup === true);

    fs.writeFileSync(file + '.bak', '{also-truncated');
    let corruptThrew = false;
    try { loadOrderLedger(file); } catch (error) { corruptThrew = /ledger/i.test(error.message); }
    ok('corrupt existing primary plus backup fails closed', corruptThrew);

    // Legacy releases stored a bare array. It remains loadable, receives safe
    // revision defaults, and derives the historic high-water mark from indices.
    const legacyFile = path.join(tmp, 'legacy.json');
    const legacy = order('legacy', 22); delete legacy.revision; delete legacy.minConfirmations; delete legacy.syncing;
    fs.writeFileSync(legacyFile, JSON.stringify([legacy]));
    const legacyLoaded = loadOrderLedger(legacyFile);
    ok('valid legacy array ledger loads safely', legacyLoaded.store.get('legacy').revision === 0 && legacyLoaded.usedSubaddressHighWater === 22 && legacyLoaded.legacy === true);

    const badFile = path.join(tmp, 'bad.json');
    fs.writeFileSync(badFile, JSON.stringify({ version: 1, generation: 1, usedSubaddressHighWater: 5, orders: [order('x', 5, -1)] }));
    let invalidThrew = false;
    try { loadOrderLedger(badFile); } catch { invalidThrew = true; }
    ok('invalid order revision is rejected during load', invalidThrew);

    const policyFile = path.join(tmp, 'bad-policy.json');
    fs.writeFileSync(policyFile, JSON.stringify({ version: 1, generation: 1, usedSubaddressHighWater: 6, orders: [{ ...order('p', 6), minConfirmations: -1, syncing: 'no' }] }));
    let policyThrew = false;
    try { loadOrderLedger(policyFile); } catch { policyThrew = true; }
    ok('invalid persisted confirmation/syncing policy is rejected during load', policyThrew);

    const dupFile = path.join(tmp, 'duplicate.json');
    fs.writeFileSync(dupFile, JSON.stringify({ version: 1, generation: 1, usedSubaddressHighWater: 5, orders: [order('x', 4), order('x', 5)] }));
    let duplicateThrew = false;
    try { loadOrderLedger(dupFile); } catch { duplicateThrew = true; }
    ok('duplicate order ids are rejected during load', duplicateThrew);

    const impossible = path.join(tmp, 'not-a-directory');
    fs.writeFileSync(impossible, 'file');
    let saveThrew = false;
    try { saveOrderLedger(path.join(impossible, 'orders.json'), fresh); } catch { saveThrew = true; }
    ok('persistence errors propagate to the caller', saveThrew);
} catch (error) {
    ok('ledger test setup completed', false, error.message);
} finally {
    fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? 'ALL GREEN' : 'FAILED'}  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
