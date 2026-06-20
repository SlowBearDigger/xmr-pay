# Changelog

All notable changes to `xmr-pay` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project adheres to
[Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-06-20

First stable release. The payment-correctness core (proof verification, the watch
agent, and the WP-native scanner) is settled, live-tested on stagenet end to end,
and covered by an adversarial test suite that includes property, fuzz, mutation,
soak, stress, reorg, and false-paid hunting.

### Changed
- **Settlement is now independent of transaction order.** `summarizeTransfers`
  deduplicates by txid keeping the most-creditable copy (confirmed over pool, more
  confirmations, then the smaller amount). Previously a first-wins dedup made the
  verdict depend on the order the wallet/node returned rows in, which could either
  strand a confirmed payment as "mempool" or — with a duplicate that disagreed on
  amount — settle an order on an inflated claim. Both are now closed.
- The node-quorum verdict in `verifyPayment` picks the largest agreeing cluster
  rather than anchoring on the first answer, so one misconfigured/malicious node
  in the first position can no longer block a valid majority.

### Added
- `test/adversarial-stress.test.js` — order-independence, in/pool dedup, byzantine
  duplicate amounts, in/pool/locked flapping, dust floods, and a no-over-credit
  fuzz. Wired into `npm test`.
- Defensive guards: non-http(s) node URIs are rejected up front; a single-node
  `quorum=1` configuration warns that that node controls the verdict.

### Security
- The time-lock gate cross-checks the daemon echoes the requested `tx_hash`, takes
  the minimum tip across nodes, and fails closed on disagreement — a lying node
  cannot flip a frozen output to spendable.

## [0.4.0-beta] - 2026-06

Payment-correctness + reliability: order expiry/retention bounds, coalesced ledger
saves, in-flight tip dedup, persistence across restarts, and the createOrder TOCTOU
fix. Property, mutation, and stress suites added.

## [0.2.x] - 2026-06

Pre-warmed subaddress pool for instant order creation; chain tip read straight from
the node; cached order state served without a per-request sync; signed fulfillment
webhooks.
