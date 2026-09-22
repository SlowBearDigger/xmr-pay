# XMRPay components

Each repository has a separate role. Installing one adapter does not require installing the others.

| Repository | Role |
|---|---|
| `xmr-pay` | JavaScript library, widget, proof verifier and watch agent |
| `xmr-pay-php` | PHP payment verification and amount helpers |
| `xmr-pay-adapter-core` | shared PHP checkout and settlement integration |
| `xmr-pay-woocommerce` | WordPress plugin with native PHP verification or agent mode |
| `xmr-pay-laravel` | Laravel service and configuration for the PHP engine |
| `xmr-pay-hikashop` | HikaShop payment and Joomla scheduler plugins |
| `xmr-pay-virtuemart` | VirtueMart payment and Joomla scheduler plugins |
| `xmr-pay-jekyll` | Liquid include and bundled browser widget |
| `xmr-pay-build` | builds the two Joomla installation packages |
| `xmr-pay-blesta` | Blesta nonmerchant gateway using the watch agent |

The Joomla builder copies the PHP engine, adapter core and payment card into each cart package. The WooCommerce plugin maintains its WordPress-specific scanner. Shared amount and state tests check parity; the PHP and JavaScript transports are not identical implementations.

Blesta uses signed callbacks and agent status checks. Laravel exposes verification methods but leaves durable order state and fulfillment to the application. Static Jekyll pages need a merchant backend for verified order fulfillment.

Before releasing a coordinated update, align package versions and dependency requirements, rebuild bundled copies, and test checkout on the target platforms. See each repository's README for installation and platform requirements.
