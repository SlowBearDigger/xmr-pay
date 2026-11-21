'use strict';

// Exercise the release tools with real npm archives and disposable OpenSSH keys.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repository = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xmrpay-release-test-'));
const fixture = path.join(directory, 'source');
const environment = { ...process.env };
delete environment.XMRPAY_SIGNING_KEY;

function command(program, args, expectedSuccess = true, extraEnvironment = {}) {
  const result = spawnSync(program, args, {
    cwd: fixture,
    env: { ...environment, ...extraEnvironment },
    encoding: 'utf8'
  });
  assert.ifError(result.error);
  if (expectedSuccess) {
    assert.equal(result.status, 0, `${program} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  } else {
    assert.notEqual(result.status, 0, `${program} unexpectedly succeeded`);
  }
  return result;
}

function copy(relative) {
  const target = path.join(fixture, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(repository, relative), target);
}

function sign(output, key, namespace = 'releases@xmrpay.shop') {
  fs.rmSync(path.join(output, 'SHA256SUMS.sig'), { force: true });
  command('ssh-keygen', ['-Y', 'sign', '-f', key, '-n', namespace, path.join(output, 'SHA256SUMS')]);
}

try {
  assert.ok(fs.existsSync(path.join(repository, 'scripts/verify-release.sh')), 'the reusable release verifier must exist');
  fs.mkdirSync(fixture);
  fs.mkdirSync(path.join(fixture, 'hosted'));
  for (const relative of [
    'scripts/release.sh', 'scripts/verify-release.sh', 'scripts/build-widget.sh',
    'src/vendor/qrcode-generator.js', 'widget/xmr-pay.part.js'
  ]) copy(relative);
  fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({
    name: 'xmr-pay', version: '2.0.0', license: 'MIT',
    files: ['src', 'widget', 'scripts/verify-release.sh', '.github/release.allowed_signers']
  }) + '\n');
  fs.writeFileSync(path.join(fixture, 'LICENSE'), 'Release tool test fixture.\n');

  const key = path.join(directory, 'signing-key');
  const wrongKey = path.join(directory, 'wrong-key');
  for (const keyPath of [key, wrongKey]) command('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath]);
  fs.mkdirSync(path.join(fixture, '.github'));
  const publicKey = fs.readFileSync(`${key}.pub`, 'utf8').trim().split(/\s+/).slice(0, 2).join(' ');
  fs.writeFileSync(path.join(fixture, '.github/release.allowed_signers'), `xmrpay-release namespaces="releases@xmrpay.shop" ${publicKey}\n`);

  const unsigned = path.join(directory, 'unsigned');
  const missing = command('bash', ['scripts/release.sh', unsigned], false);
  assert.match(missing.stderr, /XMRPAY_SIGNING_KEY/);
  assert.equal(fs.existsSync(unsigned), false, 'missing keys must fail before creating artifacts');

  const first = path.join(directory, 'first');
  const second = path.join(directory, 'second');
  command('bash', ['scripts/release.sh', '--prepare', first]);
  command('bash', ['scripts/release.sh', '--prepare', second]);
  for (const file of ['SHA256SUMS', 'xmr-pay.js', 'xmr-pay-2.0.0.tgz']) {
    assert.deepEqual(fs.readFileSync(path.join(first, file)), fs.readFileSync(path.join(second, file)), `${file} must reproduce exactly`);
  }
  assert.equal(fs.existsSync(path.join(first, 'SHA256SUMS.sig')), false);
  command('bash', ['scripts/verify-release.sh', first], false);

  const signed = path.join(directory, 'signed');
  command('bash', ['scripts/release.sh', signed], true, { XMRPAY_SIGNING_KEY: key });
  command('bash', ['scripts/verify-release.sh', signed]);
  const originalManifest = fs.readFileSync(path.join(signed, 'SHA256SUMS'));
  const widget = path.join(signed, 'xmr-pay.js');
  fs.appendFileSync(widget, '\n// tampered\n');
  command('bash', ['scripts/verify-release.sh', signed], false);
  fs.copyFileSync(path.join(first, 'xmr-pay.js'), widget);

  sign(signed, wrongKey);
  command('bash', ['scripts/verify-release.sh', signed], false);
  sign(signed, key, 'unrelated-release');
  command('bash', ['scripts/verify-release.sh', signed], false);
  sign(signed, key);
  command('bash', ['scripts/verify-release.sh', signed]);

  fs.appendFileSync(path.join(signed, 'SHA256SUMS'), `${'0'.repeat(64)}  ../unexpected-file\n`);
  sign(signed, key);
  const extraEntry = command('bash', ['scripts/verify-release.sh', signed], false);
  assert.match(extraEntry.stderr, /exactly|manifest/i);
  fs.writeFileSync(path.join(signed, 'SHA256SUMS'), originalManifest.toString().replace('xmr-pay-2.0.0.tgz', '../unexpected-file'));
  sign(signed, key);
  const wrongName = command('bash', ['scripts/verify-release.sh', signed], false);
  assert.match(wrongName.stderr, /exactly|manifest/i);
  fs.writeFileSync(path.join(signed, 'SHA256SUMS'), originalManifest);
  sign(signed, key);
  fs.appendFileSync(path.join(signed, 'xmr-pay-2.0.0.tgz'), 'tampered');
  command('bash', ['scripts/verify-release.sh', signed], false);

  command('bash', ['scripts/release.sh', '--prepare', first], false);
  console.log('release tools: reproducible preparation, real SSH signing/verification, missing/wrong keys, namespace separation, altered files, manifest paths and overwrite protection passed');
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
