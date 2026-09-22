// Deliver signed payment notifications with bounded retries.
const crypto = require('crypto');

function signPayload(body, secret) {
    return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

function verifySignature(body, secret, header) {
    const expected = signPayload(body, secret);
    const a = Buffer.from(expected), b = Buffer.from(String(header || ''));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function sendWebhook(url, payload, { secret = null, attempts = 3, timeoutMs = 8000 } = {}) {

    const stamped = (payload && payload.event_ts != null) ? payload : { ...payload, event_ts: Date.now() };
    const body = JSON.stringify(stamped);
    const headers = { 'Content-Type': 'application/json' };
    if (secret) headers['X-XMR-Pay-Signature'] = signPayload(body, secret);
    let last = { delivered: false };
    for (let i = 1; i <= attempts; i++) {
        try {
            const r = await fetch(url, { method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
            if (r.ok) return { delivered: true, status: r.status, attempt: i };
            last = { delivered: false, status: r.status, attempt: i };
        } catch (e) {
            last = { delivered: false, error: e.message, attempt: i };
        }
        if (i < attempts) await new Promise(s => setTimeout(s, 500 * 2 ** (i - 1)));
    }
    return last;
}

module.exports = { sendWebhook, signPayload, verifySignature };
