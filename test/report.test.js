// src/report.js — the shared CSV column schema used by the WooCommerce plugin's export (and any
// future agent endpoint). Pure mapping + CSV-injection defense. Mirrors XmrPay_Report::csv_safe.
//   node test/report.test.js

const { CORE_COLUMNS, csvSafe, csvField, orderRow, ordersToCsv } = require('../src/report');

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { (c ? pass++ : fail++); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`); };

// csvSafe: neutralise spreadsheet formula injection
ok('=SUM neutralised', csvSafe('=SUM(A1)') === "'=SUM(A1)");
ok('+1 neutralised', csvSafe('+1') === "'+1");
ok('-1 neutralised', csvSafe('-1') === "'-1");
ok('@cmd neutralised', csvSafe('@cmd') === "'@cmd");
ok('tab-led neutralised', csvSafe('\tx') === "'\tx");
ok('Monero address untouched', csvSafe('45sEohkyWYx') === '45sEohkyWYx');
ok('empty stays empty', csvSafe('') === '');
ok('null -> empty', csvSafe(null) === '');

// csvField: RFC-4180-ish quoting (on top of csvSafe)
ok('plain value unquoted', csvField('abc') === 'abc');
ok('comma quoted', csvField('a,b') === '"a,b"');
ok('internal quote doubled', csvField('a"b') === '"a""b"');
ok('injection + comma both handled', csvField('=a,b') === '"\'=a,b"');

// orderRow: agent order -> row
const o = { id: 'ord_1', createdAt: 1718900000000, state: 'settled', amount: '0.05', receivedXmr: '0.05', overpaid: true, overpaidXmr: '0.01', confirmations: 3, txids: ['aa', 'bb'] };
const r = orderRow(o);
ok('order id', r.order === 'ord_1');
ok('state', r.state === 'settled');
ok('owed', r.owed_xmr === '0.05');
ok('received', r.received_xmr === '0.05');
ok('overpaid shown when flagged', r.overpaid_xmr === '0.01');
ok('confirmations stringified', r.confirmations === '3');
ok('txids space-joined', r.txids === 'aa bb');
ok('date is ISO from createdAt', r.date === new Date(1718900000000).toISOString());
ok('overpaid blank when not flagged', orderRow({ id: 'x', receivedXmr: '0' }).overpaid_xmr === '');
ok('received defaults to 0', orderRow({ id: 'x' }).received_xmr === '0');
ok('missing id -> empty', orderRow({}).order === '');

// ordersToCsv
const csv = ordersToCsv([o]);
const lines = csv.replace(/\n$/, '').split('\n');
ok('header is CORE_COLUMNS', lines[0] === CORE_COLUMNS.join(','));
ok('one data row per order', lines.length === 2);
ok('data row carries the id', lines[1].startsWith('ord_1,'));
ok('empty list -> header only', ordersToCsv([]).replace(/\n$/, '') === CORE_COLUMNS.join(','));
ok('CORE_COLUMNS shape', CORE_COLUMNS.join(',') === 'order,date,state,owed_xmr,received_xmr,overpaid_xmr,confirmations,txids');

console.log(`\n${fail ? 'FAILED' : 'ALL GREEN'}  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
