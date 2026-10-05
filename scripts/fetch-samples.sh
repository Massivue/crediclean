#!/usr/bin/env bash
# Download real C2PA-signed test images used by tests/real-samples.test.js.
#
# These are third-party test assets from the Content Authenticity Initiative's
# own repositories. They are not committed here, so this script fetches them on
# demand. Without them, the real-sample tests skip.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/tests/samples"
mkdir -p "$DIR"

BASE="https://raw.githubusercontent.com/contentauth/c2pa-rs/main/sdk/tests/fixtures"

download() {
  local name="$1"
  if [ -s "$DIR/$name" ]; then
    echo "  have    $name"
    return
  fi
  if curl -fsSL --max-time 60 -o "$DIR/$name" "$BASE/$name"; then
    echo "  fetched $name ($(wc -c < "$DIR/$name") bytes)"
  else
    echo "  FAILED  $name (the real-sample tests for it will skip)" >&2
    rm -f "$DIR/$name"
  fi
}

echo "Fetching C2PA sample images into tests/samples ..."
download CA.jpg            # manifest split across two APP11 segments
download C.jpg             # manifest in a single APP11 segment
download exp-test1.png     # large PNG with a caBX manifest and linked XMP
download libpng-test.png   # PNG with no credentials
download sample1.webp      # WebP with no credentials
echo "Done."
