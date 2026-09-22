# XMRPay FAQ

## What runs where?

XMRPay provides payment links, a browser widget and server-side payment verification. Payments go directly to the merchant's wallet. It does not hold a spend key or send refunds.

| Mode | Merchant runs | Buyer provides | View key |
|---|---|---|---|
| Static donation page | a static host | payment | not needed; no automatic verification |
| JavaScript proof verification | a Node function or server | transaction ID and tx key or proof | not needed |
| JavaScript watch agent | a long-running Node process | payment | on the agent |
| WooCommerce native watch | WordPress with GMP and BCMath | payment | on WordPress |
| WooCommerce native proof ("I've paid") | WordPress with GMP and BCMath | transaction ID | on WordPress |
| WooCommerce agent mode | WordPress and the Node agent | payment | on the agent |

The WooCommerce mode named `proof` verifies a transaction using the merchant's view key. It is not the keyless proof verifier exposed by the JavaScript library.

## Do I need a Monero node?

Yes, for payment verification. Configure nodes you trust or run your own. The PHP scanner requires responses and agreement from every configured node; an unavailable node pauses confirmation. The JavaScript proof verifier has a configurable quorum. The JavaScript watch agent uses an active node with failover, not a quorum.

Node agreement is not independent consensus validation. Nodes operated by the same provider may share the same data source.

## What dependencies do I need?

For the Node agent, use Node 20 or later and `monero-ts`. The CLI installs its optional engine when needed. Existing installations must follow the [dependency guidance](../SECURITY.md#dependencies). A Node function using WASM verification also needs `monero-ts`; edge runtimes are not supported by that example.

The browser widget, payment links and QR helpers do not load `monero-ts`. The wallet-rpc transport uses your own `monero-wallet-rpc` instead.

WooCommerce requires WordPress 6.2+, WooCommerce 7.0+ and PHP 7.4+. Native verification requires both GMP and BCMath in the PHP runtime serving WordPress. Agent mode does not run the Monero crypto in PHP. Digest-authenticated nodes require cURL.

## What is checked before payment is accepted?

Verification checks the receiving address, amount, confirmations, explicit time locks and duplicate payment evidence. Amount comparisons use integer piconero. The merchant backend must bind the expected address and amount to its order and enforce atomic replay protection. Browser events are display signals, not fulfillment authorization.

Confirmations reduce reorganisation risk; no fixed count guarantees finality. The agent does not automatically reverse a settled order after a reorganisation. Ordinary wallet maturation and an explicit `unlock_time` are different: the agent uses the configured confirmation threshold and separately rejects explicit locks that have not elapsed.

## What happens to partial or late payments?

Watch mode sums payments to the order's subaddress. A recorded partial payment remains open for a top-up. Proof verification checks one transaction at a time.

WooCommerce native modes and the direct HTTP example default expiry to disabled. The CLI wizard instead saves 24-hour expiry and 168-hour paid retention; set those config values to `0` to disable them. If enabled, it uses the evidence the scanner has seen. PHP watch mode scans blocks and can miss a payment still in the mempool. Native proof mode cannot detect a payment the buyer has not submitted. A payment arriving after expiry still reaches the wallet but may need manual reconciliation. See [states and events](EVENTS.md).

## Are refunds automatic?

No. The merchant collects a receiving address and sends the refund manually. WooCommerce's claim-link flow records the request, address and sent transaction. Overpayments are recorded for reconciliation. Blesta instead retains payments exceeding an invoice's remaining balance as account credit.

## Where should secrets live?

Keep the view key, node passwords, agent token and webhook secret on the merchant backend. Never send the agent token to a browser. In WordPress, `XMRPAY_VIEW_KEY` in `wp-config.php` can keep the view key out of database settings; the configuration file and its backups still contain the secret. Remove any previously saved database value separately.

The agent requires `AGENT_TOKEN` even on loopback. Back up its wallet and order ledger together. See [storage and recovery](STORAGE.md).

## How should I test an integration?

Use matching stagenet keys, addresses and nodes. Test creation, payment, partial payment, duplicate callback, restart and late payment in the platform you will deploy. Unit tests and historical chain checks do not replace that checkout test. Choose confirmations and expiry for your fulfillment policy before using mainnet.

## More documentation

- [Agent setup](AGENT.md)
- [HTTP API](API.md)
- [Proof endpoint deployment](DEPLOY.md)
- [Buyer wallet proofs](WALLETS.md)
- [Suite components](SUITE.md)
