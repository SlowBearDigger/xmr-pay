#!/usr/bin/env bash
# Build release checksums and apply configured signatures.
set -euo pipefail
cd "$(dirname "$0")/.."

bash scripts/build-widget.sh

FILES="widget/xmr-pay.js src/core.js src/verify.js src/watch.js src/scanner.js src/agent.js src/config.js src/receipt.js src/webhook.js"
shasum -a 256 $FILES > SHA256SUMS
echo "--- SHA256SUMS ---"; cat SHA256SUMS; echo

if command -v minisign >/dev/null 2>&1; then
  KEY="${MINISIGN_KEY:-$HOME/.minisign/xmr-pay.key}"
  if [ -f "$KEY" ]; then
    minisign -S -s "$KEY" -m SHA256SUMS
    echo "signed -> SHA256SUMS.minisig"
  else
    echo "no minisign key at $KEY"
    echo "create one once:  minisign -G -s \"$KEY\" -p minisign.pub   (commit minisign.pub)"
  fi
else
  echo "minisign not installed (brew install minisign): skipping signature"
fi

if command -v gpg >/dev/null 2>&1 && [ -n "${GPG_SIGN:-}" ]; then
  gpg --armor --detach-sign --output SHA256SUMS.asc SHA256SUMS
  echo "signed -> SHA256SUMS.asc"
fi
