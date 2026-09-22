#!/usr/bin/env bash
# Build the widget and hosted checkout from canonical sources.
set -euo pipefail
cd "$(dirname "$0")/.."

QR="${QRCODE_SRC:-src/vendor/qrcode-generator.js}"
[ -f "$QR" ] || { echo "missing $QR"; exit 1; }
VER="1.5.2"   # Keep this attribution version aligned with the vendored source.

OUT=widget/xmr-pay.js
{
  echo "/*! <xmr-pay>: Monero checkout widget with locally generated QR codes."
  echo " * bundles qrcode-generator@${VER} (c) Kazuhiko Arase, MIT: https://github.com/kazuhikoarase/qrcode-generator */"
  echo "(function(){"
  cat "$QR"
  echo ""
  cat widget/xmr-pay.part.js
  echo "})();"
} > "$OUT"

node --check "$OUT"
echo "built $OUT ($(wc -c < "$OUT" | tr -d ' ') bytes, qrcode-generator@${VER})"

cp "$OUT" hosted/xmr-pay.js
echo "copied widget -> hosted/xmr-pay.js"
