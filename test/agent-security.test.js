'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { assertAgentExposurePolicy } = require('../src/agent-security');

test('an unauthenticated agent may bind only to loopback', () => {
    for (const bind of ['127.0.0.1', '127.12.34.56', '::1', '0:0:0:0:0:0:0:1', 'localhost']) {
        assert.doesNotThrow(() => assertAgentExposurePolicy({ bind, token: '' }), bind);
    }
    for (const bind of ['0.0.0.0', '::', '192.168.1.20', 'agent.internal']) {
        assert.throws(
            () => assertAgentExposurePolicy({ bind, token: '' }),
            /AGENT_TOKEN.*non-loopback/i,
            bind,
        );
        assert.throws(
            () => assertAgentExposurePolicy({ bind, token: '   ' }),
            /AGENT_TOKEN.*non-loopback/i,
            `${bind} blank token`,
        );
    }
});

test('a non-loopback bind remains available when bearer authentication is configured', () => {
    assert.doesNotThrow(() => assertAgentExposurePolicy({ bind: '0.0.0.0', token: 'long-random-token' }));
});
