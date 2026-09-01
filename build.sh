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
  # `npm install` with no package names, deliberately: package.json pins Electron to
  # castlabs' Widevine-enabled fork, and naming `electron` here would resolve to stock
  # Electron from the registry and quietly replace it. DRM apps would then build fine and
  # simply never play.
  npm install
fi

# @electron/packager fetches Electron through @electron/get, and neither the default
# URL builder nor its env-var overrides match what castlabs actually publishes: the
# release tag carries a +wvcus suffix (v42.8.0+wvcus) and so does the main asset
# (electron-v42.8.0+wvcus-darwin-arm64.zip), while the checksum file stays at the
# ordinary SHASUMS256.txt path. ELECTRON_CUSTOM_FILENAME applies to EVERY download
# @electron/get makes — pointing it at the +wvcus zip makes @electron/get fetch the
# zip when it wanted SHASUMS256 and choke on the binary — so there is no combination
# of ELECTRON_CUSTOM_* vars that gets both requests right. Bypass the whole path:
# fetch the castlabs zip once ourselves, stage it under the plain-version name that
# packager expects, and pass --electron-zip-dir. That skips @electron/get's download
# and checksum steps entirely; the resolved tag is the integrity check.
#
# Runs AFTER argparse, deliberately: --list and --help must not require node or
# network, and the earlier revision of this block sat at the top of the file where
# every invocation paid for it whether it needed to build anything or not.
ELECTRON_VER=$(node -p "require('./package.json').devDependencies.electron.split('#v')[1].split('+')[0]")
ELECTRON_ZIP_DIR="${ELECTRON_ZIP_DIR:-${XDG_CACHE_HOME:-$HOME/Library/Caches}/linux-google-apps}"
mkdir -p "$ELECTRON_ZIP_DIR"
# --electron-zip-dir looks up the file under the electron version @electron/packager
# reads from node_modules/electron/package.json, and castlabs publishes that as
# "42.8.0+wvcus" — so the on-disk name MUST carry the +wvcus suffix; without it
# packager reports "The specified Electron ZIP file does not exist" and the build
# stops. The zip's URL basename already carries the same suffix, so download and
# lookup names cannot drift.
STAGED_ZIP="$ELECTRON_ZIP_DIR/electron-v${ELECTRON_VER}+wvcus-darwin-${ARCH}.zip"
if [ ! -s "$STAGED_ZIP" ]; then
  # ELECTRON_ZIP_URL fully overrides for an internal mirror; ELECTRON_MIRROR still
  # works as the base if someone had already set it. Neither is required.
  URL="${ELECTRON_ZIP_URL:-${ELECTRON_MIRROR:-https://github.com/castlabs/electron-releases/releases/download/}v${ELECTRON_VER}+wvcus/electron-v${ELECTRON_VER}+wvcus-darwin-${ARCH}.zip}"
  echo "==> Downloading Electron $ELECTRON_VER+wvcus (darwin-$ARCH)"
  curl -fSL --retry 3 -o "$STAGED_ZIP.part" "$URL"
  mv "$STAGED_ZIP.part" "$STAGED_ZIP"
fi

rm -rf build && mkdir -p build
for entry in "${SELECTED[@]}"; do
  IFS='|' read -r name icon url bid categories related drm <<< "$entry"
  echo "==> Building $name"
  # slug travels into the app so main.js can find styles/<slug>.css without re-deriving it.
  # drm is a plain boolean the runtime reads to decide whether to wait on Widevine.
  slug="$(slugify "$name")"
  /usr/bin/python3 -c "import json,sys; json.dump({'name':sys.argv[1],'url':sys.argv[2],'slug':sys.argv[3],'related':sys.argv[4],'drm':sys.argv[5]=='1'}, open('app-config.json','w'))" "$name" "$url" "$slug" "${related:-}" "${drm:-}"
  npx electron-packager . "$name" --platform=darwin --arch="$ARCH" \
    --icon="$DIR/icons/$icon.icns" --app-bundle-id="$bid" --app-version=1.0.0 \
    --electron-zip-dir="$ELECTRON_ZIP_DIR" \
    "${IGNORE_FLAGS[@]}" \
    --out="$DIR/build" --overwrite >/dev/null
  rm -rf "$HOME/Applications/$name.app"
  cp -R "$DIR/build/$name-darwin-$ARCH/$name.app" "$HOME/Applications/"
  xattr -dr com.apple.quarantine "$HOME/Applications/$name.app" 2>/dev/null || true
  codesign --force --deep --sign - "$HOME/Applications/$name.app" >/dev/null 2>&1
  echo "    installed + signed: ~/Applications/$name.app"
done
rm -rf build app-config.json
echo "==> Done. Launch from ~/Applications (or Spotlight)."
