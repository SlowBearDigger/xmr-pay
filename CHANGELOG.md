# Changelog

All notable changes to `xmr-pay` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project adheres to
[Semantic Versioning](https://semver.org/).

## [2.0.0] - Unreleased

### Migration

- Set `AGENT_TOKEN` on every bind, including loopback; keep it on the merchant backend.
- Send order creation as a JSON object with `Content-Type: application/json`; invalid payload types are rejected.
- Keep wallet and order files together and stop on persistence errors. Existing engine installations must apply the dependency overrides in `SECURITY.md` and reinstall.
- Review expiry in existing CLI config: the wizard writes `expiryHours: 24` and `paidRetentionHours: 168`; use `0` to disable either. The direct HTTP example defaults both to `0`.

### Changes

- Report clipboard success only after a successful copy; keep the address visible when copying fails.

- Apply security overrides when the CLI installs the optional Monero engine.
- Require authentication on every agent bind, reject malformed order requests, and generate unpredictable order IDs.
- Persist wallet allocation before returning an order; preserve pending funds and undelivered payment notifications.
- Reject malformed unlock times and unknown wallet capabilities; propagate wallet save failures.
- Escape widget confirmation output, restrict receipt verifier URLs, and prevent webhook redirects.
- Bound the demo's static file paths and simplify source comments without changing executable logic.

## [1.1.0] - 2026-06-21

### Added
- `./state`: the canonical invoice state machine (created/processing/settled/expired/invalid), mirrored by the WooCommerce plugin and pinned by conformance tests.
- `./refund`: shared, configurable claim-link expiry semantics.
- `./report`: shared CSV column schema (`csvSafe`/`csvField`/`ordersToCsv`).
- `hosted/`: a fully static, zero-server checkout page that hosts the `<xmr-pay>` widget.
- `docs/EVENTS.md`: the state / event / webhook / refund-record contract.
- Widget: visibility-triggered poll + adaptive backoff + a 3-step progress indicator; accessibility (focus rings, `role=alert`).
- Stress/property suites: `agent.load`, `chaos-reorg`, `invariant-stress`.

### Fixed
- `createOrder` now stores the **canonical** amount, so a float input (e.g. `0.1 + 0.2`) can no longer throw in `checkOrder` and brick settlement.
- `settled` latches on the `check()` path: a reorg-driven re-check can no longer un-settle a paid order.
- Agent: dropped the banned trailing-slash regex on node URLs.

## [1.0.2] - 2026-06-20

### Security
- `summarizeTransfers` now deduplicates by the one-time OUTPUT KEY (`outKey`) when a
  caller supplies it, not by txid alone. This is the burning-bug (Monero, 2018) defence:
  two outputs sharing a one-time key: even in different txids: are at most one spendable
  output (shared key image), so counting both would credit one real payment twice. The
  bundled transports (monero-ts / monero-wallet-rpc, both wallet2) already collapse burns
  before a row is built, so this is defence-in-depth that makes the public
  `summarizeTransfers` export burning-safe for any caller's transport.

## [1.0.1] - 2026-06-20

### Fixed
- `summarizeTransfers` settlement is now fully order-independent. `moreCreditable`
  is a total order over every verdict-affecting field: it now also tie-breaks on
  lock status and double-spend-seen (a locked or contested copy of a txid wins,
  conservatively). A property test found that two copies of one txid differing only
  in `locked` could settle one way or the other depending on row order. The
  order-independence properties now run 20,000 cases and the generator covers
  `doubleSpendSeen`.

> 1.0.0 shipped this bug and is deprecated on npm; use 1.0.1.

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
  strand a confirmed payment as "mempool" or: with a duplicate that disagreed on
  amount: settle an order on an inflated claim. Both are now closed.
- The node-quorum verdict in `verifyPayment` picks the largest agreeing cluster
  rather than anchoring on the first answer, so one misconfigured/malicious node
  in the first position can no longer block a valid majority.

### Added
- `test/adversarial-stress.test.js`: order-independence, in/pool dedup, byzantine
  duplicate amounts, in/pool/locked flapping, dust floods, and a no-over-credit
  fuzz. Wired into `npm test`.
- Defensive guards: non-http(s) node URIs are rejected up front; a single-node
  `quorum=1` configuration warns that that node controls the verdict.

### Security
- The time-lock gate cross-checks the daemon echoes the requested `tx_hash`, takes
  the minimum tip across nodes, and fails closed on disagreement: a lying node
  cannot flip a frozen output to spendable.

## [0.4.0-beta] - 2026-06

Payment-correctness + reliability: order expiry/retention bounds, coalesced ledger
saves, in-flight tip dedup, persistence across restarts, and the createOrder TOCTOU
fix. Property, mutation, and stress suites added.

## [0.2.x] - 2026-06

Pre-warmed subaddress pool for instant order creation; chain tip read straight from
the node; cached order state served without a per-request sync; signed fulfillment
webhooks.
