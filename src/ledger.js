// Persist payment orders with atomic replacement.
const fs = require('fs');
const { randomUUID } = require('node:crypto');

function loadOrders(file) {
    try {
        const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!Array.isArray(rows) || rows.some(row => !row || !['string', 'number'].includes(typeof row.id))) throw new Error('invalid order ledger');
        const orders = new Map(rows.map(row => [row.id, row]));
        if (orders.size !== rows.length) throw new Error('duplicate order in ledger');
        return orders;
    } catch (error) {
        if (error.code === 'ENOENT') return new Map();
        throw error;
    }
}

function saveOrders(file, store) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
        const fd = fs.openSync(temporary, 'wx', 0o600);
        try {
            fs.writeFileSync(fd, JSON.stringify([...store.values()]));
            fs.fsyncSync(fd);
        } finally { fs.closeSync(fd); }
        fs.renameSync(temporary, file);
    } catch (error) {
        try { fs.unlinkSync(temporary); } catch {}
        throw error;
    }
}

module.exports = { loadOrders, saveOrders };
