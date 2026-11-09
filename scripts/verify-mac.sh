#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
APP="${1:-dist/Multiplayer Codex.app}"
codesign --verify --deep --strict "$APP"
plutil -lint "$APP/Contents/Info.plist"
test -s "$APP/Contents/Resources/AppIcon.icns"
test -s "$APP/Contents/Resources/Node-LICENSE.txt"
test -s "$APP/Contents/Resources/Getting Started.html"
test -f "$APP/Contents/Resources/project/LICENSE"
"$APP/Contents/Resources/node" --version
"$APP/Contents/Resources/node" --input-type=module -e 'import(process.argv[1]).then(() => console.log("Bundled service dependencies load."))' "$(cd "$APP/Contents/Resources/project" && pwd)/src/service.mjs"
if find "$APP" -type f \( -name '*.key' -o -name '*.crt' -o -name '*.asar' -o -name 'authors.json' -o -name 'status.json' -o -name '*.log' \) | grep .; then
  echo "Unexpected private/runtime data in app bundle." >&2
  exit 1
fi
echo "Bundle checks passed. This does not prove notarization or clean-machine Gatekeeper approval."
