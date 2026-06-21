#!/usr/bin/env bash
# reassemble widget/xmr-pay.js from source + the vendored qrcode-generator.
# deterministic: no timestamps, no minifier, plain concatenation. anyone who
# runs `npm run build` gets a byte-identical file, so the published SHA256SUMS
# can be reproduced rather than trusted. qrcode-generator is vendored in-repo
# (src/vendor) so the build needs no npm dependency at all.
set -euo pipefail
cd "$(dirname "$0")/.."

QR="${QRCODE_SRC:-src/vendor/qrcode-generator.js}"   # vendored in-repo — zero npm deps, always present
[ -f "$QR" ] || { echo "missing $QR"; exit 1; }
VER="1.5.2"   # vendored qrcode-generator version (src/vendor) — bump when the vendored file is updated

OUT=widget/xmr-pay.js
{
  echo "/*! <xmr-pay> — sovereign Monero checkout widget. one self-hosted file: no CDN, no third-party requests, QR generated locally."
  echo " * bundles qrcode-generator@${VER} (c) Kazuhiko Arase, MIT — https://github.com/kazuhikoarase/qrcode-generator */"
  echo "(function(){"
  cat "$QR"
  echo ""
  cat widget/xmr-pay.part.js
  echo "})();"
} > "$OUT"

node --check "$OUT"
echo "built $OUT ($(wc -c < "$OUT" | tr -d ' ') bytes, qrcode-generator@${VER})"

# ship the same built widget alongside the portable hosted checkout page, so hosted/ is a
# self-contained zero-server drop-in (Tier 0). git-ignored; published via npm files[].
cp "$OUT" hosted/xmr-pay.js
echo "copied widget -> hosted/xmr-pay.js"
