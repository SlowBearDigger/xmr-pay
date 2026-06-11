// signed config — offline, deterministic.
//   node test/config.test.js

const { signConfig, verifyConfig, configFingerprint, generateSigningKey } = require('../src/config');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };

const merchant = generateSigningKey();
const attacker = generateSigningKey();
const cfg = { address: '4' + 'A'.repeat(94), amount: '0.05', networkType: 'mainnet' };

const env = signConfig(cfg, merchant.privateKey);
ok('signs and round-trips', verifyConfig(env).valid);
ok('fingerprint is stable + readable', /^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/.test(env.fingerprint), env.fingerprint);
ok('fingerprint matches the key', env.fingerprint === configFingerprint(merchant.publicKey));

// tamper the address after signing
const swapped = JSON.parse(JSON.stringify(env));
swapped.config.address = '4' + 'B'.repeat(94);
ok('swapped address fails', !verifyConfig(swapped).valid, verifyConfig(swapped).reason);

// attacker re-signs their own address with their own key
const forged = signConfig({ ...cfg, address: '4' + 'B'.repeat(94) }, attacker.privateKey);
ok('forged-but-valid passes WITHOUT a pin (tamper-evidence only)', verifyConfig(forged).valid);
ok('forged rejected WHEN pinned to merchant fingerprint',
    !verifyConfig(forged, { expectedFingerprint: env.fingerprint }).valid,
    verifyConfig(forged, { expectedFingerprint: env.fingerprint }).reason);
ok('forged rejected WHEN pinned to merchant pubkey',
    !verifyConfig(forged, { expectedPubkey: merchant.publicKey }).valid);

// genuine config still passes the pin
ok('genuine config passes the merchant pin', verifyConfig(env, { expectedFingerprint: env.fingerprint }).valid);

// key-order independence (canonical)
const reordered = signConfig({ networkType: 'mainnet', amount: '0.05', address: cfg.address }, merchant.privateKey);
ok('canonical: field order does not change the signature bytes', reordered.sig === env.sig);

// junk
ok('non-envelope rejected', !verifyConfig({ nope: 1 }).valid);

console.log(`\n${fail === 0 ? 'ALL GREEN' : 'FAILED'}  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
