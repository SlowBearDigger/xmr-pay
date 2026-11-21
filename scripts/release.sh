#!/usr/bin/env bash
# Prepare reproducible release assets; keep SSH signing on the maintainer's machine.
set -euo pipefail
cd "$(dirname "$0")/.."

prepare=false
if [[ "${1:-}" == --prepare ]]; then
  prepare=true
  shift
fi
if [[ $# -gt 1 || "${1:-}" == --* ]]; then
  echo "Usage: $0 [--prepare] [OUTPUT_DIRECTORY]" >&2
  exit 1
fi
output="${1:-release}"
if [[ "$prepare" == false && ! -f "${XMRPAY_SIGNING_KEY:-}" ]]; then
  echo 'Set XMRPAY_SIGNING_KEY to your local SSH signing key, or use --prepare for unsigned CI builds.' >&2
  exit 1
fi
if [[ -e "$output" || -L "$output" ]]; then
  echo "Refusing to overwrite release output: $output" >&2
  exit 1
fi
version="$(node -p "require('./package.json').version")"
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo 'Invalid package version for release filenames.' >&2
  exit 1
fi
tarball="xmr-pay-$version.tgz"

bash scripts/build-widget.sh
mkdir -p -- "$output"
cp -- widget/xmr-pay.js "$output/xmr-pay.js"
npm pack --ignore-scripts --quiet --pack-destination "$output"
test -f "$output/$tarball"
(
  cd -- "$output"
  sha256sum -- xmr-pay.js "$tarball" > SHA256SUMS
)
if [[ "$prepare" == false ]]; then
  ssh-keygen -Y sign -f "$XMRPAY_SIGNING_KEY" -n releases@xmrpay.shop "$output/SHA256SUMS"
  bash scripts/verify-release.sh "$output"
fi
printf 'Release assets prepared in %s\n' "$output"
