#!/usr/bin/env bash
# Rebuild & install the standalone web apps. Which apps is up to you — see
# services.conf for the full set, or run --list. Nothing here is Google-specific; the
# bundled set just happens to be mostly Google's.
#
# Usage:  ./build.sh                 # pick from a menu (all, if not run in a terminal)
#         ./build.sh gmail keep      # just those; name by short key, slug or full name
#         ./build.sh --all           # everything, no prompt
#         ./build.sh --list          # show what's available
#
# Installs to ~/Applications and ad-hoc signs each app.
# Requires: node + npm, curl, python3 — checked first, and offered for install through
# Homebrew if missing (prereqs.sh).
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

# This script builds macOS .app bundles. On Linux the packaging, install layout and
# desktop integration are entirely different, so hand off to the Linux builder. Run it
# rather than exec-ing it, so this script exits through its normal path with its status.
if [ "$(uname -s)" != "Darwin" ]; then
  bash "$DIR/build-linux.sh" "$@"
  exit $?
fi

# Build for the host architecture so the apps run natively on Apple Silicon (arm64)
# or Intel (x86_64 -> x64). Only those two are supported: the Electron zip is fetched for
# ARCH below, and a universal build would need both a darwin-x64 and a darwin-arm64
# download, which this script does not do.
ARCH="${ARCH:-$([ "$(uname -m)" = "x86_64" ] && echo x64 || echo arm64)}"
case "$ARCH" in
  x86_64|amd64) ARCH=x64 ;;
  aarch64)      ARCH=arm64 ;;
  x64|arm64)    ;;
  *) echo "Unsupported ARCH=$ARCH (supported: x64, arm64; universal is not published)" >&2; exit 1 ;;
esac

# shellcheck disable=SC1091  # path is $DIR-relative, resolved at run time
. "$DIR/services.conf"
# Shared with build-linux.sh so both installers agree on what an app can be called.
# shellcheck disable=SC1091
. "$DIR/select-services.sh"
# ensure_prereqs(): what the build and the apps need, offered for install if missing.
# shellcheck disable=SC1091
. "$DIR/prereqs.sh"

usage() { sed -n '2,13p' "$DIR/$(basename "${BASH_SOURCE[0]}")" | sed 's/^# \{0,1\}//'; }

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

# Before anything that needs node, curl or python3 — and after the --list/--uninstall exits,
# which must keep working on a machine that has none of them.
ensure_prereqs

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
# and checksum steps, so this script verifies the archive against the checksums the
# electron package publishes (node_modules/electron/checksums.json) before staging it.
#
# Runs AFTER argparse, deliberately: --list and --help must not require node or
# network, and the earlier revision of this block sat at the top of the file where
# every invocation paid for it whether it needed to build anything or not.
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
ELECTRON_ZIP_DIR="${ELECTRON_ZIP_DIR:-${XDG_CACHE_HOME:-$HOME/Library/Caches}/electron-apps}"
mkdir -p "$ELECTRON_ZIP_DIR"
# See build-linux.sh: the cache used to be keyed "linux-google-apps" — a Linux-flavoured
# name for a project that is not Google-specific, used verbatim here on macOS. Adopt an
# existing download rather than re-fetching ~100 MB after the rename.
LEGACY_ZIP_DIR="${XDG_CACHE_HOME:-$HOME/Library/Caches}/linux-google-apps"
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
STAGED_ZIP="$ELECTRON_ZIP_DIR/electron-v${ELECTRON_VER}+wvcus-darwin-${ARCH}.zip"
CHECKSUMS="$DIR/node_modules/electron/checksums.json"
zip_name="electron-v${ELECTRON_VER}+wvcus-darwin-${ARCH}.zip"

# Refuse an arch the pinned release does not publish BEFORE downloading ~100 MB.
if [ -f "$CHECKSUMS" ] && ! node -e 'const c=require(process.argv[1]); process.exit(c[process.argv[2]] ? 0 : 1)' "$CHECKSUMS" "$zip_name"; then
  echo "    Electron $ELECTRON_VER+wvcus does not publish $zip_name." >&2
  echo "    Available: $(node -e 'const c=require(process.argv[1]); process.stdout.write(Object.keys(c).filter(k => k.indexOf(process.argv[2]) !== -1 && /\.zip$/.test(k)).join(" "))' "$CHECKSUMS" "+wvcus-darwin-")" >&2
  exit 1
fi

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
# could have staged something unusable, and file size alone cannot tell.
if [ -s "$STAGED_ZIP" ] && ! verify_zip "$STAGED_ZIP"; then
  echo "    cached Electron archive failed verification — discarding it"
  rm -f "$STAGED_ZIP"
fi
if [ ! -s "$STAGED_ZIP" ]; then
  # ELECTRON_ZIP_URL fully overrides; ELECTRON_MIRROR is a BASE URL, so join with exactly
  # one slash.
  MIRROR="${ELECTRON_MIRROR:-https://github.com/castlabs/electron-releases/releases/download/}"
  URL="${ELECTRON_ZIP_URL:-${MIRROR%/}/v${ELECTRON_VER}+wvcus/electron-v${ELECTRON_VER}+wvcus-darwin-${ARCH}.zip}"
  echo "==> Downloading Electron $ELECTRON_VER+wvcus (darwin-$ARCH)"
  part="$(mktemp "$ELECTRON_ZIP_DIR/.dl.XXXXXX")"
  trap 'rm -f "$part"' EXIT
  trap 'rm -f "$part"; exit 130' INT TERM HUP PIPE
  curl -fSL --proto '=https' --tlsv1.2 --retry 3 -o "$part" "$URL"
  if ! verify_zip "$part"; then
    echo "    downloaded archive failed integrity/checksum verification" >&2
    rm -f "$part"
    exit 1
  fi
  mv "$part" "$STAGED_ZIP"
  trap - EXIT INT TERM HUP PIPE
fi

# Two concurrent runs would rewrite the same package.json/app-config.json/build/. Serialise.
BUILD_LOCK="$DIR/.build-lock"
if ! mkdir "$BUILD_LOCK" 2>/dev/null; then
  echo "Another build is running (or stale $BUILD_LOCK exists). Remove it if no build is active." >&2
  exit 1
fi

# build/ and app-config.json are this run's scratch output. Clean them from the trap so a
# `set -e` abort partway through the loop removes them too. The handler must EXIT: a trap
# that only restores and returns lets bash resume the build after SIGTERM/SIGPIPE.
cleanup_build() { rm -rf "$DIR/build" "$DIR/app-config.json"; rmdir "$BUILD_LOCK" 2>/dev/null || true; }
trap cleanup_build EXIT
trap 'cleanup_build; exit 130' INT
trap 'cleanup_build; exit 143' TERM
trap 'cleanup_build; exit 129' HUP
trap 'cleanup_build; exit 141' PIPE
rm -rf "$DIR/build" "$DIR/app-config.json"
mkdir -p "$DIR/build"
for entry in "${SELECTED[@]}"; do
  case "$entry" in
    *$'\r'*) echo "    services.conf contains CR characters (CRLF endings); convert it to LF" >&2; exit 1 ;;
  esac
  # shellcheck disable=SC2034  # freedesktop categories are Linux-only; parsed but unused on macOS
  IFS='|' read -r name icon url bid categories related drm paths handlers single <<< "$entry"
  case "$name" in -*) echo "    service name may not start with '-': $name" >&2; exit 1 ;; esac
  echo "==> Building $name"
  # slug travels into the app so main.js can find styles/<slug>.css without re-deriving it.
  # drm is a plain boolean the runtime reads to decide whether to wait on Widevine.
  # paths is a comma/space-separated URL-path allowlist for services tenanted inside a
  # larger site (see services.conf); empty for the common case where the app owns its
  # whole domain. handlers maps link schemes this app takes over (mailto: for Gmail).
  slug="$(slugify "$name")"
  python3 -c "import json,sys; json.dump({'name':sys.argv[1],'url':sys.argv[2],'slug':sys.argv[3],'related':sys.argv[4],'drm':sys.argv[5]=='1','paths':sys.argv[6],'handlers':sys.argv[7],'single':sys.argv[8]=='1'}, open('app-config.json','w'))" "$name" "$url" "$slug" "${related:-}" "${drm:-}" "${paths:-}" "${handlers:-}" "${single:-}"
  npx electron-packager . "$name" --platform=darwin --arch="$ARCH" \
    --icon="$DIR/icons/$icon.icns" --app-bundle-id="$bid" --app-version=1.0.0 \
    --electron-zip-dir="$ELECTRON_ZIP_DIR" \
    "${IGNORE_FLAGS[@]}" \
    --out="$DIR/build" --overwrite >/dev/null
  mkdir -p "$HOME/Applications"
  # Install by swap, mirroring build-linux.sh: stage and sign the new bundle first, then
  # replace the old one. Deleting the working app before the copy means a failed copy or
  # codesign leaves the user with an app that will not launch and no previous version.
  dest="$HOME/Applications/$name.app"
  staged_app="$HOME/Applications/.$name.app.new"
  old_app="$HOME/Applications/.$name.app.old"
  rm -rf "$staged_app"
  cp -R "$DIR/build/$name-darwin-$ARCH/$name.app" "$staged_app"
  # By absolute path: a Homebrew or pip `xattr` earlier on PATH has no -r, fails the whole
  # step, and prints its usage to stdout, which the 2>/dev/null does not hide.
  /usr/bin/xattr -dr com.apple.quarantine "$staged_app" 2>/dev/null || true
  # An unsigned bundle is refused by Gatekeeper on current macOS, so a failed codesign is a
  # failed install. Because it happens on the staged copy, the current app is untouched.
  if ! codesign --force --deep --sign - "$staged_app" >/dev/null 2>&1; then
    echo "    codesign failed for $name.app — leaving the installed app untouched" >&2
    rm -rf "$staged_app"
    exit 1
  fi
  rm -rf "$old_app"
  if [ -e "$dest" ]; then mv "$dest" "$old_app"; fi
  mv "$staged_app" "$dest"
  rm -rf "$old_app"
  echo "    installed + signed: ~/Applications/$name.app"
done
cleanup_build
trap - EXIT INT TERM HUP PIPE
echo "==> Done. Launch from ~/Applications (or Spotlight)."
