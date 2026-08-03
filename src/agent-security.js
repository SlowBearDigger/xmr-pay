'use strict';

function isLoopbackBind(bind) {
    const host = String(bind || '').trim().toLowerCase();
    if (host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
    const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (!ipv4) return false;
    const octets = ipv4.slice(1).map(Number);
    return octets.every(octet => octet >= 0 && octet <= 255) && octets[0] === 127;
}

function assertAgentExposurePolicy({ bind, token } = {}) {
    if (!String(token || '').trim() && !isLoopbackBind(bind)) {
        throw new Error('AGENT_TOKEN is required when BIND is non-loopback');
    }
}

module.exports = { assertAgentExposurePolicy, isLoopbackBind };
