#!/usr/bin/env bash
# Build & install the standalone Google apps on Linux. Which apps is up to you — see
# services.conf for the full set, or run --list.
#
# Usage:  ./build-linux.sh                  # pick from a menu (all, if not run in a terminal)
#         ./build-linux.sh gmail keep       # just those; name by short key, slug or full name
#         ./build-linux.sh --all            # everything, no prompt
#         ./build-linux.sh --list           # show what's available
#         ./build-linux.sh --uninstall      # remove everything this installed
#         ./build-linux.sh --uninstall keep # remove just those
#         PREFIX=~/.local ./build-linux.sh
#         ARCH=arm64 ./build-linux.sh
#
# Requires: node + npm. ImageMagick or python3-Pillow is used to build the icon-size
# ladder; without either, a single full-size icon is installed instead.
#
# Installs, per service, entirely inside $PREFIX (no root, nothing outside your home):
#   $PREFIX/lib/<slug>/                       the packaged Electron app
#   $PREFIX/bin/<slug>                        launcher symlink
#   $PREFIX/share/applications/<slug>.desktop app-menu entry
#   $PREFIX/share/icons/hicolor/*/apps/<slug>.png
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

PREFIX="${PREFIX:-$HOME/.local}"
# Node/Electron arch names, derived from the host (uname reports x86_64 / aarch64).
case "${ARCH:-$(uname -m)}" in
  x86_64|x64|amd64) ARCH=x64 ;;
  aarch64|arm64)    ARCH=arm64 ;;
  armv7l)           ARCH=armv7l ;;
  *)                ARCH="${ARCH:-$(uname -m)}" ;;
esac

. "$DIR/services.conf"
# Provides slugify(), list_services() and resolve_services() — shared with build.sh so the
# two installers can't disagree about what an app is called.
. "$DIR/select-services.sh"

APPS_DIR="$PREFIX/share/applications"
ICONS_DIR="$PREFIX/share/icons/hicolor"

uninstall_one() {
  local slug="$1"
  rm -rf "$PREFIX/lib/$slug"
  rm -f  "$PREFIX/bin/$slug" "$APPS_DIR/$slug.desktop"
  find "$ICONS_DIR" -name "$slug.png" -delete 2>/dev/null || true
}

refresh_caches() {
  command -v update-desktop-database >/dev/null && update-desktop-database "$APPS_DIR" 2>/dev/null || true
  command -v gtk-update-icon-cache   >/dev/null && gtk-update-icon-cache -qtf "$ICONS_DIR" 2>/dev/null || true
}

usage() { sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; }

UNINSTALL=0
WANTED=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --uninstall) UNINSTALL=1 ;;
    # --all is how a script says "everything" without depending on whether it happens to
    # have a terminal attached.
    --all)       WANTED=("${SERVICES[@]%%|*}") ;;
    --list)      list_services; exit 0 ;;
    -h|--help)   usage; exit 0 ;;
    -*)          echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
    *)           WANTED[${#WANTED[@]}]="$1" ;;
  esac
  shift
done

if [ "$UNINSTALL" = 1 ]; then
  # Uninstalling with no names removes everything, which is what it has always done and
  # what someone typing --uninstall means. Prompting here would be a trap, not a courtesy.
  if [ "${#WANTED[@]}" -eq 0 ]; then
    SELECTED=("${SERVICES[@]}")
  else
    resolve_services ${WANTED[@]+"${WANTED[@]}"}
  fi
  for entry in "${SELECTED[@]}"; do
    IFS='|' read -r name _ _ _ _ <<< "$entry"
    slug="$(slugify "$name")"
    echo "==> Removing $name"
    uninstall_one "$slug"
  done
  refresh_caches
  echo "==> Uninstalled. Per-account logins in ~/.config/<App Name> were left in place."
  exit 0
fi

resolve_services ${WANTED[@]+"${WANTED[@]}"}

# Icons ship as macOS .icns (the original format of this project). Extract the largest
# embedded PNG once into icons/png/ so adding a service still only means adding an .icns.
# .icns is a flat sequence of type+length+payload chunks; modern types embed PNG directly,
# so this needs nothing but the standard library.
mkdir -p icons/png
extract_icns_png() {
  python3 - "$1" "$2" <<'PY'
import struct, sys
src, dst = sys.argv[1], sys.argv[2]
data = open(src, 'rb').read()
if data[:4] != b'icns':
    sys.exit("not an icns file: " + src)
end, off, best = min(struct.unpack('>I', data[4:8])[0], len(data)), 8, None
while off + 8 <= end:
    length = struct.unpack('>I', data[off + 4:off + 8])[0]
    if length < 8:
        break
    payload = data[off + 8:off + length]
    # PNG magic; width lives in the IHDR at bytes 16..20 of the stream.
    if payload[:8] == b'\x89PNG\r\n\x1a\x0a' and len(payload) > 24:
        w = struct.unpack('>I', payload[16:20])[0]
        if best is None or w > best[0]:
            best = (w, payload)
    off += length
if not best:
    sys.exit("no embedded PNG found in " + src)
open(dst, 'wb').write(best[1])
PY
}

# Install <src png> as the themed icon <slug>, at every size the desktop looks for.
# ImageMagick or Pillow does the downscaling; with neither available we fall back to
# dropping the full-size original into the largest bucket and letting GTK scale it.
install_icons() {
  local src="$1" slug="$2" size
  local sizes="16 24 32 48 64 128 256 512"
  if command -v magick >/dev/null 2>&1 || command -v convert >/dev/null 2>&1; then
    local im; im="$(command -v magick || command -v convert)"
    for size in $sizes; do
      mkdir -p "$ICONS_DIR/${size}x${size}/apps"
      "$im" "$src" -resize "${size}x${size}" "$ICONS_DIR/${size}x${size}/apps/$slug.png"
    done
  elif python3 -c 'import PIL' >/dev/null 2>&1; then
    python3 - "$src" "$ICONS_DIR" "$slug" "$sizes" <<'PY'
import os, sys
from PIL import Image
src, icons_dir, slug, sizes = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4].split()
img = Image.open(src).convert('RGBA')
for s in (int(x) for x in sizes):
    d = os.path.join(icons_dir, '%dx%d' % (s, s), 'apps')
    os.makedirs(d, exist_ok=True)
    img.resize((s, s), Image.LANCZOS).save(os.path.join(d, slug + '.png'))
PY
  else
    echo "    note: no ImageMagick/Pillow — installing a single unscaled icon"
    mkdir -p "$ICONS_DIR/512x512/apps"
    cp "$src" "$ICONS_DIR/512x512/apps/$slug.png"
  fi
}

# Install build deps on first run (electron + packager are devDependencies).
if [ ! -d node_modules ]; then
  echo "==> Installing build dependencies (electron + packager)..."
  npm install --save-dev electron @electron/packager
fi

# Each app needs its OWN X11 WM_CLASS / Wayland app_id, or the desktop treats all four as
# one application: they share a single icon in the dash, group together in alt-tab, and
# only one .desktop file can ever match. Electron derives it from package.json's
# productName (lowercased) — NOT from the executable name, and NOT from app.setName() or
# Chromium's --class switch, both of which are applied too late to affect it. So the value
# has to be baked in per service at package time. The working tree is restored on any exit,
# including Ctrl-C, so an interrupted build never leaves package.json rewritten.
PKG_BACKUP="$(mktemp)"
cp package.json "$PKG_BACKUP"
restore_pkg() { [ -f "$PKG_BACKUP" ] && cp "$PKG_BACKUP" package.json && rm -f "$PKG_BACKUP"; }
# HUP/PIPE matter as much as INT/TERM here: piping this script's output to something that
# exits early (`./build-linux.sh | head`) kills it with SIGPIPE, and an untrapped fatal
# signal skips the EXIT trap entirely — which would strand a half-built productName in the
# working tree. Learned by doing exactly that.
trap restore_pkg EXIT INT TERM HUP PIPE

set_product_name() {
  python3 - "$1" <<'PY'
import json, sys
with open('package.json') as f:
    pkg = json.load(f)
pkg['productName'] = sys.argv[1]
with open('package.json', 'w') as f:
    json.dump(pkg, f, indent=2)
    f.write('\n')
PY
}

mkdir -p "$PREFIX/lib" "$PREFIX/bin" "$APPS_DIR" "$ICONS_DIR"
rm -rf build && mkdir -p build

for entry in "${SELECTED[@]}"; do
  IFS='|' read -r name icon url bid categories <<< "$entry"
  slug="$(slugify "$name")"
  echo "==> Building $name"

  png="$DIR/icons/png/$icon.png"
  if [ ! -f "$png" ]; then
    [ -f "$DIR/icons/$icon.icns" ] || { echo "    missing icons/$icon.icns and icons/png/$icon.png"; exit 1; }
    echo "    extracting icons/png/$icon.png from $icon.icns"
    extract_icns_png "$DIR/icons/$icon.icns" "$png"
  fi

  python3 -c "import json,sys; json.dump({'name':sys.argv[1],'url':sys.argv[2]}, open('app-config.json','w'))" "$name" "$url"
  # Becomes this app's WM_CLASS (see above); StartupWMClass in the .desktop file matches it.
  set_product_name "$slug"

  # --executable-name pins the binary name (and with it the WM_CLASS the .desktop file
  # below matches on); without it the binary would be "Google Calendar", spaces and all.
  npx electron-packager . "$name" --platform=linux --arch="$ARCH" \
    --executable-name="$slug" --app-version=1.0.0 \
    --ignore="/build" --ignore="/icons" --ignore="\.sh$" --ignore="\.md$" \
    --ignore="/services\.conf$" \
    --out="$DIR/build" --overwrite >/dev/null

  staged="$DIR/build/$name-linux-$ARCH"
  uninstall_one "$slug"
  install_icons "$png" "$slug"

  # main.js picks this up for window/taskbar icons and notification banners — a Linux
  # binary has no bundle to carry an icon the way a macOS .app does. It goes beside the
  # asar, not inside it: the notification daemon reads the icon as a real file path.
  #
  # Prefer the 256px render over the 1024px source: Electron sends the icon to the
  # notification daemon as raw pixels (an image-data hint), so a full-size original means
  # pushing 4MB of uncompressed RGBA across the bus for every single notification.
  if [ -f "$ICONS_DIR/256x256/apps/$slug.png" ]; then
    cp "$ICONS_DIR/256x256/apps/$slug.png" "$staged/resources/app-icon.png"
  else
    cp "$png" "$staged/resources/app-icon.png"
  fi

  mkdir -p "$PREFIX/lib/$slug"
  cp -R "$staged/." "$PREFIX/lib/$slug/"
  ln -sfn "$PREFIX/lib/$slug/$slug" "$PREFIX/bin/$slug"

  cat > "$APPS_DIR/$slug.desktop" <<EOF
[Desktop Entry]
Type=Application
Version=1.1
Name=$name
Comment=$name as a standalone app
Exec=$PREFIX/lib/$slug/$slug %U
Icon=$slug
Terminal=false
Categories=$categories
StartupNotify=true
StartupWMClass=$slug
EOF
  chmod 644 "$APPS_DIR/$slug.desktop"
  echo "    installed: $PREFIX/lib/$slug  (launch: $slug)"
done

rm -rf build app-config.json
restore_pkg
trap - EXIT INT TERM HUP PIPE
refresh_caches

first_slug="$(slugify "$(_entry_name "${SELECTED[0]}")")"
echo "==> Done. Launch from your app menu, or run e.g. '$first_slug' from a shell."
case ":$PATH:" in
  *":$PREFIX/bin:"*) ;;
  *) echo "    note: $PREFIX/bin is not on your PATH — add it to launch from a shell." ;;
esac
