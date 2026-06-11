**What this changes and why**

**Checklist**
- [ ] `npm test` green (offline suites)
- [ ] New/changed behavior has a test
- [ ] No new runtime dependencies
- [ ] Amount logic stays in BigInt piconero (no floats deciding money)
- [ ] Widget: edited `xmr-pay.part.js` + ran `npm run build` (both committed, reproducible)
- [ ] No secrets, keys, or real mainnet tx material in the diff
- [ ] Docs updated if behavior changed (README / WALLETS / threat model)
