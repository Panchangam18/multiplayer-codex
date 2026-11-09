#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
OUT="${OUTPUT_DIR:-$ROOT/dist}"
NODE="$(command -v node)"
ARCH="$(uname -m)"
VERSION="$(node -p 'require("./package.json").version')"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/multiplayer-build.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
APP="$STAGE/Multiplayer Codex.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/project" "$OUT"
OUT="$(cd "$OUT" && pwd)"
if pgrep -f "$OUT/Multiplayer Codex.app/Contents/MacOS/MultiplayerCodex" >/dev/null; then
  echo "Quit the companion before replacing it, or set OUTPUT_DIR to a separate directory." >&2
  exit 1
fi
node -e 'if(Number(process.versions.node.split(".")[0])<22)process.exit(1)'
if otool -L "$NODE" | tail -n +2 | awk '{print $1}' | grep -vE '^(/System/Library/|/usr/lib/)' >/dev/null; then
  echo "Use an official self-contained Node distribution; this runtime depends on non-system libraries." >&2
  exit 1
fi
NODE_LICENSE="$(dirname "$(realpath "$NODE")")/../LICENSE"
test -f "$NODE_LICENSE" || { echo "Node runtime LICENSE not found at $NODE_LICENSE" >&2; exit 1; }
swiftc -O -target "$ARCH-apple-macos14.0" -framework AppKit macos/MultiplayerCodex.swift -o "$APP/Contents/MacOS/MultiplayerCodex"
swiftc -O -framework AppKit scripts/make-icon.swift -o "$STAGE/make-icon"
"$STAGE/make-icon" "$STAGE/AppIcon.iconset"
iconutil -c icns "$STAGE/AppIcon.iconset" -o "$APP/Contents/Resources/AppIcon.icns"
cp macos/Info.plist "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" "$APP/Contents/Info.plist"
cp "$NODE" "$APP/Contents/Resources/node"
cp "$NODE_LICENSE" "$APP/Contents/Resources/Node-LICENSE.txt"
cp "macos/Getting Started.html" "$APP/Contents/Resources/Getting Started.html"
cp -R src renderer package.json package-lock.json README.md LICENSE SECURITY.md "$APP/Contents/Resources/project/"
mkdir -p "$APP/Contents/Resources/project/docs"
cp docs/architecture.md docs/installation.md docs/verification.md "$APP/Contents/Resources/project/docs/"
(cd "$APP/Contents/Resources/project" && npm ci --omit=dev --ignore-scripts --no-fund --no-audit)
codesign --force --sign - "$APP/Contents/Resources/node"
codesign --force --sign - "$APP"
codesign --verify --deep --strict "$APP"
test ! -e "$OUT/Multiplayer Codex.app.new" || { echo "Remove the leftover .app.new build first." >&2; exit 1; }
cp -R "$APP" "$OUT/Multiplayer Codex.app.new"
rm -rf "$OUT/Multiplayer Codex.app"
mv "$OUT/Multiplayer Codex.app.new" "$OUT/Multiplayer Codex.app"
NAME="Multiplayer-Codex-$VERSION-macos-$ARCH"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$OUT/$NAME.zip"
mkdir -p "$STAGE/installer"
ditto "$APP" "$STAGE/installer/Multiplayer Codex.app"
ln -s /Applications "$STAGE/installer/Applications"
cp "macos/Getting Started.html" "$STAGE/installer/Getting Started.html"
hdiutil create -quiet -volname "Multiplayer Codex" -srcfolder "$STAGE/installer" -format UDZO -ov "$OUT/$NAME.dmg"
(cd "$OUT" && shasum -a 256 "$NAME.zip" "$NAME.dmg" > "$NAME-SHA256SUMS.txt")
echo "Built unnotarized, ad-hoc-signed preview: $OUT/$NAME.dmg"
cat "$OUT/$NAME-SHA256SUMS.txt"
