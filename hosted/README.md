# Portable checkout page (Tier 0 — zero server, zero third party)

A complete Monero checkout that is a **plain static page**. No backend, no CDN, no third
party: the QR is generated locally by the bundled widget, the fonts are the system's, and
the only network call is the one *you* configure (your own verify/status endpoint — or
none at all in proof mode). The order id / address is the only capability.

This is the "you can host it if you want, but the beauty is it needs nothing" surface. It
hosts the same `<xmr-pay>` widget the WooCommerce plugin embeds, so the page and the
plugin are the same checkout over the same contract — just different hosts.

## Deploy (any static host)

Put three files in one folder and serve them statically (GitHub Pages, S3, nginx, a USB
stick — anything):

```
checkout.html
checkout.js
xmr-pay.js        # the widget; `npm run build` copies it here, or copy widget/xmr-pay.js
```

Then share a link. Prefer the `#fragment` form — fragments never reach a server, so the
payment details stay between the page and the buyer:

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
| `verify-url` | proof-mode endpoint (buyer pastes a txid + proof). **No backend if absent.** |
| `status-url` | watch-mode status poll (GET) — e.g. your WooCommerce plugin or agent |
| `stream-url` | watch-mode SSE live push (GET) — optional; falls back to polling |
| `redirect-url` | where to send the buyer after payment |
| `receipt-url` | signed-receipt endpoint |
| `lang` | `en` / `es` · `theme` `light` · `skin` `brutal` · `fingerprint`/`pubkey` pin the signer |

## Tiers (no sacrifices)

- **Tier 0 (default, nothing runs):** give only `address` for a tip/fixed-amount page, or add
  `verify-url` so the buyer can prove a payment, or `status-url` if you run the WooCommerce
  plugin / your own agent. The countdown is advisory; the chain is the source of truth, so a
  late top-up is never lost.
- **Tier 1 (opt-in, your box):** point `stream-url` at your agent's SSE endpoint for live
  push instead of polling. Still your server — never a third party.

The countdown shows "Rate locked · MM:SS". When it elapses the address stays payable (it
just suggests reloading for a current rate); a confirmed payment stops it and shows "Paid".
