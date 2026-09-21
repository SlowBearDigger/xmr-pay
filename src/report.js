// Summarize recorded payments and refunds.
'use strict';

const CORE_COLUMNS = ['order', 'date', 'state', 'owed_xmr', 'received_xmr', 'overpaid_xmr', 'confirmations', 'txids'];

function csvSafe(v) {
    const s = v == null ? '' : String(v);
    return (s.length && '=+-@\t\r'.indexOf(s[0]) !== -1) ? "'" + s : s;
}

function csvField(v) {
    const s = csvSafe(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function orderRow(o) {
    o = o || {};
    return {
        order: o.id != null ? String(o.id) : '',
        date: o.createdAt ? new Date(o.createdAt).toISOString() : '',
        state: o.state || '',
        owed_xmr: o.amount != null ? String(o.amount) : '',
        received_xmr: o.receivedXmr != null ? String(o.receivedXmr) : '0',
        overpaid_xmr: o.overpaid ? String(o.overpaidXmr != null ? o.overpaidXmr : '0') : '',
        confirmations: o.confirmations != null ? String(o.confirmations) : '',
        txids: Array.isArray(o.txids) ? o.txids.join(' ') : (o.txids || ''),
    };
}

function ordersToCsv(orders) {
    const rows = [CORE_COLUMNS.join(',')];
    for (const o of (orders || [])) {
        const r = orderRow(o);
        rows.push(CORE_COLUMNS.map(c => csvField(r[c])).join(','));
    }
    return rows.join('\n') + '\n';
}

module.exports = { CORE_COLUMNS, csvSafe, csvField, orderRow, ordersToCsv };
