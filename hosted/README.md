# Portable checkout page

A static page hosts the bundled widget and generates the QR locally. With only an
address it displays payment instructions; automatic verification needs your own
verify or status endpoint. Order IDs are identifiers, not authentication unless
your store explicitly treats an unguessable ID as a bearer capability.

## Deploy (any static host)

Put three files in one folder and serve them statically (GitHub Pages, S3, nginx, a USB
stick: anything):

```
checkout.html
checkout.js
xmr-pay.js        # the widget; `npm run build` copies it here, or copy widget/xmr-pay.js
```

Then share a link. Prefer the `#fragment` form: fragments are not sent in the initial HTTP request, but page scripts can read
them and configured endpoints may receive payment details:

```
https://shop.example/checkout.html#address=4YOUR_ADDRESS&amount=0.05&label=Order%2042&expires=1718900000
```

## Parameters

| Param | Meaning |
|---|---|
| `address` | a Monero address (or use `config` for a signed, tamper-evident envelope) |
| `config` | base64 signed-config envelope (the widget verifies the signature) |
| `amount` | XMR to charge (omit for an open / tip amount) |
| `label` | what the buyer is paying for |
| `order` | your order id (sent to the verify/status endpoint) |
| `expires` | unix **seconds** when the price/rate window ends (drives the countdown) |
| `window` | minutes from page load if `expires` is absent (default 30) |
| `verify-url` | proof-mode endpoint (buyer pastes a txid + proof). Without a verify or status endpoint the page cannot confirm payment. |
| `status-url` | watch-mode status poll (GET): e.g. your WooCommerce plugin or agent |
| `stream-url` | watch-mode SSE live push (GET): optional; falls back to polling |
| `redirect-url` | where to send the buyer after payment |
| `receipt-url` | signed-receipt endpoint |
| `lang` | `en` / `es` · `theme` `light` · `skin` `brutal` · `fingerprint`/`pubkey` pin the signer |

## Verification and status

Use `verify-url` for buyer-submitted proofs, or `status-url` for a backend that
tracks the order. `stream-url` can point to a restricted store proxy for live
updates. Keep the agent token on that proxy, never in the page or URL.

The countdown is advisory. It does not lock an exchange rate on the server or
change the backend's expiry policy. A late payment reaches the wallet but may
need manual reconciliation.

The countdown shows "Rate locked · MM:SS". When it elapses the address stays payable (it
just suggests reloading for a current rate); a confirmed payment stops it and shows "Paid".
