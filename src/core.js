// client-side payment primitives: payment links (monero: URIs), per-order
// amount nonces, and QR rendering as a plain SVG string. pure functions, no
// network, no state. pairs with ./verify on the merchant's server side.

const qrcode = require('./vendor/qrcode-generator');   // vendored — zero npm deps
const { isValidAddress, xmrToPico, picoToXmr, picoToXmrString, isValidTxid } = require('./verify'); // verify loads monero-ts lazily — safe for core-only users

// unique per-order amount: base + random 1..(10^digits - 1) piconero. the
// on-chain amount helps a payment proof structurally fit only its own order.
// it is a SECONDARY guard — the primary anti-replay is the caller's txid dedup
// (alreadyUsed). default digits=6 gives ~10^6 distinct amounts (collisions stay
// rare into the thousands of orders) for at most 0.000000999999 XMR of dust;
// raise it for very high volume.
function makeAmountNonce(baseXmr, { digits = 6 } = {}) {
    if (!Number.isInteger(digits) || digits < 1 || digits > 8) throw new Error('digits must be an integer 1..8');
    const span = 10 ** digits - 1;                 // nonce in 1..span piconero
    const g = (typeof globalThis !== 'undefined' && globalThis.crypto) || require('crypto').webcrypto;
    // rejection sampling so the nonce is uniform — plain `% span` biases the low
    // values, which would make some amounts (and thus orders) easier to collide.
    const limit = Math.floor(0xFFFFFFFF / span) * span;
    let r;
    do { r = g.getRandomValues(new Uint32Array(1))[0]; } while (r >= limit);
    return picoToXmrString(xmrToPico(baseXmr) + BigInt((r % span) + 1));
}

// monero: payment URI (the "payment link"). amount optional (tips). values are
// URI-encoded; networkType (when given) validates the address shape strictly.
function makePaymentURI({ address, amount, recipientName, description, networkType } = {}) {
    if (typeof address !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{95}$/.test(address)) {
        throw new Error('address must be a 95-char Monero address');
    }
    if (networkType && !isValidAddress(address, networkType)) {
        throw new Error(`address is not a valid ${networkType} address`);
    }
    const params = [];
    if (amount !== undefined && amount !== null && amount !== '') {
        params.push(`tx_amount=${picoToXmrString(xmrToPico(amount))}`);
    }
    if (recipientName) params.push(`recipient_name=${encodeURIComponent(recipientName)}`);
    if (description) params.push(`tx_description=${encodeURIComponent(description)}`);
    return `monero:${address}${params.length ? '?' + params.join('&') : ''}`;
}

// QR as an SVG string — embed anywhere, no canvas, no DOM required. finder
// squares get their own color so the GOXMR orange-dots/black-corners look is
// one call away. error correction M, version auto.
function qrSvg(text, { ec = 'M', moduleColor = '#F26822', finderColor = '#000000', scale = 4, quietZone = 2 } = {}) {
    const qr = qrcode(0, ec);
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const size = (n + quietZone * 2) * scale;
    const inFinder = (r, c) => (r < 7 && c < 7) || (r < 7 && c >= n - 7) || (r >= n - 7 && c < 7);
    let rects = '';
    for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
            if (!qr.isDark(r, c)) continue;
            const x = (c + quietZone) * scale, y = (r + quietZone) * scale;
            rects += `<rect x="${x}" y="${y}" width="${scale}" height="${scale}" fill="${inFinder(r, c) ? finderColor : moduleColor}"/>`;
        }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="Monero payment QR">${rects}</svg>`;
}

module.exports = {
    makeAmountNonce,
    makePaymentURI,
    qrSvg,
    picoToXmrString,
    // re-exports for convenience
    isValidAddress, isValidTxid, xmrToPico, picoToXmr,
};
