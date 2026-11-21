#!/usr/bin/env bash
# Use the signers from this trusted source checkout, never from downloaded assets.
set -euo pipefail
repository="$(cd -- "$(dirname -- "$0")/.." && pwd)"
if [[ $# != 1 ]]; then
  echo "Usage: $0 RELEASE_DIRECTORY" >&2
  exit 1
fi
version="$(node -p "require(process.argv[1]).version" "$repository/package.json")"
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo 'Invalid package version for release filenames.' >&2
  exit 1
fi
cd -- "$1"
ssh-keygen -Y verify -f "$repository/.github/release.allowed_signers" \
  -I xmrpay-release -n releases@xmrpay.shop -s SHA256SUMS.sig < SHA256SUMS

mapfile -t entries < SHA256SUMS
if [[ ${#entries[@]} != 2 || ! "${entries[0]}" =~ ^[0-9a-f]{64}"  xmr-pay.js"$ || \
      ! "${entries[1]:0:64}" =~ ^[0-9a-f]{64}$ || "${entries[1]:64}" != "  xmr-pay-$version.tgz" ]]; then
  echo 'The release manifest must contain exactly xmr-pay.js and the versioned npm tarball, in that order.' >&2
  exit 1
fi
sha256sum --check --strict SHA256SUMS
