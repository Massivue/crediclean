#!/usr/bin/env bash
# Build a clean folder containing only the files Chrome needs, and zip it for
# Chrome Web Store submission.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD="$ROOT/build/crediclean"
VERSION=$(node -p "require('$ROOT/manifest.json').version")

echo "Verifying before packaging..."
node "$ROOT/scripts/verify-manifest.js"
( cd "$ROOT" && node --test "tests/**/*.test.js" > /dev/null )
echo "Tests passed."

rm -rf "$ROOT/build"
mkdir -p "$BUILD"

# Only what the extension actually loads. Tests, scripts, samples and docs
# are development files and must not ship.
cp "$ROOT/manifest.json" "$BUILD/"
cp "$ROOT/LICENSE" "$BUILD/" 2>/dev/null || true
cp "$ROOT/PRIVACY.md" "$BUILD/" 2>/dev/null || true
mkdir -p "$BUILD/src"
cp -R "$ROOT/src/." "$BUILD/src/"

# Guard against accidentally shipping anything unexpected.
find "$BUILD" -name '*.test.js' -delete
find "$BUILD" -name '.DS_Store' -delete

ZIP="$ROOT/build/crediclean-$VERSION.zip"
( cd "$BUILD" && zip -qr "$ZIP" . )

echo
echo "Unpacked build : $BUILD"
echo "Zip for upload : $ZIP"
echo "Files included : $(find "$BUILD" -type f | wc -l)"
echo "Zip size       : $(du -h "$ZIP" | cut -f1)"
