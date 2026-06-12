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
| The same valid proof on a second order | `replay` (via `alreadyUsed`) and/or `underpaid` (via amount-nonce). |
| An amount off by one piconero | `underpaid` — comparison is integer piconero. |
| A proof for a payment to a different address | rejected — proofs are address-bound. |
| A payment split across two txs, in **proof** mode | `underpaid` — proof verifies one tx. Use watch mode for splits. |
| A node that lies about confirmations / existence | denial fails closed; over-reporting is caught by `quorum: 2+`. |
| Mempool / 0-conf tx | `mempool`/`unconfirmed` unless `minConfirmations: 0`. |
| Pasting an address or amount into the request body | ignored — both come from your order record, not the request. |
| A flood of requests to the verify endpoint | your problem to rate-limit (see docs/DEPLOY.md); unknown/garbage are rejected before any node RPC. |
| A proof from a seed-restored wallet for an old tx | works if the wallet still holds the tx key; restored wallets often don't (see docs/WALLETS.md). |

## Verifying releases

Releases are signed with minisign, key pinned in the README:
`RWSA/E4ogu5/1mQf2r66pkWK9fYBEeFdf2cvrjkhiALoXCWT3woSSRtH`. The widget is
reproducible: `npm ci && npm run build` must match `SHA256SUMS`. A release
that fails verification is itself a security report.
