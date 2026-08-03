'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { xmrToPico } = require('./verify');

const VERSION = 1;

function integer(value) {
    return Number.isSafeInteger(value) && value >= 0;
}

function validateOrder(value, { legacy = false } = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('order must be an object');
    if (typeof value.id !== 'string' || value.id.length === 0) throw new Error('order id must be a non-empty string');
    if (!integer(value.index)) throw new Error(`order ${value.id} has an invalid subaddress index`);
    if (typeof value.address !== 'string' || value.address.length === 0) throw new Error(`order ${value.id} has an invalid address`);
    try { if (xmrToPico(value.amount) <= 0n) throw new Error('nonpositive'); }
    catch { throw new Error(`order ${value.id} has an invalid amount`); }
    if (typeof value.paid !== 'boolean') throw new Error(`order ${value.id} has an invalid paid flag`);
    if (typeof value.status !== 'string' || value.status.length === 0) throw new Error(`order ${value.id} has an invalid status`);
    if (!Array.isArray(value.txids) || value.txids.some(txid => typeof txid !== 'string')) throw new Error(`order ${value.id} has invalid txids`);
    const revision = value.revision == null && legacy ? 0 : value.revision;
    if (!integer(revision)) throw new Error(`order ${value.id} has an invalid revision`);
    if ((!legacy || value.minConfirmations != null) && !integer(value.minConfirmations)) throw new Error(`order ${value.id} has invalid minConfirmations`);
    if ((!legacy || value.syncing != null) && typeof value.syncing !== 'boolean') throw new Error(`order ${value.id} has an invalid syncing flag`);
    return { ...value, revision };
}

function parseLedger(raw, source) {
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (error) { throw new Error(`${source} is not valid JSON: ${error.message}`); }

    const legacy = Array.isArray(parsed);
    let orders, generation, usedSubaddressHighWater;
    if (legacy) {
        orders = parsed;
        generation = 0;
        usedSubaddressHighWater = null;
    } else {
        if (!parsed || typeof parsed !== 'object' || parsed.version !== VERSION) throw new Error(`${source} has an unsupported ledger version`);
        if (!integer(parsed.generation)) throw new Error(`${source} has an invalid generation`);
        if (!integer(parsed.usedSubaddressHighWater)) throw new Error(`${source} has an invalid used-subaddress high-water mark`);
        if (!Array.isArray(parsed.orders)) throw new Error(`${source} orders must be an array`);
        orders = parsed.orders;
        generation = parsed.generation;
        usedSubaddressHighWater = parsed.usedSubaddressHighWater;
    }

    const store = new Map();
    let maxIndex = 0;
    for (const rawOrder of orders) {
        const order = validateOrder(rawOrder, { legacy });
        if (store.has(order.id)) throw new Error(`${source} contains duplicate order id ${order.id}`);
        store.set(order.id, order);
        maxIndex = Math.max(maxIndex, order.index);
    }
    if (legacy) usedSubaddressHighWater = maxIndex;
    else if (usedSubaddressHighWater < maxIndex) throw new Error(`${source} high-water mark is below a stored order index`);
    return { store, generation, usedSubaddressHighWater, legacy };
}

function readCandidate(file, kind) {
    if (!fs.existsSync(file)) return { exists: false, kind, file };
    try { return { exists: true, valid: true, kind, file, ...parseLedger(fs.readFileSync(file, 'utf8'), kind) }; }
    catch (error) { return { exists: true, valid: false, kind, file, error }; }
}

function loadOrderLedger(file) {
    const primary = readCandidate(file, 'primary order ledger');
    const backup = readCandidate(file + '.bak', 'backup order ledger');
    if (!primary.exists && !backup.exists) {
        return { store: new Map(), generation: 0, usedSubaddressHighWater: 0, legacy: false, recoveredFromBackup: false };
    }
    const valid = [primary, backup].filter(candidate => candidate.valid);
    if (valid.length === 0) {
        const reasons = [primary, backup].filter(candidate => candidate.exists).map(candidate => candidate.error.message).join('; ');
        throw new Error(`order ledger recovery failed: ${reasons}`);
    }
    valid.sort((a, b) => b.generation - a.generation || (a.kind.startsWith('primary') ? -1 : 1));
    const selected = valid[0];
    return {
        store: selected.store,
        generation: selected.generation,
        usedSubaddressHighWater: selected.usedSubaddressHighWater,
        legacy: selected.legacy,
        recoveredFromBackup: selected.kind.startsWith('backup'),
    };
}

function syncDirectory(directory) {
    let fd;
    try {
        fd = fs.openSync(directory, 'r');
        fs.fsyncSync(fd);
    } catch (error) {
        // Directory fsync is unavailable on some platforms/filesystems. File
        // fsync plus atomic rename still provides the strongest portable path.
        if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM'].includes(error.code)) throw error;
    } finally {
        if (fd != null) fs.closeSync(fd);
    }
}

function atomicReplace(file, bytes) {
    const directory = path.dirname(file);
    const temp = path.join(directory, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
    let fd;
    try {
        fd = fs.openSync(temp, 'wx', 0o600);
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
        fs.closeSync(fd); fd = null;
        fs.renameSync(temp, file);
        syncDirectory(directory);
    } catch (error) {
        if (fd != null) { try { fs.closeSync(fd); } catch { /* best effort */ } }
        try { fs.unlinkSync(temp); } catch { /* absent or already renamed */ }
        throw error;
    }
}

function saveOrderLedger(file, state) {
    if (!state || !(state.store instanceof Map)) throw new Error('order ledger state requires a Map store');
    if (!integer(state.generation)) throw new Error('order ledger state has an invalid generation');
    if (!integer(state.usedSubaddressHighWater)) throw new Error('order ledger state has an invalid used-subaddress high-water mark');
    const orders = [...state.store.values()].map(order => validateOrder(order));
    const maxIndex = orders.reduce((max, order) => Math.max(max, order.index), 0);
    if (state.usedSubaddressHighWater < maxIndex) throw new Error('used-subaddress high-water mark is below a stored order index');

    const generation = state.generation + 1;
    const envelope = { version: VERSION, generation, usedSubaddressHighWater: state.usedSubaddressHighWater, orders };
    const bytes = JSON.stringify(envelope) + '\n';
    const directory = path.dirname(file);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

    // Write the recovery copy first. If power fails between the two renames, the
    // loader selects the valid copy with the highest generation.
    atomicReplace(file + '.bak', bytes);
    atomicReplace(file, bytes);
    state.generation = generation;
    state.legacy = false;
    state.recoveredFromBackup = false;
    return state;
}

module.exports = { VERSION, loadOrderLedger, saveOrderLedger };
