// signed merchant config.
//
// the payment address shown to a buyer is only as trustworthy as the page that
// renders it. if a merchant's site is compromised, an attacker can swap the
// address and steal payments. signing fixes the part that matters: the signing
// key lives OFF the web server (offline, or a separate box), so a server
// breach can serve the real signed config or a broken one — it cannot mint a
// new one pointing at the attacker's address.
//
// the widget verifies the signature and shows the signer fingerprint. a buyer
// who knows the merchant's fingerprint out of band (a label on the product, a
// pinned value, a directory entry) catches a swap even on a fully owned page.
// without that out-of-band anchor, signing still gives tamper-evidence: a
// "signed" config that no longer verifies is a loud red flag.
//
// Ed25519, so the same keys work in node (crypto) and the browser (WebCrypto).

const crypto = require('crypto');

// deterministic JSON: keys sorted at every level, no whitespace. both signer
// and verifier must hash the exact same bytes.
function canonical(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
    return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}

function generateSigningKey() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return {
        privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
        publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
    };
}

// short, human-checkable id for a public key — the thing a buyer compares
// against a known value. 96 bits / six groups of four hex, e.g.
// a1b2-c3d4-e5f6-7890-1234-5678. forging a key whose fingerprint matches a
// published one is a targeted preimage: 96 bits puts that out of reach, while
// six short groups still fit on a label or a screen for a human to eyeball.
function configFingerprint(publicKeyPem) {
    const der = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
    const h = crypto.createHash('sha256').update(der).digest('hex');
    return h.slice(0, 24).match(/.{4}/g).join('-');
}

// sign a config object. only put fields that decide where money goes or how
// much (address, amount, networkType) inside `config` — that is what the
// signature protects. returns a self-contained envelope safe to embed or host.
function signConfig(config, privateKeyPem) {
    const key = crypto.createPrivateKey(privateKeyPem);
    const sig = crypto.sign(null, Buffer.from(canonical(config)), key);
    const publicKey = crypto.createPublicKey(key).export({ type: 'spki', format: 'pem' });
    return {
        v: 1,
        alg: 'ed25519',
        config,
        pubkey: publicKey,
        fingerprint: configFingerprint(publicKey),
        sig: sig.toString('base64'),
    };
}

// verify an envelope. pass `expectedFingerprint` (or `expectedPubkey`) to pin a
// known signer — without a pin you only learn "internally consistent", which is
// tamper-evidence, not identity. returns { valid, reason, config, fingerprint }.
function verifyConfig(envelope, { expectedFingerprint = null, expectedPubkey = null } = {}) {
    if (!envelope || typeof envelope !== 'object' || !envelope.config || !envelope.sig || !envelope.pubkey) {
        return { valid: false, reason: 'not a signed config', config: null, fingerprint: null };
    }
    let pub, ok;
    try {
        pub = crypto.createPublicKey(envelope.pubkey);
        ok = crypto.verify(null, Buffer.from(canonical(envelope.config)), pub, Buffer.from(envelope.sig, 'base64'));
    } catch {
        return { valid: false, reason: 'bad key or signature encoding', config: null, fingerprint: null };
    }
    const fingerprint = configFingerprint(envelope.pubkey);
    if (!ok) return { valid: false, reason: 'signature does not match config', config: null, fingerprint };
    if (expectedPubkey) {
        const a = crypto.createPublicKey(expectedPubkey).export({ type: 'spki', format: 'der' });
        const b = pub.export({ type: 'spki', format: 'der' });
        if (!a.equals(b)) return { valid: false, reason: 'signed by a different key than pinned', config: null, fingerprint };
    }
    if (expectedFingerprint && expectedFingerprint.replace(/[^a-f0-9]/gi, '') !== fingerprint.replace(/-/g, '')) {
        return { valid: false, reason: 'fingerprint does not match the pinned one', config: null, fingerprint };
    }
    return { valid: true, reason: 'ok', config: envelope.config, fingerprint };
}

module.exports = { signConfig, verifyConfig, configFingerprint, generateSigningKey, canonical };
