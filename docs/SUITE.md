# Suite direction — one toolkit for physical + online + self-host

Three codebases exist today that solve adjacent slices of the same merchant's
life:

| Piece | Solves | State |
|---|---|---|
| `xmr-pay` (this repo) | online checkout: links, QR, widget, proof/watch verification, signed configs | tested, near publishable |
| `xmretail-pos` | in-person sales: browser POS, view-only wallet, per-sale subaddresses, inventory | working prototype |
| GoXMR Pay (goxmr.click) | hosted gateway | live, superseded by the lib direction |

## Why a suite makes sense

They already share the hard parts. The POS derives subaddresses from a view
key in the browser; watch mode does the same through the merchant's
wallet-rpc; proof mode covers the zero-infra case. URI building, QR rendering,
amount handling, payment classification — each repo has its own copy today.
One `core` ends that.

A suite is also a stronger story than three repos: "self-hosted Monero
commerce — sell in person, sell online, verify payments, owe nobody anything"
competes with BTCPay's pitch at a fraction of its infrastructure.

## Shape

```
core      uri · qr · amount-nonce · piconero math · validation   (browser + node)
verify    buyer-proof verification, stateless                     (merchant's node/serverless)
watch     wallet-rpc watcher, subaddress per order                (merchant's box)
config    signed merchant configs, fingerprints                   (offline + browser verify)
widget    <xmr-pay> web component, clean/brutal skins             (one file, no deps)
pos       xmretail-pos, rebased onto core                         (browser app)
console   later: thin self-host admin — orders, keys, node health
```

## Trust tiers, one suite

| Tier | Infra needed | Detection |
|---|---|---|
| proof | none | buyer submits proof |
| watch | merchant's wallet-rpc (+node) | automatic |
| pos | browser only (view key local) | automatic, in person |

All three are sovereign: nothing routes through goxmr.

## What not to do yet

Don't merge the POS codebase in. It's a young prototype; coupling it now
drags its churn into a library that's nearly stable. Sequence instead:

1. Publish `xmr-pay` standalone.
2. Extract what the POS duplicates into `core`, make the POS consume it.
   Its cypherpunk look maps 1:1 onto the `brutal` skin tokens.
3. Decide branding for the umbrella (the GOXMR look is now an opt-in skin,
   so a neutral suite name is viable; goxmr.click becomes the showcase).
4. Console and shop-platform plugins (WooCommerce) after real-world feedback.
