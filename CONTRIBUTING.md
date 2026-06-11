# Contributing

Glad you're here. This is a payments library, so the bar is: every change
must make it harder, not easier, to get money wrong.

## What's welcome

- Bug fixes with a test that fails before and passes after
- Wallet compatibility reports (see the issue template — even "Cake renamed
  the menu" is useful)
- Widget translations (the `XP_STR` dict in `widget/xmr-pay.part.js`)
- Docs fixes, threat-model holes, security review

## Ground rules

- **Zero new runtime dependencies.** One dep (qrcode-generator) and one
  optional peer (monero-ts) is the budget. That's the product.
- **Money math is BigInt piconero.** A float touching an amount comparison is
  a bug, even when the test passes.
- **Fail closed.** When a check can't run, the answer is "not paid".
- Comments lowercase and plain; say why, not what.
- Behavior changes need a test. `npm test` must stay green offline.

## Running tests

```
npm test            # offline suites: config, watch, webhook
npm run test:live   # needs a funded stagenet wallet harness + monero-ts
```

The live suite expects a stagenet harness directory (env `XMRPAY_POC`)
containing a funded wallet — see the header of `test/live-stagenet.js`. Most
PRs don't need it; CI of record runs offline suites.

## Widget changes

Edit `widget/xmr-pay.part.js`, never `widget/xmr-pay.js` (it's assembled).
Rebuild with `npm run build` and commit both. Builds are reproducible — your
rebuilt file must be byte-identical to what you commit.

## Security issues

Not in the public tracker. See [SECURITY.md](SECURITY.md).
