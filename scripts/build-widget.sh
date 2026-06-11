#!/usr/bin/env bash
# reassemble widget/xmr-pay.js from source + the pinned qrcode-generator.
# deterministic: no timestamps, no minifier, plain concatenation. anyone who
# runs `npm ci && npm run build` gets a byte-identical file, so the published
# SHA256SUMS can be reproduced rather than trusted.
set -euo pipefail
cd "$(dirname "$0")/.."

QR="${QRCODE_SRC:-node_modules/qrcode-generator/qrcode.js}"
[ -f "$QR" ] || { echo "missing $QR — run 'npm ci' first"; exit 1; }
VER="$(node -p "require('qrcode-generator/package.json').version" 2>/dev/null || echo vendored)"

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
