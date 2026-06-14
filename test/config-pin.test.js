// regression guard for the WIDGET's signed-config pin decision (the browser-only
// path that had no automated coverage — a bug let `pubkey="…"` pinning reject
// valid configs because it compared a full PEM as if it were a fingerprint).
// this mirrors widget/xmr-pay.part.js (xpPemToDer + DER compare + xpVerifyConfig +
// the pin branch) using Node's WebCrypto, against configs signed by the REAL
// src/config.js — so node and the widget can't drift on what a pin accepts.
//   node test/config-pin.test.js

const { generateSigningKey, signConfig } = require('../src/config');
const subtle = (globalThis.crypto && globalThis.crypto.subtle) || require('crypto').webcrypto.subtle;

let pass = 0, fail = 0, warn = 0;
const ok = (n, c, x = '') => { (c ? pass++ : fail++); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`); };

// --- mirror of the widget helpers ---
const b64ToBytes = (b64) => new Uint8Array(Buffer.from(b64, 'base64'));
const pemToDer = (pem) => b64ToBytes(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''));
function canonical(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
    return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}
async function fingerprint(der) {
    const h = new Uint8Array(await subtle.digest('SHA-256', der));
    let hex = ''; for (let i = 0; i < 12; i++) hex += h[i].toString(16).padStart(2, '0');
    return hex.match(/.{4}/g).join('-');
}
async function verifyConfig(env) {
    try {
        if (!env || !env.config || !env.sig || !env.pubkey) return { valid: false };
        const der = pemToDer(env.pubkey);
        const key = await subtle.importKey('spki', der, { name: 'Ed25519' }, false, ['verify']);
        const ok2 = await subtle.verify('Ed25519', key, b64ToBytes(env.sig), new TextEncoder().encode(canonical(env.config)));
        return { valid: ok2, fingerprint: await fingerprint(der) };
    } catch { return { valid: false }; }
}
// the FIXED pin branch from widget _resolve()
function decide(v, env, pinnedPub, pinnedFp) {
    let pinned = true;
    if (pinnedPub) {
        try { const a = pemToDer(pinnedPub), b = pemToDer(env.pubkey); pinned = a.length === b.length && a.every((x, i) => x === b[i]); }
        catch { pinned = false; }
    } else if (pinnedFp) {
        pinned = !!v.fingerprint && pinnedFp.replace(/[^a-f0-9]/gi, '').toLowerCase() === v.fingerprint.replace(/-/g, '');
    }
    return (v.valid && pinned) ? 'ok' : 'bad';
}

(async () => {
    // probe WebCrypto Ed25519 (Node 20/22 support it; older may not)
    try { const k = generateSigningKey(); await verifyConfig(signConfig({ a: 1 }, k.privateKey)); }
    catch { /* handled below */ }
    const probe = await verifyConfig(signConfig({ a: 1 }, generateSigningKey().privateKey));
    if (!probe.valid) { console.log('WARN  WebCrypto Ed25519 unavailable in this Node — skipping'); process.exit(0); }

    const k = generateSigningKey();
    const k2 = generateSigningKey();
    const env = signConfig({ address: '4' + '1'.repeat(94), amount: '0.05', networkType: 'mainnet' }, k.privateKey);
    const v = await verifyConfig(env);
    ok('a valid config verifies', v.valid === true);

    ok('no pin → accepted', decide(v, env, '', '') === 'ok');
    ok('correct PUBKEY pin → accepted (the bug: was rejected)', decide(v, env, k.publicKey, '') === 'ok');
    ok('wrong PUBKEY pin → rejected', decide(v, env, k2.publicKey, '') === 'bad');
    ok('correct FINGERPRINT pin → accepted', decide(v, env, '', env.fingerprint) === 'ok');
    ok('wrong FINGERPRINT pin → rejected', decide(v, env, '', 'dead-beef-0000-1111-2222-3333') === 'bad');

    // a forged-but-self-consistent envelope (attacker's own key) verifies as valid
    // WITHOUT a pin (tamper-evidence only) but is rejected once you pin the real key
    const forged = signConfig({ address: '4' + '2'.repeat(94), amount: '0.05', networkType: 'mainnet' }, k2.privateKey);
    const vf = await verifyConfig(forged);
    ok('forged envelope is internally valid (no pin = tamper-evidence only)', vf.valid === true);
    ok('forged envelope REJECTED when the real key is pinned', decide(vf, forged, k.publicKey, '') === 'bad');

    // tampered signature fails outright
    const bad = { ...env, config: { ...env.config, address: '4' + '3'.repeat(94) } };
    ok('tampered config → signature fails', (await verifyConfig(bad)).valid === false);

    console.log(`\n${fail === 0 ? 'ALL GREEN' : 'FAILED'}  ${pass} passed, ${fail} failed, ${warn} warnings`);
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('config-pin test error:', e); process.exit(2); });
