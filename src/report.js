'use strict';
/*
 * Order -> CSV: a shared reporting column schema, so any CSV export (the WooCommerce plugin's
 * admin export today, an agent endpoint if one is added later) can speak the same columns. Pure,
 * zero-dependency. The plugin adds a few WC-specific columns (wc_status, mode, refund_status) on
 * top of these CORE columns. NOTE: the agent ships no /orders.csv route yet — this is the helper.
 */

// the core columns every transport can produce from an order record.
const CORE_COLUMNS = ['order', 'date', 'state', 'owed_xmr', 'received_xmr', 'overpaid_xmr', 'confirmations', 'txids'];

// neutralise spreadsheet formula injection: a leading =,+,-,@,tab,CR becomes text. Mirror of
// XmrPay_Report::csv_safe in the plugin.
function csvSafe(v) {
    const s = v == null ? '' : String(v);
    return (s.length && '=+-@\t\r'.indexOf(s[0]) !== -1) ? "'" + s : s;
}

// RFC-4180-ish field: wrap in quotes + double internal quotes when the value needs it.
function csvField(v) {
    const s = csvSafe(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// one agent order -> a row object keyed by CORE_COLUMNS.
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

// orders -> a CSV string (header + one row per order), using CORE_COLUMNS.
function ordersToCsv(orders) {
    const rows = [CORE_COLUMNS.join(',')];
    for (const o of (orders || [])) {
        const r = orderRow(o);
        rows.push(CORE_COLUMNS.map(c => csvField(r[c])).join(','));
    }
    return rows.join('\n') + '\n';
}

module.exports = { CORE_COLUMNS, csvSafe, csvField, orderRow, ordersToCsv };
