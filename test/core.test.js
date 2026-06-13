// client-side primitives: amount nonces, payment URIs, QR. offline, no network.
//   node test/core.test.js   (zero deps — qrcode-generator is vendored)

const core = require('../src/core');
const { xmrToPico } = require('../src/verify');

const MAIN = '4' + '1'.repeat(94);
const SUB = '8' + '1'.repeat(94);          // mainnet subaddress shape
const STAGE = '5' + '1'.repeat(94);

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { (c ? pass++ : fail++); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`); };

// ── makeAmountNonce ─────────────────────────────────────────────────────────
const a1 = core.makeAmountNonce('0.05');
const a2 = core.makeAmountNonce('0.05');
ok('nonce is a string', typeof a1 === 'string');
ok('two nonces differ', a1 !== a2);
ok('nonce >= base', xmrToPico(a1) >= xmrToPico('0.05'));
ok('default nonce (digits=6) adds 1..999999 pico', (() => { const d = xmrToPico(a1) - xmrToPico('0.05'); return d >= 1n && d <= 999999n; })());
ok('digits=4 caps the nonce at 9999 pico', (() => { const d = xmrToPico(core.makeAmountNonce('0.05', { digits: 4 })) - xmrToPico('0.05'); return d >= 1n && d <= 9999n; })());
ok('nonce digits=2 stays small', (() => { const d = xmrToPico(core.makeAmountNonce('1', { digits: 2 })) - xmrToPico('1'); return d >= 1n && d <= 99n; })());
// 1000 default nonces (10^6 space) collide only ~0.5 times on average — effectively unique
ok('1000 default nonces are effectively unique', (() => { const s = new Set(); for (let i = 0; i < 1000; i++) s.add(core.makeAmountNonce('0.05')); return s.size >= 997; })());
try { core.makeAmountNonce('0.05', { digits: 9 }); ok('rejects digits > 6', false); } catch { ok('rejects digits > 6', true); }

// ── makePaymentURI ──────────────────────────────────────────────────────────
ok('uri for a primary address', core.makePaymentURI({ address: MAIN }) === 'monero:' + MAIN);
ok('uri for a subaddress', core.makePaymentURI({ address: SUB, amount: '0.05' }) === 'monero:' + SUB + '?tx_amount=0.05');
ok('amount nonce survives into the uri', core.makePaymentURI({ address: MAIN, amount: '0.050000000817' }).includes('tx_amount=0.050000000817'));
ok('recipient + description are uri-encoded', (() => { const u = core.makePaymentURI({ address: MAIN, recipientName: 'A B', description: 'café #1' }); return u.includes('recipient_name=A%20B') && u.includes('tx_description=caf%C3%A9%20%231'); })());
ok('amount-less uri (tips) has no query', core.makePaymentURI({ address: MAIN }).indexOf('?') === -1);
try { core.makePaymentURI({ address: 'nope' }); ok('rejects bad address', false); } catch { ok('rejects bad address', true); }
try { core.makePaymentURI({ address: MAIN, networkType: 'stagenet' }); ok('rejects wrong-network address', false); } catch { ok('rejects mainnet addr under stagenet networkType', true); }
ok('accepts a stagenet address under stagenet', core.makePaymentURI({ address: STAGE, networkType: 'stagenet' }).startsWith('monero:5'));

// ── qrSvg ───────────────────────────────────────────────────────────────────
const svg = core.qrSvg('monero:' + MAIN + '?tx_amount=0.05');
ok('qrSvg returns an svg', svg.startsWith('<svg') && svg.endsWith('</svg>'));
ok('qrSvg has modules', (svg.match(/<rect/g) || []).length > 50);
ok('qrSvg is labelled for screen readers', svg.includes('aria-label'));

// ── picoToXmrString round-trip ──────────────────────────────────────────────
ok('pico → string → pico round-trips', core.picoToXmrString(50000000817n) === '0.050000000817' && xmrToPico('0.050000000817') === 50000000817n);
ok('whole-XMR pico string', core.picoToXmrString(5000000000000n) === '5');
ok('zero', core.picoToXmrString(0n) === '0');

console.log(`\n${fail === 0 ? 'ALL GREEN' : 'FAILED'}  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
