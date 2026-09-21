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
    console.log('widget output escaping and receipt URL validation passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
