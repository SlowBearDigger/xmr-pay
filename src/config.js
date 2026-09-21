// Sign and verify merchant checkout configurations.
const crypto = require('crypto');

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

function configFingerprint(publicKeyPem) {
    const der = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
    const h = crypto.createHash('sha256').update(der).digest('hex');
    return h.slice(0, 24).match(/.{4}/g).join('-');
}

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
