// standalone demo server — serves the page + the verify endpoint from one Node
// process. monero-ts (WASM) runs fine here with no serverless cold-start
// timeout, so this is the reliable way to host the demo: Render / Railway / Fly
// / a small VPS / locally. `npm start`.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { handleVerify } = require('./verify-handler');

const PORT = process.env.PORT || 8780;
const PUB = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };

http.createServer(async (req, res) => {
    const url = req.url.split('?')[0];

    if (req.method === 'POST' && url === '/api/verify-payment') {
        let raw = '';
        req.on('data', c => { raw += c; if (raw.length > 65536) req.destroy(); });
        req.on('end', async () => {
            let body; try { body = JSON.parse(raw); } catch { res.writeHead(400); return res.end('{"error":"bad json"}'); }
            try {
                const { code, body: out } = await handleVerify(body);
                console.log(`[verify] ${body.order_id} → ${out.status || out.error} (${out.confirmations != null ? out.confirmations + ' confs' : ''})`);
                res.writeHead(code, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(out));
            } catch (e) {
                console.error('[verify] error', e.message);
                res.writeHead(502, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'verification failed' }));
            }
        });
        return;
    }

    // static files from public/
    const file = url === '/' ? 'index.html' : url.replace(/^\/+/, '');
    const full = path.join(PUB, path.normalize(file));
    if (!full.startsWith(PUB)) { res.writeHead(403); return res.end('forbidden'); }
    fs.readFile(full, (err, data) => {
        if (err) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(full)] || 'application/octet-stream' });
        res.end(data);
    });
}).listen(PORT, () => console.log(`xmr-pay demo on http://localhost:${PORT}  (stagenet)`));
