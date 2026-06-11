#!/usr/bin/env bash
# Rebuild & install the standalone Google apps (Gmail, Calendar, Tasks, Keep).
# Usage:  ./build.sh           # build all four, install to ~/Applications, ad-hoc sign
# Requires: node + npm (brew install node)
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

# service | icon-name | url | bundle-id
SERVICES=(
  "Gmail|gmail|https://mail.google.com/|com.miketharpe.gmailapp"
  "Google Calendar|calendar|https://calendar.google.com/|com.miketharpe.calendarapp"
  "Google Tasks|tasks|https://tasks.google.com/embed/?origin=https://calendar.google.com&fullWidth=1|com.miketharpe.tasksapp"
  "Google Keep|keep|https://keep.google.com/|com.miketharpe.keepapp"
)

# Install build deps on first run (electron + packager are devDependencies).
if [ ! -d node_modules ]; then
  echo "==> Installing build dependencies (electron + packager)..."
  npm install --save-dev electron @electron/packager
fi

rm -rf build && mkdir -p build
for entry in "${SERVICES[@]}"; do
  IFS='|' read -r name icon url bid <<< "$entry"
  echo "==> Building $name"
  /usr/bin/python3 -c "import json,sys; json.dump({'name':sys.argv[1],'url':sys.argv[2]}, open('app-config.json','w'))" "$name" "$url"
  npx electron-packager . "$name" --platform=darwin --arch=arm64 \
    --icon="$DIR/icons/$icon.icns" --app-bundle-id="$bid" --app-version=1.0.0 \
    --ignore="/build" --ignore="/icons" --ignore="\.sh$" --ignore="\.md$" \
    --out="$DIR/build" --overwrite >/dev/null
  rm -rf "$HOME/Applications/$name.app"
  cp -R "$DIR/build/$name-darwin-arm64/$name.app" "$HOME/Applications/"
  xattr -dr com.apple.quarantine "$HOME/Applications/$name.app" 2>/dev/null || true
  codesign --force --deep --sign - "$HOME/Applications/$name.app" >/dev/null 2>&1
  echo "    installed + signed: ~/Applications/$name.app"
done
rm -rf build app-config.json
echo "==> Done. Launch from ~/Applications (or Spotlight)."
