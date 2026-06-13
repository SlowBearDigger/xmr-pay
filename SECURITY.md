# Security policy

xmr-pay verifies money. If you find a way to make `verifyPayment` say `paid`
for a payment that didn't happen, didn't arrive, can't be spent, or already
paid a different order — that's the bug we care about most.

## Reporting

Use GitHub's private vulnerability reporting on this repository, or email
slowbeardigger@proton.me. Solo maintainer, best-effort response — payment
bypass reports get priority over everything else.

Please include: the scenario, a proof of concept against stagenet if you can,
and the impact as you see it.

## In scope

- Verification bypass: forged/replayed/mismatched proofs accepted as paid
- Amount confusion: rounding, precision, nonce, or tolerance abuse
- Time-lock or confirmation-gating bypass
- Signed-config forgery or fingerprint collision shenanigans
- Widget: XSS, address swap, or anything that shows the buyer a different
  address than configured
- Webhook signature forgery

## Out of scope

- Availability of public Monero nodes
- Merchant misconfiguration the docs warn about (no `UNIQUE` on `tx_hash`,
  amounts taken from the request body, exposed wallet-rpc)
- The buyer losing their tx key (documented wallet limitation)
- Social engineering of the merchant

## Try to break it

Specific cases worth attacking, with the result the code should give. If you
get a different one, that's a report. Use stagenet; never post real mainnet
keys.

| You try | Expected |
|---|---|
| A tx with `unlock_time` set (funds frozen) | `locked` — never `paid`. Fails closed if no node returns the tx. |
| A node that lies about `unlock_time` (reports `0` for a frozen tx) | caught under `quorum: 2+` — the unlock check is quorum'd like the proof step, so one disagreeing node trips it (fail closed). The tx hash in the daemon reply is also cross-checked against the txid. Run your own node first regardless. |
| The same valid proof on a second order | `replay` (via `alreadyUsed`) and/or `underpaid` (via amount-nonce). |
| An amount off by one piconero | `underpaid` — comparison is integer piconero. |
| A proof for a payment to a different address | rejected — proofs are address-bound. |
| A payment split across two txs, in **proof** mode | `underpaid` — proof verifies one tx. Use watch mode for splits. |
| A node that lies about confirmations / existence | denial fails closed; over-reporting is caught by `quorum: 2+`. |
| Mempool / 0-conf tx | `mempool`/`unconfirmed` unless `minConfirmations: 0`. |
| Pasting an address or amount into the request body | ignored — both come from your order record, not the request. |
| A flood of requests to the verify endpoint | your problem to rate-limit (see docs/DEPLOY.md); unknown/garbage are rejected before any node RPC. |
| A proof from a seed-restored wallet for an old tx | works if the wallet still holds the tx key; restored wallets often don't (see docs/WALLETS.md). |

## Dependencies

`xmr-pay` itself ships one runtime dependency (`qrcode-generator`) and no known
CVEs. Payment links, QR, signed configs, and the widget need nothing else.

On-chain verification needs `monero-ts` — a large WASM library, declared as an
**optional peer dependency**. You only install it for the server-side verify
function; the buyer-facing checkout never loads it. `monero-ts` pins two old
transitive dependencies that currently carry advisories:

| Package | Advisory | Reachable here? |
|---|---|---|
| `serialize-javascript` `^3.1.0` | High — RCE via crafted object ([GHSA-5c6j-r48x-rmvq](https://github.com/advisories/GHSA-5c6j-r48x-rmvq)) | Low — `monero-ts` serializes wallet state built from *your* keys, not buyer input. |
| `uuid` `3.3.2` | Moderate — buffer bounds, only when a `buf` arg is passed ([GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq)) | No — `monero-ts` generates ids without a buffer. |

`monero-ts` hasn't bumped them upstream. Patch them in your deployment with npm
`overrides` — both are drop-in and validated against a real on-chain verify:

```json
"overrides": {
  "serialize-javascript": "^7.0.5",
  "uuid": "^11.1.1"
}
```

After `npm install`, `npm audit` reports zero vulnerabilities. The live demo
(`demo/`) ships these overrides.

Supply-chain scanners (Socket, etc.) also flag `xmr-pay` for "network access"
and "URL strings": both are by design — verification fetches from Monero nodes,
and the default node list is literally a list of URLs. Neither is a finding.

## Verifying releases

Releases are signed with minisign, key pinned in the README:
`RWSA/E4ogu5/1mQf2r66pkWK9fYBEeFdf2cvrjkhiALoXCWT3woSSRtH`. The widget is
reproducible: `npm ci && npm run build` must match `SHA256SUMS`. A release
that fails verification is itself a security report.
