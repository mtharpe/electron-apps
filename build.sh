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

. "$DIR/services.conf"
# Shared with build-linux.sh so both installers agree on what an app can be called.
. "$DIR/select-services.sh"
# ensure_prereqs(): what the build and the apps need, offered for install if missing.
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
if [ ! -s "$STAGED_ZIP" ]; then
  # ELECTRON_ZIP_URL fully overrides for an internal mirror; ELECTRON_MIRROR still
  # works as the base if someone had already set it. Neither is required. A mirror is a
  # BASE URL, so join it with exactly one slash whether or not it was given one.
  MIRROR="${ELECTRON_MIRROR:-https://github.com/castlabs/electron-releases/releases/download/}"
  URL="${ELECTRON_ZIP_URL:-${MIRROR%/}/v${ELECTRON_VER}+wvcus/electron-v${ELECTRON_VER}+wvcus-darwin-${ARCH}.zip}"
  echo "==> Downloading Electron $ELECTRON_VER+wvcus (darwin-$ARCH)"
  part="$(mktemp "$ELECTRON_ZIP_DIR/.dl.XXXXXX")"
  # The partial download is removed on any exit, including an abort below.
  trap 'rm -f "$part"' EXIT INT TERM HUP PIPE
  # --proto '=https' plus --tlsv1.2 keeps a mirror or redirect from silently downgrading
  # the transport the archive is fetched over.
  curl -fSL --proto '=https' --tlsv1.2 --retry 3 -o "$part" "$URL"
  # A truncated download, or an HTML error page saved under a .zip name, must never be
  # staged as if it were a usable Electron build.
  unzip -tq "$part" >/dev/null
  # Bypassing @electron/get also skipped its checksum step. When the installed electron
  # package publishes castlabs' checksums, require the archive to match the pin. A missing
  # entry means this platform/arch is not one the pinned release publishes.
  CHECKSUMS="$DIR/node_modules/electron/checksums.json"
  if [ -f "$CHECKSUMS" ]; then
    zip_name="electron-v${ELECTRON_VER}+wvcus-darwin-${ARCH}.zip"
    expected="$(node -e 'const c=require(process.argv[1]); process.stdout.write(c[process.argv[2]] || "")' "$CHECKSUMS" "$zip_name")"
    if [ -z "$expected" ]; then
      echo "    no SHA-256 for $zip_name in $CHECKSUMS — this platform/arch may not be published for the pinned Electron" >&2
      exit 1
    fi
    actual="$(node -e 'const c=require("crypto"),f=require("fs"); process.stdout.write(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex"))' "$part")"
    if [ "$actual" != "$expected" ]; then
      echo "    SHA-256 mismatch for $URL" >&2
      echo "      expected $expected" >&2
      echo "      got      $actual" >&2
      exit 1
    fi
  fi
  mv "$part" "$STAGED_ZIP"
  trap - EXIT INT TERM HUP PIPE
fi

# build/ and app-config.json are this run's scratch output. Clean them from an EXIT trap so
# a `set -e` abort partway through the loop removes them too, not only a finished build.
cleanup_build() { rm -rf "$DIR/build" "$DIR/app-config.json"; }
trap cleanup_build EXIT INT TERM HUP PIPE
rm -rf "$DIR/build" "$DIR/app-config.json"
mkdir -p "$DIR/build"
for entry in "${SELECTED[@]}"; do
  IFS='|' read -r name icon url bid categories related drm paths handlers single <<< "$entry"
  echo "==> Building $name"
  # slug travels into the app so main.js can find styles/<slug>.css without re-deriving it.
  # drm is a plain boolean the runtime reads to decide whether to wait on Widevine.
  # paths is a comma/space-separated URL-path allowlist for services tenanted inside a
  # larger site (see services.conf); empty for the common case where the app owns its
  # whole domain. handlers maps link schemes this app takes over (mailto: for Gmail).
  slug="$(slugify "$name")"
  /usr/bin/python3 -c "import json,sys; json.dump({'name':sys.argv[1],'url':sys.argv[2],'slug':sys.argv[3],'related':sys.argv[4],'drm':sys.argv[5]=='1','paths':sys.argv[6],'handlers':sys.argv[7],'single':sys.argv[8]=='1'}, open('app-config.json','w'))" "$name" "$url" "$slug" "${related:-}" "${drm:-}" "${paths:-}" "${handlers:-}" "${single:-}"
  npx electron-packager . "$name" --platform=darwin --arch="$ARCH" \
    --icon="$DIR/icons/$icon.icns" --app-bundle-id="$bid" --app-version=1.0.0 \
    --electron-zip-dir="$ELECTRON_ZIP_DIR" \
    "${IGNORE_FLAGS[@]}" \
    --out="$DIR/build" --overwrite >/dev/null
  mkdir -p "$HOME/Applications"
  rm -rf "$HOME/Applications/$name.app"
  cp -R "$DIR/build/$name-darwin-$ARCH/$name.app" "$HOME/Applications/"
  # By absolute path: a Homebrew or pip `xattr` earlier on PATH has no -r, fails the whole
  # step, and prints its usage to stdout, which the 2>/dev/null does not hide.
  /usr/bin/xattr -dr com.apple.quarantine "$HOME/Applications/$name.app" 2>/dev/null || true
  # An unsigned bundle is refused by Gatekeeper on current macOS, so a failed codesign is a
  # failed install -- say so instead of reporting "installed + signed".
  codesign --force --deep --sign - "$HOME/Applications/$name.app" >/dev/null 2>&1 \
    || { echo "    codesign failed for $name.app — it will not launch on current macOS" >&2; exit 1; }
  echo "    installed + signed: ~/Applications/$name.app"
done
cleanup_build
trap - EXIT INT TERM HUP PIPE
echo "==> Done. Launch from ~/Applications (or Spotlight)."
