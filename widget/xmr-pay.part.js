// ── <xmr-pay> web component ─────────────────────────────────────────────────
// expects `qrcode` (vendored above) in scope. no other dependencies, no network
// calls except the merchant's own verify-url when the buyer submits a proof.

var XP_STR = {
    en: {
        sendExactly: 'Send exactly', anyAmount: 'Send any amount', awaiting: 'Awaiting payment', scanToSend: 'Scan or tap to send',
        addrLabel: 'Payment address — click to copy', copied: 'Copied ✓', openWallet: 'Open in wallet',
        trustToggle: 'Non-custodial · verify this payment',
        trustFunds: 'Funds go directly to the merchant’s wallet — this page never holds your money.',
        trustAddr: 'Check the address — it must start and end with:',
        trustAddrHint: 'Copy it and confirm with the merchant for large payments.',
        trustLink: 'Check the link — you are on',
        proveToggle: 'Paid but still waiting? Prove it',
        txidPh: 'Transaction ID (txid)', proofPh: 'Tx key or payment proof',
        proofHint: 'Feather: History → right-click the tx → Create tx proof. GUI: open the tx → “P”. Cake/Monerujo: tx details → transaction key. Paste it all in either box — txid and proof sort themselves out.',
        verifyBtn: 'Verify payment', verifying: 'Verifying on-chain…', pasteBtn: 'Paste', pasteFail: 'Could not read the clipboard — paste manually',
        paidTitle: 'Payment confirmed', confs: 'confirmations',
        underpaid: 'Received {r} XMR, expected {e}',
        topupMsg: 'Detected {r} XMR — send {s} more to complete',
        topupTitle: 'Scan to send the difference',
        mempool: 'Seen in the mempool — waiting for the first block',
        unconfirmed: 'Not confirmed yet — try again in a minute',
        replay: 'This transaction already paid another order',
        invalid: 'We couldn’t match this to your payment — check the transaction ID and proof are for THIS order',
        badTxid: 'That transaction ID looks off — it should be 64 characters. Copy the whole thing from your wallet',
        badProof: 'That doesn’t look like a payment proof — paste the tx key (64 chars) or the proof block (OutProof…/InProof…) from your wallet',
        'no-funds': 'This transaction sent nothing to this address',
        'node-disagreement': 'Nodes disagreed — try again',
        'node-error': 'Nodes are unavailable — try again in a moment',
        locked: 'Funds are time-locked — payment not accepted',
        netErr: 'Network error — try again',
        foot: 'Non-custodial — funds go directly to the merchant.',
        signedBy: 'Signed · {fp}', unsigned: 'Unsigned — verify the address with the merchant',
        badTitle: 'Signature check failed', badBody: 'This payment claims to be signed but the signature does not match. Do not pay. Contact the merchant.',
        disclaimer: 'Verify the address before sending. Monero payments are final and cannot be reversed. This widget is provided as-is, with no warranty.',
    },
    es: {
        sendExactly: 'Envía exactamente', anyAmount: 'Envía cualquier cantidad', awaiting: 'Esperando pago', scanToSend: 'Escanea o toca para enviar',
        addrLabel: 'Dirección de pago — clic para copiar', copied: 'Copiada ✓', openWallet: 'Abrir en wallet',
        trustToggle: 'No-custodial · verifica este pago',
        trustFunds: 'Los fondos van directo a la wallet del comerciante — esta página nunca toca tu dinero.',
        trustAddr: 'Comprueba la dirección — debe empezar y terminar con:',
        trustAddrHint: 'Cópiala y confírmala con el comerciante en pagos grandes.',
        trustLink: 'Comprueba el enlace — estás en',
        proveToggle: '¿Pagaste y sigue esperando? Demuéstralo',
        txidPh: 'ID de transacción (txid)', proofPh: 'Tx key o prueba de pago',
        proofHint: 'Feather: History → clic derecho en la tx → Create tx proof. GUI: abre la tx → “P”. Cake/Monerujo: detalles de la tx → transaction key. Pega todo en cualquier caja — txid y prueba se acomodan solos.',
        verifyBtn: 'Verificar pago', verifying: 'Verificando en cadena…', pasteBtn: 'Pegar', pasteFail: 'No se pudo leer el portapapeles — pega a mano',
        paidTitle: 'Pago confirmado', confs: 'confirmaciones',
        underpaid: 'Se recibió {r} XMR, se esperaban {e}',
        topupMsg: 'Detectado {r} XMR — envía {s} más para completar',
        topupTitle: 'Escanea para enviar la diferencia',
        mempool: 'Visto en el mempool — esperando el primer bloque',
        unconfirmed: 'Aún sin confirmar — prueba en un minuto',
        replay: 'Esta transacción ya pagó otra orden',
        invalid: 'No pudimos relacionarlo con tu pago — revisa que el ID de transacción y la prueba sean de ESTA orden',
        badTxid: 'Ese ID de transacción no cuadra — debe tener 64 caracteres. Copia el completo desde tu wallet',
        badProof: 'Eso no parece una prueba de pago — pega la tx key (64 caracteres) o el bloque (OutProof…/InProof…) de tu wallet',
        'no-funds': 'Esta transacción no envió nada a esta dirección',
        'node-disagreement': 'Los nodos no coinciden — reintenta',
        'node-error': 'Nodos no disponibles — reintenta en un momento',
        locked: 'Los fondos están bloqueados en el tiempo — pago no aceptado',
        netErr: 'Error de red — reintenta',
        foot: 'No-custodial — los fondos van directo al comerciante.',
        signedBy: 'Firmado · {fp}', unsigned: 'Sin firmar — verifica la dirección con el comerciante',
        badTitle: 'Falló la verificación de firma', badBody: 'Este pago dice estar firmado pero la firma no coincide. No pagues. Contacta al comerciante.',
        disclaimer: 'Verifica la dirección antes de enviar. Los pagos en Monero son finales e irreversibles. Este widget se ofrece tal cual, sin garantía.',
    },
};

// two skins, one component. default = "clean" (universal, rounded, system
// sans). skin="brutal" flips to the goxmr look (mono, square, hard offset
// shadow). every color/shape is a css custom property so any brand can retheme
// without forking.
var XP_CSS = [
    ':host{--xp-accent:#FF6600;--xp-qr:#F26822;--xp-bg:#1b1b1f;--xp-fg:#f7f7f8;--xp-muted:#9b9ba4;',
    '--xp-border:#33333b;--xp-input:#26262d;--xp-green:#22c55e;--xp-yellow:#eab308;--xp-red:#f87171;',
    '--xp-radius:14px;--xp-radius-sm:9px;--xp-bw:1px;--xp-bw-in:1px;--xp-shadow:0 10px 30px rgba(0,0,0,.35);',
    '--xp-font:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;--xp-mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;',
    '--xp-case:none;--xp-track:.01em;--xp-btn-bg:var(--xp-accent);--xp-btn-fg:#fff;--xp-btn-hv:#e25c00;--xp-qr-border:#e8e8ec;',
    'display:block;max-width:400px;font-family:var(--xp-font);}',
    ':host([theme=light]){--xp-bg:#fff;--xp-fg:#141417;--xp-muted:#6e6e78;--xp-border:#e5e5ea;--xp-input:#f4f4f6;--xp-shadow:0 10px 26px rgba(0,0,0,.10);}',
    ':host([skin=brutal]){--xp-bg:#18181b;--xp-fg:#fafafa;--xp-muted:#a1a1aa;--xp-border:#fff;--xp-input:#27272a;',
    '--xp-radius:0;--xp-radius-sm:0;--xp-bw:3px;--xp-bw-in:2px;--xp-shadow:7px 7px 0 0 var(--xp-qr);',
    '--xp-font:var(--xp-mono);--xp-case:uppercase;--xp-track:.04em;--xp-btn-bg:var(--xp-fg);--xp-btn-fg:var(--xp-bg);--xp-btn-hv:var(--xp-accent);--xp-qr-border:#000;}',
    ':host([skin=brutal][theme=light]){--xp-bg:#fff;--xp-fg:#0a0a0a;--xp-muted:#52525b;--xp-border:#000;--xp-input:#f4f4f5;}',
    '*{box-sizing:border-box;margin:0;}',
    '.card{background:var(--xp-bg);color:var(--xp-fg);border:var(--xp-bw) solid var(--xp-border);border-radius:var(--xp-radius);box-shadow:var(--xp-shadow);overflow:hidden;}',
    '.hd{padding:14px 16px;border-bottom:var(--xp-bw-in) solid var(--xp-border);}',
    '.lbl{font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--xp-muted);}',
    '.amt{font-size:26px;font-weight:800;color:var(--xp-accent);line-height:1.1;margin-top:3px;font-family:var(--xp-mono);}',
    '.st{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:var(--xp-track);margin-top:7px;color:var(--xp-yellow);}',
    '.st.paid{color:var(--xp-green);}',
    '.qrwrap{display:flex;justify-content:center;padding:16px 16px 10px;}',
    '.qr{background:#fff;padding:8px;border:var(--xp-bw-in) solid var(--xp-qr-border);border-radius:var(--xp-radius-sm);width:228px;height:228px;}',
    '.qr svg{display:block;width:100%;height:100%;}',
    '.sec{padding:0 16px 12px;}',
    '.addr{width:100%;background:var(--xp-input);border:var(--xp-bw-in) solid var(--xp-border);border-radius:var(--xp-radius-sm);color:var(--xp-fg);',
    'font-family:var(--xp-mono);font-size:10.5px;text-align:left;padding:8px;word-break:break-all;cursor:pointer;line-height:1.5;}',
    '.addr:hover{background:var(--xp-accent);color:#fff;}',
    '.addr b{color:var(--xp-accent);font-weight:800;} .addr:hover b{color:#fff;}',
    '.wallet{display:block;text-align:center;margin-top:8px;background:var(--xp-btn-bg);color:var(--xp-btn-fg);border:var(--xp-bw-in) solid transparent;border-radius:var(--xp-radius-sm);',
    'font-family:var(--xp-font);font-size:12px;font-weight:700;text-transform:var(--xp-case);letter-spacing:var(--xp-track);text-decoration:none;padding:11px;}',
    '.wallet:hover{background:var(--xp-btn-hv);color:#fff;}',
    '.tgl{width:100%;background:none;border:0;border-top:1px solid var(--xp-input);color:var(--xp-muted);font-family:var(--xp-font);',
    'font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:var(--xp-track);padding:10px 4px;cursor:pointer;display:flex;justify-content:space-between;gap:8px;}',
    '.tgl:hover{color:var(--xp-accent);} .tgl .car{transition:transform .15s;} .tgl.open .car{transform:rotate(180deg);}',
    '.fold{border:var(--xp-bw-in) solid var(--xp-border);border-radius:var(--xp-radius-sm);padding:10px;margin-bottom:10px;font-size:10px;color:var(--xp-muted);line-height:1.55;}',
    '.fold p{margin-bottom:7px;} .fold b{color:var(--xp-fg);text-transform:uppercase;}',
    '.fp{display:block;border:var(--xp-bw-in) solid var(--xp-border);border-radius:var(--xp-radius-sm);background:var(--xp-input);padding:6px 8px;margin:4px 0;color:var(--xp-fg);word-break:break-all;font-family:var(--xp-mono);}',
    '.fp b{color:var(--xp-accent);}',
    '.in{width:100%;background:var(--xp-input);border:var(--xp-bw-in) solid var(--xp-border);border-radius:var(--xp-radius-sm);color:var(--xp-fg);font-family:var(--xp-mono);font-size:10.5px;padding:8px;margin-bottom:7px;}',
    'textarea.in{resize:vertical;min-height:46px;word-break:break-all;}',
    '.go{width:100%;background:var(--xp-btn-bg);color:var(--xp-btn-fg);border:var(--xp-bw-in) solid transparent;border-radius:var(--xp-radius-sm);font-family:var(--xp-font);font-size:12px;',
    'font-weight:800;text-transform:var(--xp-case);letter-spacing:var(--xp-track);padding:10px;cursor:pointer;}',
    '.go:hover{background:var(--xp-btn-hv);color:#fff;} .go:disabled{opacity:.45;cursor:not-allowed;}',
    '.prow{display:flex;gap:8px;} .prow .verify{flex:1;} .prow .paste{flex:0 0 auto;width:auto;padding-left:16px;padding-right:16px;background:transparent;color:var(--xp-fg);border-color:var(--xp-border);}',
    '.prow .paste:hover{background:var(--xp-accent);color:#fff;border-color:var(--xp-accent);}',
    ':host *:focus-visible{outline:2px solid var(--xp-accent);outline-offset:2px;}',
    ':host([skin=brutal]) .wallet,:host([skin=brutal]) .go{border-color:var(--xp-border);}',
    '.res{margin-top:7px;font-size:10px;font-weight:700;} .res.bad{color:var(--xp-red);} .res.mid{color:var(--xp-yellow);}',
    '.topup{margin-top:9px;padding:11px;border:1px solid var(--xp-input);border-radius:var(--xp-radius-sm);text-align:center;}',
    '.topup .ta{font-family:var(--xp-mono);font-size:14px;font-weight:800;color:var(--xp-accent);letter-spacing:var(--xp-track);margin-top:2px;}',
    '.topup .tq{width:150px;height:150px;background:#fff;padding:7px;margin:8px auto;border:var(--xp-bw-in) solid var(--xp-qr-border);border-radius:var(--xp-radius-sm);}',
    '.topup .tq svg{display:block;width:100%;height:100%;}',
    '.topup .wallet{margin-top:4px;}',
    '.hint{margin-top:7px;font-size:9px;color:var(--xp-muted);line-height:1.5;}',
    '.foot{padding:10px 16px;border-top:1px solid var(--xp-input);font-size:9px;color:var(--xp-muted);text-align:center;}',
    '.ok{padding:26px 16px;text-align:center;}',
    '.ring{width:54px;height:54px;border:3px solid var(--xp-green);border-radius:50%;display:flex;align-items:center;justify-content:center;',
    'margin:0 auto 10px;color:var(--xp-green);font-size:26px;}',
    '.ok .t{font-size:13px;font-weight:800;text-transform:var(--xp-case);}',
    '.ok .c{font-size:10px;color:var(--xp-muted);margin-top:5px;}',
    '.hidden{display:none;}',
].join('');

function xpQrSvg(text) {
    var qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    var n = qr.getModuleCount(), s = 4, q = 2, size = (n + q * 2) * s, rects = '';
    function fin(r, c) { return (r < 7 && c < 7) || (r < 7 && c >= n - 7) || (r >= n - 7 && c < 7); }
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) {
        if (!qr.isDark(r, c)) continue;
        rects += '<rect x="' + (c + q) * s + '" y="' + (r + q) * s + '" width="' + s + '" height="' + s +
            '" fill="' + (fin(r, c) ? '#000' : '#F26822') + '"/>';
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + size + ' ' + size + '" shape-rendering="crispEdges" role="img" aria-label="Monero payment QR code">' + rects + '</svg>';
}

function xpEsc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
}

// canonical XMR decimal for the monero: URI's tx_amount — trims trailing zeros
// and surrounding space so every wallet (Feather, GUI, CLI, Cake, Monerujo,
// Stack…) prefills the same clean amount. matches src/core.js picoToXmrString,
// the form round-trip-tested against the official wallet2 parser. odd inputs are
// left untouched (the amount is validated server-side regardless).
function xpNormAmount(a) {
    a = String(a == null ? '' : a).trim();
    if (!/^\d+(\.\d{1,12})?$/.test(a)) return a;
    if (a.indexOf('.') < 0) return a;
    return a.replace(/0+$/, '').replace(/\.$/, '');
}

// signed-config verification, browser side. mirrors src/config.js exactly so a
// config signed in node verifies here. Ed25519 via WebCrypto (modern browsers).
function xpCanonical(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(xpCanonical).join(',') + ']';
    return '{' + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ':' + xpCanonical(v[k]); }).join(',') + '}';
}
function xpB64ToBytes(b64) { var s = atob(b64); var a = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; }
function xpPemToDer(pem) { return xpB64ToBytes(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')); }
async function xpFingerprint(der) {
    // 12 bytes / 96 bits — must match configFingerprint() in src/config.js, or a
    // pinned fingerprint never matches what the widget computes.
    var h = new Uint8Array(await crypto.subtle.digest('SHA-256', der));
    var hex = ''; for (var i = 0; i < 12; i++) hex += h[i].toString(16).padStart(2, '0');
    return hex.match(/.{4}/g).join('-');
}
async function xpVerifyConfig(env) {
    try {
        if (!env || !env.config || !env.sig || !env.pubkey) return { valid: false };
        var der = xpPemToDer(env.pubkey);
        var key = await crypto.subtle.importKey('spki', der, { name: 'Ed25519' }, false, ['verify']);
        var sig = xpB64ToBytes(env.sig);
        var msg = new TextEncoder().encode(xpCanonical(env.config));
        var ok = await crypto.subtle.verify('Ed25519', key, sig, msg);
        return { valid: ok, fingerprint: await xpFingerprint(der), config: env.config };
    } catch (e) { return { valid: false, error: e && e.message }; }
}

class XmrPay extends HTMLElement {
    static get observedAttributes() { return ['address', 'amount', 'label', 'order', 'verify-url', 'lang', 'redirect-url', 'theme']; }

    connectedCallback() { this._resolve().then(() => this._render()); }
    attributeChangedCallback() { if (this.isConnected) this._resolve().then(() => this._render()); }

    // work out the effective address/amount and the signing state before render.
    // a `config` attribute (base64 signed envelope) overrides inline attrs and,
    // if its signature is bad or fails a pin, suppresses the pay UI entirely.
    async _resolve() {
        var cfg = this.getAttribute('config');
        if (!cfg) {
            this._addr = (this.getAttribute('address') || '').trim();
            this._amount = (this.getAttribute('amount') || '').trim();
            this._sign = { state: 'unsigned' };
            return;
        }
        try {
            var env = JSON.parse(atob(cfg));
            var v = await xpVerifyConfig(env);
            var pin = (this.getAttribute('pubkey') || this.getAttribute('fingerprint') || '').trim();
            var pinned = !pin || (v.fingerprint && pin.replace(/[^a-f0-9]/gi, '').toLowerCase() === v.fingerprint.replace(/-/g, ''));
            if (v.valid && pinned) {
                this._addr = (env.config.address || '').trim();
                this._amount = (env.config.amount != null ? String(env.config.amount) : '').trim();
                this._sign = { state: 'ok', fp: v.fingerprint };
            } else {
                this._addr = ''; this._amount = '';
                this._sign = { state: 'bad' };
            }
        } catch (e) {
            this._addr = ''; this._amount = '';
            this._sign = { state: 'bad' };
        }
    }

    get _t() {
        var lang = this.getAttribute('lang') ||
            ((document.documentElement.lang || navigator.language || 'en').toLowerCase().indexOf('es') === 0 ? 'es' : 'en');
        return XP_STR[lang] || XP_STR.en;
    }

    _uri() {
        var label = this.getAttribute('label');
        var p = [];
        if (this._amount) p.push('tx_amount=' + encodeURIComponent(xpNormAmount(this._amount)));
        if (label) p.push('tx_description=' + encodeURIComponent(label));
        return 'monero:' + (this._addr || '') + (p.length ? '?' + p.join('&') : '');
    }

    _render() {
        var t = this._t;
        var addr = this._addr || '';
        var amount = this._amount || '';
        var verifyUrl = (this.getAttribute('verify-url') || '').trim();
        var sign = this._sign || { state: 'unsigned' };
        var root = this.shadowRoot || this.attachShadow({ mode: 'open' });

        // a config that claims to be signed but doesn't verify (or fails a pin)
        // never shows a payable address — it's the loudest failure mode we have.
        if (sign.state === 'bad') {
            root.innerHTML = '<style>' + XP_CSS + '</style>' +
                '<div class="card"><div class="hd"><div class="st" style="color:var(--xp-red)">⚠ ' + t.badTitle + '</div></div>' +
                '<div class="sec" style="padding:14px 16px"><p class="hint" style="font-size:11px;color:var(--xp-red)">' + t.badBody + '</p></div></div>';
            return;
        }
        if (!/^[1-9A-HJ-NP-Za-km-z]{95}$/.test(addr)) {
            root.innerHTML = '<style>' + XP_CSS + '</style><div class="card"><div class="hd"><div class="lbl">xmr-pay</div>' +
                '<div class="st" style="color:var(--xp-red)">missing or invalid address attribute</div></div></div>';
            return;
        }

        var fpHead = xpEsc(addr.slice(0, 8)), fpTail = xpEsc(addr.slice(-8)), fpMid = xpEsc(addr.slice(8, -8));
        var host = location.host || location.hostname || '';

        root.innerHTML =
            '<style>' + XP_CSS + '</style>' +
            '<div class="card">' +
            '<div class="hd">' +
            '<div class="lbl">' + (amount ? t.sendExactly : t.anyAmount) + (this.getAttribute('label') ? ' · ' + xpEsc(this.getAttribute('label')) : '') + '</div>' +
            (amount ? '<div class="amt">' + xpEsc(amount) + ' XMR</div>' : '') +
            '<div class="st">' + (verifyUrl ? '● ' + t.awaiting : t.scanToSend) + '</div>' +
            '</div>' +
            '<div class="body">' +
            '<div class="qrwrap"><div class="qr">' + xpQrSvg(this._uri()) + '</div></div>' +
            '<div class="sec">' +
            '<div class="lbl" style="margin-bottom:4px">' + t.addrLabel + '</div>' +
            '<button class="addr" type="button" aria-label="' + t.addrLabel + '"><b>' + fpHead + '</b>' + fpMid + '<b>' + fpTail + '</b></button>' +
            '<a class="wallet" href="' + xpEsc(this._uri()) + '">' + t.openWallet + '</a>' +
            '</div>' +
            '<div class="sec">' +
            '<button class="tgl trust-toggle" type="button" aria-expanded="false"><span>⛨ ' + t.trustToggle + '</span><span class="car">▾</span></button>' +
            '<div class="fold trust-body hidden">' +
            (sign.state === 'ok'
                ? '<p style="color:var(--xp-green)"><b>⛨ ' + t.signedBy.replace('{fp}', xpEsc(sign.fp)) + '</b></p>'
                : '<p class="hint">' + t.unsigned + '</p>') +
            '<p>' + t.trustFunds + '</p>' +
            '<p><b>' + t.trustAddr + '</b></p>' +
            '<span class="fp"><b>' + fpHead + '</b> … <b>' + fpTail + '</b></span>' +
            '<p class="hint">' + t.trustAddrHint + '</p>' +
            '<p><b>' + t.trustLink + '</b> <span style="color:var(--xp-accent)">' + xpEsc(host) + '</span></p>' +
            '<p class="hint" style="border-top:1px solid var(--xp-input);padding-top:8px;margin-top:4px">' + t.disclaimer + '</p>' +
            '</div>' +
            (verifyUrl ?
                '<button class="tgl prove-toggle" type="button" aria-expanded="false"><span>' + t.proveToggle + '</span><span class="car">▾</span></button>' +
                '<div class="fold prove-body hidden">' +
                '<input class="in txid" spellcheck="false" autocapitalize="off" autocomplete="off" aria-label="' + t.txidPh + '" placeholder="' + t.txidPh + '">' +
                '<textarea class="in proof" rows="2" spellcheck="false" autocapitalize="off" aria-label="' + t.proofPh + '" placeholder="' + t.proofPh + '"></textarea>' +
                '<div class="prow">' +
                '<button class="go paste" type="button">' + t.pasteBtn + '</button>' +
                '<button class="go verify" type="button">' + t.verifyBtn + '</button>' +
                '</div>' +
                '<p class="res hidden" role="status" aria-live="polite"></p>' +
                '<div class="topup hidden" role="status" aria-live="polite"></div>' +
                '<p class="hint">' + t.proofHint + '</p>' +
                '</div>'
                : '') +
            '</div>' +
            '</div>' +
            '<div class="foot">' + t.foot + '</div>' +
            '</div>';

        this._wire(root, addr, verifyUrl, t);
    }

    _wire(root, addr, verifyUrl, t) {
        var self = this;
        var addrBtn = root.querySelector('.addr');
        addrBtn.addEventListener('click', function () {
            var done = function () {
                var old = addrBtn.innerHTML;
                addrBtn.textContent = t.copied;
                setTimeout(function () { addrBtn.innerHTML = old; }, 1600);
            };
            if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(addr).then(done, done);
            else done();
        });

        root.querySelectorAll('.tgl').forEach(function (tgl) {
            tgl.addEventListener('click', function () {
                var open = tgl.classList.toggle('open');
                tgl.setAttribute('aria-expanded', open ? 'true' : 'false');
                var body = tgl.nextElementSibling;
                if (body) body.classList.toggle('hidden');
            });
        });

        var verifyBtn = root.querySelector('.verify');
        if (verifyBtn) verifyBtn.addEventListener('click', function () { self._verify(root, verifyUrl, t); });

        // smart paste: Feather's "formatted proof" (and similar) is one text
        // block with txid + address + signature. accept the whole thing in
        // either box and sort the pieces out.
        var txidIn = root.querySelector('.txid'), proofIn = root.querySelector('.proof');
        var split = function (el) {
            var v = el.value;
            if (!v || v.length < 70) return;
            var proof = (v.match(/(?:Out|In)Proof[Vv]?\d?[1-9A-HJ-NP-Za-km-z]{40,}/) || [null])[0];
            var hexes = v.match(/\b[0-9a-fA-F]{64}\b/g) || [];
            var txid = hexes[0] || null;
            var key = proof || (hexes.length > 1 ? hexes[1] : null);
            if (txid && key && txid !== key) { txidIn.value = txid.toLowerCase(); proofIn.value = key; }
        };
        if (txidIn && proofIn) {
            [txidIn, proofIn].forEach(function (el) { el.addEventListener('input', function () { split(el); }); });
        }

        // mobile-friendly: read the clipboard and let smart-split sort it. needs
        // a user gesture + HTTPS; falls back to a hint if the browser refuses.
        var pasteBtn = root.querySelector('.paste');
        if (pasteBtn && txidIn && proofIn) {
            pasteBtn.addEventListener('click', function () {
                if (!navigator.clipboard || !navigator.clipboard.readText) { self._showRes(root, t.pasteFail, 'bad'); return; }
                navigator.clipboard.readText().then(function (text) {
                    if (!text) return;
                    proofIn.value = text.trim();
                    split(proofIn);
                    proofIn.focus();
                }, function () { self._showRes(root, t.pasteFail, 'bad'); });
            });
        }
    }

    _showRes(root, msg, kind) {
        var res = root.querySelector('.res');
        if (!res) return;
        res.textContent = msg;
        res.className = 'res ' + (kind || '');
    }

    async _verify(root, verifyUrl, t) {
        var txid = root.querySelector('.txid').value.trim();
        var proof = root.querySelector('.proof').value.trim();
        var res = root.querySelector('.res');
        var btn = root.querySelector('.verify');
        if (!txid) { root.querySelector('.txid').focus(); return; }
        if (!proof) { root.querySelector('.proof').focus(); return; }
        // catch the common paste mistakes BEFORE a server round-trip, with a
        // specific message so the buyer can fix it on the spot.
        if (!/^[0-9a-f]{64}$/i.test(txid)) { this._showRes(root, t.badTxid, 'bad'); root.querySelector('.txid').focus(); return; }
        if (!(/^[0-9a-f]{64}$/i.test(proof) || /^(Out|In)Proof/i.test(proof))) { this._showRes(root, t.badProof, 'bad'); root.querySelector('.proof').focus(); return; }

        btn.disabled = true; btn.textContent = t.verifying;
        res.classList.add('hidden');
        var out = null;
        try {
            var r = await fetch(verifyUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ order_id: this.getAttribute('order') || null, txid: txid, proof: proof }),
            });
            out = await r.json();
        } catch (e) {
            out = { paid: false, status: 'netErr' };
        }
        btn.disabled = false; btn.textContent = t.verifyBtn;

        this.dispatchEvent(new CustomEvent('xmr-pay:result', { detail: out, bubbles: true, composed: true }));

        if (out && out.paid) { this._success(root, out, t); return; }

        var status = (out && (out.status || out.error)) || 'invalid';
        var msg = t[status] || (out && out.error) || t.invalid;
        var topup = root.querySelector('.topup');
        if (topup) { topup.className = 'topup hidden'; topup.innerHTML = ''; }
        if (status === 'underpaid') {
            var recv = out.receivedXmr != null ? out.receivedXmr : '?';
            if (out.shortfallXmr != null) {
                // the server computed the missing amount in piconero (exact). show
                // it AND a QR for EXACTLY the difference so the buyer can top up —
                // no mental math, no chance to send the wrong amount.
                msg = t.topupMsg.replace('{r}', recv).replace('{s}', out.shortfallXmr);
                if (topup) {
                    var tUri = 'monero:' + (this._addr || '') + '?tx_amount=' + encodeURIComponent(out.shortfallXmr);
                    var tLbl = this.getAttribute('label'); if (tLbl) tUri += '&tx_description=' + encodeURIComponent(tLbl);
                    topup.innerHTML =
                        '<div class="lbl">' + t.topupTitle + '</div>' +
                        '<div class="ta">' + xpEsc(out.shortfallXmr) + ' XMR</div>' +
                        '<div class="tq">' + xpQrSvg(tUri) + '</div>' +
                        '<a class="wallet" href="' + xpEsc(tUri) + '">' + t.openWallet + '</a>';
                    topup.className = 'topup';
                }
            } else {
                // older server without shortfallXmr — fall back to expected amount.
                var exp = out.expectedXmr != null ? out.expectedXmr : (this.getAttribute('amount') || '—');
                msg = t.underpaid.replace('{r}', recv).replace('{e}', exp);
            }
        }
        res.textContent = msg;
        res.className = 'res ' + (status === 'mempool' || status === 'unconfirmed' || status === 'node-error' ? 'mid' : 'bad');
    }

    _success(root, out, t) {
        var st = root.querySelector('.st');
        if (st) { st.textContent = '✓ ' + t.paidTitle; st.classList.add('paid'); }
        var body = root.querySelector('.body');
        body.innerHTML = '<div class="ok"><div class="ring">✓</div><div class="t">' + t.paidTitle + '</div>' +
            '<div class="c">' + (out.confirmations != null ? out.confirmations + ' ' + t.confs : '') + '</div></div>';
        // UX signal ONLY — this runs in the buyer's browser, so a buyer can fire
        // this event (or fake this whole success state) from the console. NEVER
        // release goods on it. Fulfill on YOUR server's verifyPayment + order
        // record. (Same rule as Stripe: the client is not the authority.)
        this.dispatchEvent(new CustomEvent('xmr-pay:paid', { detail: out, bubbles: true, composed: true }));
        var redirect = this.getAttribute('redirect-url');
        if (redirect) setTimeout(function () { location.assign(redirect); }, 2500);
    }
}

if (!customElements.get('xmr-pay')) customElements.define('xmr-pay', XmrPay);
