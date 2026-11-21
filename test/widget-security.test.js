// Render hostile endpoint values through the production widget.
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
let Widget;
const context = {
    HTMLElement: class {}, CustomEvent: class {}, clearTimeout, URL,
    document: { baseURI: 'https://shop.example/checkout/' },
    customElements: { get() {}, define(name, value) { Widget = value; } },
    fetch: async () => ({ ok: true, json: async () => ({ sig: 'signature', receipt: {} }) }),
    btoa: value => Buffer.from(value, 'binary').toString('base64'), unescape,
};
vm.runInNewContext(fs.readFileSync(require.resolve('../src/vendor/qrcode-generator.js'), 'utf8'), context);
const qrPayloads = [];
const createQr = context.qrcode;
context.qrcode = (...args) => {
    const qr = createQr(...args);
    const addData = qr.addData;
    qr.addData = value => { qrPayloads.push(value); addData(value); };
    return qr;
};
vm.runInNewContext(fs.readFileSync(require.resolve('../widget/xmr-pay.part.js'), 'utf8'), context);
(async () => {
    const widget = new Widget();
    widget.getAttribute = () => '';
    widget.dispatchEvent = () => {};
    const body = {};
    const root = { querySelector: name => name === '.body' ? body : null };
    widget._success(root, { confirmations: '<img src=x onerror=alert(1)>' }, { paidTitle: 'Paid', confs: 'confirmations' });
    assert.ok(!body.innerHTML.includes('<img'));
    assert.ok(body.innerHTML.includes('&lt;img'));
    const box = { innerHTML: '', classList: { remove() {} } };
    const receiptRoot = { querySelector: () => box };
    widget.getAttribute = name => name === 'receipt-url' ? '/receipt' : 'javascript:alert(1)';
    await widget._receipt(receiptRoot, {});
    assert.equal(box.innerHTML, '');
    widget.getAttribute = name => name === 'receipt-url' ? '/receipt' : 'verify.html';
    await widget._receipt(receiptRoot, { receiptDownload: 'Download', receiptVerify: 'Verify' });
    assert.ok(box.innerHTML.includes('https://shop.example/checkout/verify.html#'));

    const payment = new Widget();
    payment._addr = '4'.repeat(95);
    payment._amount = '0.00005';
    payment.getAttribute = name => name === 'label' ? 'Invoice & "quoted"' : '';
    payment.dispatchEvent = () => {};
    const wallet = { href: payment._uri(), getAttribute(name) { return this[name]; }, setAttribute(name, value) { this[name] = value; } };
    const qr = { innerHTML: '' }, price = { textContent: '0.00005 XMR' };
    const topup = { innerHTML: '', className: 'topup hidden' };
    const result = { classList: { add() {} } };
    const nodes = {
        '.sec > .wallet': wallet, '.qrwrap .qr': qr, '.amt': price, '.wst': {}, '.topup': topup,
        '.txid': { value: 'a'.repeat(64) }, '.proof': { value: 'b'.repeat(64) }, '.verify': {}, '.res': result,
    };
    const paymentRoot = { querySelector: selector => nodes[selector] || null };
    const text = { topupMsg: 'Detected {r}: send {s}', topupTitle: 'Top up', openWallet: 'Open wallet', verifyBtn: 'Verify', verifying: 'Verifying', watching: 'Watching' };
    const expected = 'monero:' + payment._addr + '?tx_amount=0.00003&tx_description=Invoice%20%26%20%22quoted%22';
    payment._applyWatch(paymentRoot, { status: 'partial', receivedXmr: '0.00002', shortfallXmr: '0.00003' }, text);
    assert.equal(wallet.href, expected, 'watch wallet link must request only the remaining amount');
    assert.equal(qrPayloads.at(-1), expected, 'watch QR must encode the same remaining amount');
    assert.ok(qr.innerHTML.includes('<svg'));
    assert.equal(price.textContent, '0.00003 XMR');
    assert.equal(payment._amount, '0.00005', 'payment progress must preserve the original configured quote');

    payment._applyWatch(paymentRoot, { status: 'pending' }, text);
    assert.equal(wallet.href, payment._uri(), 'a canonical unpaid result must restore the original amount');
    context.fetch = async () => ({ json: async () => ({ status: 'underpaid', receivedXmr: '0.00002', shortfallXmr: '0.00003' }) });
    await payment._verify(paymentRoot, '/verify', text);
    assert.equal(wallet.href, expected, 'proof and watch must update the primary wallet link consistently');
    assert.equal(qrPayloads.at(-1), expected, 'proof top-up QR must encode the same remaining amount');
    assert.ok(topup.innerHTML.includes('tx_amount=0.00003'));

    for (const amount of ['0.000000000001', '9007199.254740993001']) {
        payment._applyWatch(paymentRoot, { status: 'partial', shortfallXmr: amount }, text);
        assert.equal(new URL(wallet.href).searchParams.get('tx_amount'), amount, 'display updates must preserve exact decimal strings');
        assert.equal(qrPayloads.at(-1), wallet.href);
    }
    const previousUri = wallet.href;
    for (const amount of ['0', '-0.1', '0.0000000000001', '<img src=x onerror=alert(1)>']) {
        payment._applyWatch(paymentRoot, { status: 'partial', shortfallXmr: amount }, text);
        assert.equal(wallet.href, previousUri, 'invalid remaining amounts must not replace valid payment instructions');
    }
    payment._applyWatch(paymentRoot, { reachable: false }, text);
    assert.equal(wallet.href, previousUri, 'a temporary network failure must retain the last valid payment instructions');
    console.log('widget escaping, receipt URLs and exact partial-payment QR instructions passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
