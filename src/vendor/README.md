# Vendored dependencies

`xmr-pay` has **zero runtime npm dependencies**. The one library it needs for QR
rendering is vendored here, verbatim, so nothing is pulled from the registry at
install time — fewer moving parts to audit, and a fully self-contained,
reproducible build.

## qrcode-generator.js

- **Source:** [kazuhikoarase/qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator)
- **Version:** 1.5.2
- **License:** MIT © Kazuhiko Arase
- **Copied verbatim** from the published `qrcode-generator@1.5.2` package
  (`qrcode.js`). It has no dependencies of its own.

Used by [`../core.js`](../core.js) for `qrSvg`, and concatenated into the
checkout widget by [`../../scripts/build-widget.sh`](../../scripts/build-widget.sh).

To update: replace this file with the new upstream `qrcode.js`, bump the version
here **and** the `VER` constant in `build-widget.sh`, then rebuild and re-sign.
