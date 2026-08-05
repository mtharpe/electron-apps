#!/usr/bin/env bash
# Rebuild & install the standalone Google apps. Which apps is up to you — see
# services.conf for the full set, or run --list.
#
# Usage:  ./build.sh                 # pick from a menu (all, if not run in a terminal)
#         ./build.sh gmail keep      # just those; name by short key, slug or full name
#         ./build.sh --all           # everything, no prompt
#         ./build.sh --list          # show what's available
#
# Installs to ~/Applications and ad-hoc signs each app.
# Requires: node + npm (brew install node)
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

# This script builds macOS .app bundles. On Linux the packaging, install layout and
# desktop integration are entirely different, so hand off to the Linux builder.
if [ "$(uname -s)" != "Darwin" ]; then
  exec "$DIR/build-linux.sh" "$@"
fi

# Build for the host architecture so the apps run natively on Apple Silicon (arm64)
# or Intel (x86_64 -> x64). Override by exporting ARCH=universal for a fat binary.
ARCH="${ARCH:-$([ "$(uname -m)" = "x86_64" ] && echo x64 || echo arm64)}"

# service | icon-name | url | bundle-id | categories (categories are Linux-only, unused here)
. "$DIR/services.conf"
# Shared with build-linux.sh so both installers agree on what an app can be called.
. "$DIR/select-services.sh"

usage() { sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; }

WANTED=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --all)     WANTED=("${SERVICES[@]%%|*}") ;;
    --list)    list_services; exit 0 ;;
    -h|--help) usage; exit 0 ;;
    -*)        echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
    *)         WANTED[${#WANTED[@]}]="$1" ;;
  esac
  shift
done
resolve_services ${WANTED[@]+"${WANTED[@]}"}

# Install build deps on first run (electron + packager are devDependencies).
if [ ! -d node_modules ]; then
  echo "==> Installing build dependencies (electron + packager)..."
  npm install --save-dev electron @electron/packager
fi

rm -rf build && mkdir -p build
for entry in "${SELECTED[@]}"; do
  IFS='|' read -r name icon url bid categories <<< "$entry"
  echo "==> Building $name"
  /usr/bin/python3 -c "import json,sys; json.dump({'name':sys.argv[1],'url':sys.argv[2]}, open('app-config.json','w'))" "$name" "$url"
  npx electron-packager . "$name" --platform=darwin --arch="$ARCH" \
    --icon="$DIR/icons/$icon.icns" --app-bundle-id="$bid" --app-version=1.0.0 \
    --ignore="/build" --ignore="/icons" --ignore="\.sh$" --ignore="\.md$" \
    --out="$DIR/build" --overwrite >/dev/null
  rm -rf "$HOME/Applications/$name.app"
  cp -R "$DIR/build/$name-darwin-$ARCH/$name.app" "$HOME/Applications/"
  xattr -dr com.apple.quarantine "$HOME/Applications/$name.app" 2>/dev/null || true
  codesign --force --deep --sign - "$HOME/Applications/$name.app" >/dev/null 2>&1
  echo "    installed + signed: ~/Applications/$name.app"
done
rm -rf build app-config.json
echo "==> Done. Launch from ~/Applications (or Spotlight)."
