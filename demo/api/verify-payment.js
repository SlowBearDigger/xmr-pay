// Handle the demonstration payment verification request.
const { handleVerify } = require('../verify-handler');

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
    try {
        const { code, body } = await handleVerify(req.body || {});
        return res.status(code).json(body);
    } catch (e) {
        return res.status(502).json({ error: 'verification failed' });
    }
};
