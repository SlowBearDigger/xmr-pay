'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('default agent secrets and durable state are ignored by git', () => {
    const lines = fs.readFileSync(path.join(__dirname, '../.gitignore'), 'utf8')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'));

    for (const pattern of ['xmr-pay-data/', '*.keys', '*.pem', 'orders.json', 'orders.json.bak']) {
        assert.ok(lines.includes(pattern), `${pattern} must be ignored`);
    }
});
