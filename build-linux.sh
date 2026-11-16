#!/usr/bin/env bash
# Build & install the standalone web apps on Linux. Which apps is up to you — see
# services.conf for the full set, or run --list. Nothing here is Google-specific; the
# bundled set just happens to be mostly Google's.
#
# Usage:  ./build-linux.sh                  # pick from a menu (all, if not run in a terminal)
#         ./build-linux.sh gmail keep       # just those; name by short key, slug or full name
#         ./build-linux.sh --all            # everything, no prompt
#         ./build-linux.sh --list           # show what's available
#         ./build-linux.sh --uninstall      # remove everything this installed
#         ./build-linux.sh --uninstall keep # remove just those
#         PREFIX=~/.local ./build-linux.sh
#         ARCH=x64 ./build-linux.sh         # only an arch castlabs publishes for the pin
#         ICON_THEME=Papirus-Dark ./build-linux.sh   # default: whatever this machine uses
#
# Requires: node + npm, curl, python3, unzip — checked first, and offered for install if missing
# (prereqs.sh). ImageMagick or python3-Pillow is used to build the icon-size
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

# shellcheck disable=SC1091  # path is $DIR-relative, resolved at run time
. "$DIR/services.conf"
# Provides slugify(), list_services() and resolve_services() — shared with build.sh so the
# two installers can't disagree about what an app is called.
# shellcheck disable=SC1091
. "$DIR/select-services.sh"
# ensure_prereqs(): what the build and the apps need, offered for install if missing.
# shellcheck disable=SC1091
. "$DIR/prereqs.sh"

# A relative PREFIX would land a relative Exec= in the .desktop file, which the desktop
# cannot launch. Require absolute before any path is derived from it.
case "$PREFIX" in
  /*) ;;
  *) echo "PREFIX must be an absolute path: $PREFIX" >&2; exit 1 ;;
esac

# Optional `env VAR=value ...` prefix for the .desktop Exec line, so launches from the app
# menu carry settings (the memory controls, for example). Written into a desktop entry, so
# reject the characters that would break that line.
EXEC_ENV=""
if [ -n "${ELECTRON_APPS_EXEC_ENV:-}" ]; then
  case "$ELECTRON_APPS_EXEC_ENV" in
    *$'\n'*|*$'\r'*|*%*)
      echo "ELECTRON_APPS_EXEC_ENV must not contain a newline, CR or '%'" >&2
      exit 1
      ;;
  esac
  # Desktop entries have no inline `VAR=value command` form: the assignments must be
  # executed, so write them through `env`.
  EXEC_ENV="env $ELECTRON_APPS_EXEC_ENV "
fi

APPS_DIR="$PREFIX/share/applications"
ICONS_DIR="$PREFIX/share/icons/hicolor"

uninstall_one() {
  local slug="$1"
  # An empty slug turns the removals below into "$PREFIX/lib/", "$PREFIX/bin/" and so on,
  # i.e. every installed app. Names in services.conf always yield one, but a malformed
  # argument must fail rather than take the whole install with it.
  [ -n "$slug" ] || { echo "    refusing to uninstall: empty app slug" >&2; return 1; }
  rm -rf "$PREFIX/lib/${slug:?}" "$PREFIX/lib/.${slug:?}.new" "$PREFIX/lib/.${slug:?}.old"
  rm -f  "$PREFIX/bin/$slug" "$APPS_DIR/$slug.desktop"
  find "$ICONS_DIR" -name "$slug.png" -delete 2>/dev/null || true
}

refresh_caches() {
  command -v update-desktop-database >/dev/null && update-desktop-database "$APPS_DIR" 2>/dev/null || true
  command -v gtk-update-icon-cache   >/dev/null && gtk-update-icon-cache -qtf "$ICONS_DIR" 2>/dev/null || true
}

usage() { sed -n '2,15p' "$DIR/$(basename "${BASH_SOURCE[0]}")" | sed 's/^# \{0,1\}//'; }

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

# Before anything that needs node, curl or python3 — and after the --list/--uninstall exits,
# which must keep working on a machine that has none of them.
ensure_prereqs

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

# The machine's icon theme, so an installed app can use the icon the user's theme provides
# for it rather than the art bundled here. GNOME keeps it in gsettings; KDE in kdeglobals.
# hicolor is the spec's mandatory fallback and is what "no answer" means.
icon_theme_name() {
  local t=""
  if command -v gsettings >/dev/null 2>&1; then
    t="$(gsettings get org.gnome.desktop.interface icon-theme 2>/dev/null | tr -d "'" || true)"
  fi
  if [ -z "$t" ] && [ -f "$HOME/.config/kdeglobals" ]; then
    t="$(sed -n 's/^Theme=//p' "$HOME/.config/kdeglobals" 2>/dev/null | head -1 || true)"
  fi
  [ -n "$t" ] && echo "$t" || echo hicolor
}

# Print the file the icon theme (or anything it inherits) offers for <name>, or nothing.
# Implements the freedesktop lookup well enough for app icons: search the theme, then its
# Inherits chain, then hicolor, preferring scalable SVG and otherwise the largest raster.
resolve_themed_icon() {
  python3 - "$1" "$2" <<'PY' 2>/dev/null || true
import os, re, sys
from configparser import RawConfigParser

name, theme = sys.argv[1], sys.argv[2]

def icon_dirs():
    out, seen = [], set()
    home = os.environ.get('XDG_DATA_HOME') or os.path.expanduser('~/.local/share')
    cands = [os.path.join(home, 'icons'), os.path.expanduser('~/.icons')]
    for d in (os.environ.get('XDG_DATA_DIRS') or '/usr/local/share:/usr/share').split(':'):
        if d:
            cands.append(os.path.join(d, 'icons'))
    for d in cands:
        if os.path.isdir(d) and d not in seen:
            seen.add(d)
            out.append(d)
    return out

DIRS = icon_dirs()

def inherits(t):
    for d in DIRS:
        idx = os.path.join(d, t, 'index.theme')
        if os.path.isfile(idx):
            cp = RawConfigParser(strict=False)
            try:
                cp.read(idx, encoding='utf-8')
            except Exception:
                continue
            if cp.has_option('Icon Theme', 'Inherits'):
                return [x.strip() for x in cp.get('Icon Theme', 'Inherits').split(',') if x.strip()]
    return []

# Breadth-first through the inheritance graph; hicolor last, as the spec requires.
order, queue, seen = [], [theme], set()
while queue:
    t = queue.pop(0)
    if t in seen:
        continue
    seen.add(t)
    order.append(t)
    queue.extend(inherits(t))
if 'hicolor' not in order:
    order.append('hicolor')

def declared_dirs(t):
    """The subdirectories a theme says it has, with each one's size and type.

    Reading index.theme rather than walking the tree is not just faster, it is the only
    thing that works: themes routinely symlink a subdirectory into a sibling theme
    (Colloid-Dark/apps/scalable -> ../../Colloid-Light/apps/scalable), and os.walk does
    not follow symlinks, so a walk silently misses those icons and falls through to
    hicolor -- the exact opposite of what the desktop resolves.
    """
    for d in DIRS:
        idx = os.path.join(d, t, 'index.theme')
        if not os.path.isfile(idx):
            continue
        cp = RawConfigParser(strict=False)
        try:
            cp.read(idx, encoding='utf-8')
        except Exception:
            continue
        subs = []
        for key in ('Directories', 'ScaledDirectories'):
            if cp.has_option('Icon Theme', key):
                subs += [x.strip() for x in cp.get('Icon Theme', key).split(',') if x.strip()]
        info = {}
        for sub in subs:
            size, typ = 0, 'Threshold'
            if cp.has_section(sub):
                try:
                    size = cp.getint(sub, 'Size', fallback=0)
                except Exception:
                    size = 0
                typ = cp.get(sub, 'Type', fallback='Threshold')
            info[sub] = (size, typ)
        return subs, info
    return [], {}

def walked_dirs(root):
    """Fallback for a theme with no usable index.theme: look at what is actually there."""
    subs, seen = [], set()
    for dirpath, _, _ in os.walk(root, followlinks=True):
        real = os.path.realpath(dirpath)
        if real in seen:          # a self-referential symlink would otherwise spin forever
            continue
        seen.add(real)
        rel = os.path.relpath(dirpath, root)
        subs.append('' if rel == '.' else rel)
    return subs

for t in order:
    subs, info = declared_dirs(t)
    best, best_score = None, -1
    for d in DIRS:
        root = os.path.join(d, t)
        if not os.path.isdir(root):
            continue
        for sub in (subs or walked_dirs(root)):
            size, typ = info.get(sub, (0, 'Threshold'))
            if not size:
                m = re.search(r'(\d+)x\1', sub)
                size = int(m.group(1)) if m else 0
            for ext in ('.svg', '.png'):
                p = os.path.join(root, sub, name + ext)
                if not os.path.isfile(p):
                    continue
                # Scalable beats any bitmap: we re-render to 256px anyway, so vector is
                # strictly better than whatever fixed size the theme happens to ship.
                s = 10_000 if (ext == '.svg' or typ == 'Scalable') else size
                if s > best_score:
                    best, best_score = p, s
    # First theme in the chain that has it wins -- that is what the desktop will show.
    # The theme is reported alongside the path because the winner is often NOT the theme
    # asked for: the chain ends at hicolor, where this installer put its own icons, and
    # crediting the user's theme for those would be a lie.
    if best:
        print(t + '|' + best)
        break
PY
}

# Render <src> (SVG or raster) to a <size>px PNG at <dst>. Returns non-zero if nothing on
# this machine can do the conversion, so callers can fall back to the bundled art.
render_icon() {
  local src="$1" dst="$2" size="$3" im
  if command -v magick >/dev/null 2>&1 || command -v convert >/dev/null 2>&1; then
    im="$(command -v magick || command -v convert)"
    # -background none keeps SVG transparency; harmless for raster sources.
    "$im" -background none "$src" -resize "${size}x${size}" "$dst" 2>/dev/null && return 0
  fi
  case "$src" in
    *.svg)
      command -v rsvg-convert >/dev/null 2>&1 &&
        rsvg-convert -w "$size" -h "$size" -o "$dst" "$src" 2>/dev/null && return 0
      ;;
    *)
      python3 - "$src" "$dst" "$size" <<'PY' 2>/dev/null && return 0
import sys
from PIL import Image
src, dst, size = sys.argv[1], sys.argv[2], int(sys.argv[3])
Image.open(src).convert('RGBA').resize((size, size), Image.LANCZOS).save(dst)
PY
      ;;
  esac
  return 1
}

# Install <src png> as the themed icon <slug>, at every size the desktop looks for.
# ImageMagick or Pillow does the downscaling. If ImageMagick is present but cannot convert,
# fall through to Pillow rather than aborting under `set -e`; with neither, install the
# source unchanged in scalable/, which does not claim a size the source does not have.
install_icons() {
  local src="$1" slug="$2" size
  local sizes="16 24 32 48 64 128 256 512"
  if command -v magick >/dev/null 2>&1 || command -v convert >/dev/null 2>&1; then
    local im ok=1
    im="$(command -v magick || command -v convert)"
    for size in $sizes; do
      mkdir -p "$ICONS_DIR/${size}x${size}/apps"
      "$im" "$src" -resize "${size}x${size}" \
        "$ICONS_DIR/${size}x${size}/apps/$slug.png" 2>/dev/null || { ok=0; break; }
    done
    if [ "$ok" = 1 ]; then return 0; fi
    echo "    note: ImageMagick could not resize $src — trying Pillow" >&2
  fi
  if python3 -c 'import PIL' >/dev/null 2>&1; then
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
    return 0
  fi
  # Neither backend: no way to build the size ladder. scalable/ is what the theme scales on
  # demand; the old fallback copied the full-size source into 512x512/apps, advertising it
  # as 512x512 when it is some other size.
  echo "    note: no ImageMagick/Pillow — installing the source icon unscaled (scalable/)"
  mkdir -p "$ICONS_DIR/scalable/apps"
  cp "$src" "$ICONS_DIR/scalable/apps/$slug.png"
}

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
# (electron-v42.8.0+wvcus-linux-x64.zip), while the checksum file stays at the
# ordinary SHASUMS256.txt path. ELECTRON_CUSTOM_FILENAME applies to EVERY download
# @electron/get makes — pointing it at the +wvcus zip makes @electron/get fetch the
# zip when it wanted SHASUMS256 and choke on the binary — so there is no combination
# of ELECTRON_CUSTOM_* vars that gets both requests right. Bypass the whole path:
# fetch the castlabs zip once ourselves, stage it under the plain-version name that
# packager expects, and pass --electron-zip-dir. That skips @electron/get's download
# and checksum steps, so this script verifies the archive against the checksums the
# electron package publishes (node_modules/electron/checksums.json) before staging it.
#
# Runs AFTER argparse and after the --uninstall exit above, deliberately: --list,
# --help and --uninstall must not require node or network, and the earlier revision
# of this block sat at the top of the file where every invocation paid for it
# whether it needed to build anything or not.
# The Electron pin MUST be the castlabs fork: stock Electron ships no Widevine CDM. A plain
# registry version here would silently replace it, so fail with a sentence rather than the
# TypeError a naive split('#v') throws when package.json has any other shape.
ELECTRON_VER="$(node -e '
const pin = (require("./package.json").devDependencies || {}).electron || "";
const m = /^github:castlabs\/electron-releases#v([^+]+)\+wvcus$/.exec(pin);
if (!m) {
  console.error("package.json must pin electron to the castlabs fork, e.g. " +
    "\"electron\": \"github:castlabs/electron-releases#v42.8.0+wvcus\"; found: " + JSON.stringify(pin));
  process.exit(1);
}
process.stdout.write(m[1]);
')" || { echo "==> Could not read the castlabs Electron pin from package.json." >&2; exit 1; }
ELECTRON_ZIP_DIR="${ELECTRON_ZIP_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/electron-apps}"
mkdir -p "$ELECTRON_ZIP_DIR"
# The cache used to be keyed "linux-google-apps", which was wrong twice over: this project
# is not Google-specific, and build.sh used the same Linux-flavoured name on macOS. Adopt
# anything already downloaded under the old name rather than making the first rebuild after
# the rename re-fetch ~100 MB of Electron.
LEGACY_ZIP_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/linux-google-apps"
if [ -d "$LEGACY_ZIP_DIR" ] && [ "$LEGACY_ZIP_DIR" != "$ELECTRON_ZIP_DIR" ]; then
  for legacy in "$LEGACY_ZIP_DIR"/*.zip; do
    [ -s "$legacy" ] || continue
    [ -s "$ELECTRON_ZIP_DIR/$(basename "$legacy")" ] || mv "$legacy" "$ELECTRON_ZIP_DIR/"
  done
  rmdir "$LEGACY_ZIP_DIR" 2>/dev/null || true
fi
# --electron-zip-dir looks up the file under the electron version @electron/packager
# reads from node_modules/electron/package.json, and castlabs publishes that as
# "42.8.0+wvcus" — so the on-disk name MUST carry the +wvcus suffix; without it
# packager reports "The specified Electron ZIP file does not exist" and the build
# stops. The zip's URL basename already carries the same suffix, so download and
# lookup names cannot drift.
STAGED_ZIP="$ELECTRON_ZIP_DIR/electron-v${ELECTRON_VER}+wvcus-linux-${ARCH}.zip"
CHECKSUMS="$DIR/node_modules/electron/checksums.json"
zip_name="electron-v${ELECTRON_VER}+wvcus-linux-${ARCH}.zip"

# Refuse an arch the pinned release does not publish BEFORE downloading ~100 MB. castlabs
# publishes linux-x64 only for this pin; arm64/armv7l would otherwise be discovered only
# after the whole archive had been fetched.
if [ -f "$CHECKSUMS" ] && ! node -e 'const c=require(process.argv[1]); process.exit(c[process.argv[2]] ? 0 : 1)' "$CHECKSUMS" "$zip_name"; then
  echo "    Electron $ELECTRON_VER+wvcus does not publish $zip_name." >&2
  echo "    Available: $(node -e 'const c=require(process.argv[1]); process.stdout.write(Object.keys(c).filter(k => k.indexOf(process.argv[2]) !== -1 && /\.zip$/.test(k)).join(" "))' "$CHECKSUMS" "+wvcus-linux-")" >&2
  exit 1
fi

# Integrity of an archive, cached or freshly downloaded.
verify_zip() {
  local f="$1" expected actual
  unzip -tq "$f" >/dev/null 2>&1 || return 1
  [ -f "$CHECKSUMS" ] || return 0
  expected="$(node -e 'const c=require(process.argv[1]); process.stdout.write(c[process.argv[2]] || "")' "$CHECKSUMS" "$zip_name")"
  [ -n "$expected" ] || return 1
  actual="$(node -e 'const c=require("crypto"),f=require("fs"); process.stdout.write(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex"))' "$f")"
  [ "$actual" = "$expected" ]
}

# Verify a cache hit too: an older script (or a mirror answering 200 with an error page)
# could have staged something unusable, and file size alone cannot tell. A failed check
# discards the cache and downloads afresh.
if [ -s "$STAGED_ZIP" ] && ! verify_zip "$STAGED_ZIP"; then
  echo "    cached Electron archive failed verification — discarding it"
  rm -f "$STAGED_ZIP"
fi
if [ ! -s "$STAGED_ZIP" ]; then
  # ELECTRON_ZIP_URL fully overrides for an internal mirror; ELECTRON_MIRROR still works as
  # the base if someone had already set it. A mirror is a BASE URL, so join it with exactly
  # one slash whether or not it was given one.
  MIRROR="${ELECTRON_MIRROR:-https://github.com/castlabs/electron-releases/releases/download/}"
  URL="${ELECTRON_ZIP_URL:-${MIRROR%/}/v${ELECTRON_VER}+wvcus/electron-v${ELECTRON_VER}+wvcus-linux-${ARCH}.zip}"
  echo "==> Downloading Electron $ELECTRON_VER+wvcus (linux-$ARCH)"
  part="$(mktemp "$ELECTRON_ZIP_DIR/.dl.XXXXXX")"
  trap 'rm -f "$part"' EXIT
  # --proto '=https' plus --tlsv1.2 keeps a mirror or redirect from silently downgrading
  # the transport the archive is fetched over.
  trap 'rm -f "$part"; exit 130' INT TERM HUP PIPE
  curl -fSL --proto '=https' --tlsv1.2 --retry 3 -o "$part" "$URL"
  # A truncated download, or an HTML error page saved under a .zip name, must never be
  # staged as if it were a usable Electron build.
  if ! verify_zip "$part"; then
    echo "    downloaded archive failed integrity/checksum verification" >&2
    rm -f "$part"
    exit 1
  fi
  mv "$part" "$STAGED_ZIP"
  trap - EXIT INT TERM HUP PIPE
fi

# Each app needs its OWN X11 WM_CLASS / Wayland app_id, or the desktop treats all four as
# one application: they share a single icon in the dash, group together in alt-tab, and
# only one .desktop file can ever match. Electron derives it from package.json's
# productName (lowercased) — NOT from the executable name, and NOT from app.setName() or
# Chromium's --class switch, both of which are applied too late to affect it. So the value
# has to be baked in per service at package time. The working tree is restored on any exit,
# including Ctrl-C, so an interrupted build never leaves package.json rewritten.
# Two concurrent runs would rewrite the same package.json/app-config.json/build/ and could
# package one service with another's productName. Serialise them. The lock is created only
# now, after the read-only prerequisite and download phases.
BUILD_LOCK="$DIR/.build-lock"
if ! mkdir "$BUILD_LOCK" 2>/dev/null; then
  echo "Another build is running (or stale $BUILD_LOCK exists). Remove it if no build is active." >&2
  exit 1
fi

PKG_BACKUP="$(mktemp)"
cp package.json "$PKG_BACKUP"
# One EXIT handler for both kinds of damage a failed run leaves behind: a package.json with
# a per-service productName baked in, and a half-written build/ or app-config.json. Folding
# the scratch cleanup in here is what makes an aborted `set -e` run clean up after itself;
# previously those were only removed on the success path.
cleanup() {
  rm -rf "$DIR/build" "$DIR/app-config.json"
  if [ -f "$PKG_BACKUP" ]; then cp "$PKG_BACKUP" package.json; rm -f "$PKG_BACKUP"; fi
  rmdir "$BUILD_LOCK" 2>/dev/null || true
}
# HUP/PIPE matter as much as INT/TERM here: piping this script's output to something that
# exits early (`./build-linux.sh | head`) kills it with SIGPIPE. The handler must also EXIT:
# a trap that only restores and returns lets bash resume the build, so `kill`/`| head` would
# carry on building and report success.
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM
trap 'cleanup; exit 129' HUP
trap 'cleanup; exit 141' PIPE

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

# Whatever icon theme THIS machine is set to — read at install time, never assumed. Export
# ICON_THEME to build against a different one (useful when installing for another user's
# setup, or to check what a theme would look like without switching to it).
# Resolved once: the theme cannot change halfway through a build.
ICON_THEME="${ICON_THEME:-$(icon_theme_name)}"
echo "==> Icon theme: $ICON_THEME"

for entry in "${SELECTED[@]}"; do
  # Reject CRLF-sourced entries: `read -r` keeps the CR in the last field, which would
  # silently break `single`/`drm` detection and write a broken .desktop line.
  case "$entry" in
    *$'\r'*) echo "    services.conf contains CR characters (CRLF endings); convert it to LF" >&2; exit 1 ;;
  esac
  # shellcheck disable=SC2034  # bundle-id is macOS-only; parsed but unused on Linux
  IFS='|' read -r name icon url bid categories related drm paths handlers single <<< "$entry"
  slug="$(slugify "$name")"
  # An all-punctuation display name slugifies to nothing; installing under "$PREFIX/lib/"
  # would then collide with the app tree itself. Refuse before any path is built. A name
  # beginning with '-' would also be parsed by electron-packager as an option.
  [ -n "$slug" ] || { echo "    cannot derive a slug from '$name' — use ASCII letters/digits"; exit 1; }
  case "$name" in -*) echo "    service name may not start with '-': $name" >&2; exit 1 ;; esac
  echo "==> Building $name"

  png="$DIR/icons/png/$icon.png"
  icns="$DIR/icons/$icon.icns"
  # The .icns is the source of truth. Re-extract whenever it exists (not only when it looks
  # newer): git does not preserve mtimes, so a fresh clone gives both files the same stamp
  # and a stale committed PNG would silently win. The cmp guard means an unchanged icon
  # leaves no working-tree change.
  if [ ! -f "$png" ] || [ -f "$icns" ]; then
    [ -f "$icns" ] || { echo "    missing icons/$icon.icns and icons/png/$icon.png"; exit 1; }
    echo "    extracting icons/png/$icon.png from $icns"
    # Extract to a temporary file and copy only on a real difference: re-extracting an
    # unchanged icon should not leave a spurious working-tree change after every build.
    tmp_png="$(mktemp "$DIR/icons/png/.$icon.XXXXXX")"
    extract_icns_png "$icns" "$tmp_png"
    if [ -f "$png" ] && cmp -s "$tmp_png" "$png"; then
      rm -f "$tmp_png"
    else
      mv "$tmp_png" "$png"
    fi
  fi

  # slug travels into the app so main.js can find styles/<slug>.css without re-deriving it.
  # drm is a plain boolean the runtime reads to decide whether to wait on Widevine.
  # paths is a comma/space-separated URL-path allowlist for services tenanted inside a
  # larger site (see services.conf); empty for the common case where the app owns its
  # whole domain. handlers maps link schemes this app takes over (mailto: for Gmail).
  python3 -c "import json,sys; json.dump({'name':sys.argv[1],'url':sys.argv[2],'slug':sys.argv[3],'related':sys.argv[4],'drm':sys.argv[5]=='1','paths':sys.argv[6],'handlers':sys.argv[7],'single':sys.argv[8]=='1'}, open('app-config.json','w'))" "$name" "$url" "$slug" "${related:-}" "${drm:-}" "${paths:-}" "${handlers:-}" "${single:-}"
  # Becomes this app's WM_CLASS (see above); StartupWMClass in the .desktop file matches it.
  set_product_name "$slug"

  # --executable-name pins the binary name (and with it the WM_CLASS the .desktop file
  # below matches on); without it the binary would be "Google Calendar", spaces and all.
  npx electron-packager . "$name" --platform=linux --arch="$ARCH" \
    --executable-name="$slug" --app-version=1.0.0 \
    --electron-zip-dir="$ELECTRON_ZIP_DIR" \
    "${IGNORE_FLAGS[@]}" \
    --out="$DIR/build" --overwrite >/dev/null

  staged="$DIR/build/$name-linux-$ARCH"
  install_icons "$png" "$slug"

  # main.js picks this up for window/taskbar icons and notification banners — a Linux
  # binary has no bundle to carry an icon the way a macOS .app does. It goes beside the
  # asar, not inside it: the notification daemon reads the icon as a real file path.
  #
  # Prefer the 256px render over the 1024px source: Electron sends the icon to the
  # notification daemon as raw pixels (an image-data hint), so a full-size original means
  # pushing 4MB of uncompressed RGBA across the bus for every single notification.
  #
  # And prefer the ICON THEME's version of this app over the art bundled here, when the
  # user's theme offers one. The .desktop file already gets this for free — `Icon=<slug>`
  # is a name, which the desktop resolves through the active theme — but this file is a
  # path handed straight to Electron, so it would otherwise be the one place the app
  # ignores the theme and showed bundled art in every notification banner.
  #
  # Note this only reads the theme; the hicolor install above is left alone deliberately.
  # hicolor is the spec's fallback, so our own icon must stay there for the case where the
  # user later switches to a theme that has never heard of these apps.
  themed="" themed_theme=""
  if [ "$ICON_THEME" != "hicolor" ]; then
    found="$(resolve_themed_icon "$slug" "$ICON_THEME")"
    if [ -n "$found" ]; then
      themed_theme="${found%%|*}"
      themed="${found#*|}"
    fi
  fi
  if [ -n "$themed" ] && render_icon "$themed" "$staged/resources/app-icon.png" 256; then
    echo "    icon: $themed_theme (${themed##*/})"
  elif [ -f "$ICONS_DIR/256x256/apps/$slug.png" ]; then
    [ -n "$themed" ] && echo "    note: found $themed but could not render it — using the bundled icon"
    cp "$ICONS_DIR/256x256/apps/$slug.png" "$staged/resources/app-icon.png"
  else
    cp "$png" "$staged/resources/app-icon.png"
  fi

  # Install by swap: copy the new build beside the old one first, then move the old one
  # aside only once the copy has succeeded. Removing the old install up front (what
  # uninstall_one used to do here) loses the app entirely if the copy then fails.
  stage_dir="$PREFIX/lib/.$slug.new"
  old_dir="$PREFIX/lib/.$slug.old"
  rm -rf "$stage_dir"
  cp -R "$staged" "$stage_dir"
  # Only now is it safe to drop any backup left by an earlier interrupted run.
  rm -rf "$old_dir"
  if [ -e "$PREFIX/lib/$slug" ]; then mv "$PREFIX/lib/$slug" "$old_dir"; fi
  mv "$stage_dir" "$PREFIX/lib/$slug"
  rm -rf "$old_dir"
  ln -sfn "$PREFIX/lib/$slug/$slug" "$PREFIX/bin/$slug"

  # StartupNotify=false: Electron never completes a launch's startup sequence. On Wayland the
  # shell hands it XDG_ACTIVATION_TOKEN and Electron ignores it (also as --xdg-activation-token),
  # minting a token of its own for the first window instead — measured with WAYLAND_DEBUG=1.
  # GNOME then shows a busy cursor for the whole startup timeout, or until focus moves.
  # A newline cannot exist in a desktop entry (it ends the line), and '%' starts a field
  # code in Exec. Reject either in the values interpolated below rather than write a broken
  # file that the desktop silently ignores.
  for _v in "$PREFIX" "$name"; do
    case "$_v" in
      *$'\n'*|*$'\r'*) echo "    PREFIX or app name contains a newline/CR, which a .desktop entry cannot represent" >&2; exit 1 ;;
      *%*)     echo "    PREFIX or app name contains '%', which Exec reserves for field codes" >&2; exit 1 ;;
    esac
  done
  unset _v
  # The spec's Exec quoting: wrap the argument in double quotes and precede each '"', '`',
  # '$' and '\' with an extra backslash. Written with printf, not a heredoc, so those
  # backslashes survive instead of being consumed as heredoc escapes.
  exec_path="$PREFIX/lib/$slug/$slug"
  # shellcheck disable=SC2016  # sed expressions are intentionally single-quoted
  exec_q="\"$(printf '%s' "$exec_path" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/`/\\`/g' -e 's/\$/\\$/g')\""
  {
    printf '[Desktop Entry]\n'
    printf 'Type=Application\n'
    printf 'Version=1.1\n'
    printf 'Name=%s\n' "$name"
    printf 'Comment=%s as a standalone app\n' "$name"
    printf 'Exec=%s%s %%U\n' "$EXEC_ENV" "$exec_q"
    printf 'Icon=%s\n' "$slug"
    printf 'Terminal=false\n'
    printf 'Categories=%s\n' "$categories"
    printf 'StartupNotify=false\n'
    printf 'StartupWMClass=%s\n' "$slug"
  } > "$APPS_DIR/$slug.desktop"
  # Declaring a scheme makes the app a CANDIDATE handler; it does not make it the default.
  # That stays the user's choice: gio mime x-scheme-handler/mailto gmail.desktop
  mimes="$(printf '%s' "${handlers:-}" | tr ',' '\n' \
    | sed -n 's/^[[:space:]]*\([A-Za-z][A-Za-z0-9+.-]*\)[[:space:]]*=.*/x-scheme-handler\/\1;/p' | tr -d '\n')"
  [ -n "$mimes" ] && echo "MimeType=$mimes" >> "$APPS_DIR/$slug.desktop"
  chmod 644 "$APPS_DIR/$slug.desktop"
  echo "    installed: $PREFIX/lib/$slug  (launch: $slug)"
done

cleanup
trap - EXIT INT TERM HUP PIPE
refresh_caches

first_slug="$(slugify "$(_entry_name "${SELECTED[0]}")")"
echo "==> Done. Launch from your app menu, or run e.g. '$first_slug' from a shell."
case ":$PATH:" in
  *":$PREFIX/bin:"*) ;;
  *) echo "    note: $PREFIX/bin is not on your PATH — add it to launch from a shell." ;;
esac
