# Prerequisites, checked before anything is built. Sourced by build-linux.sh and build.sh.
#
# Two kinds, treated differently:
#   required  node (>= what @electron/packager declares), npm, curl, python3 — the build
#             cannot run without them, so a missing one stops it.
#   optional  rsvg-convert (themed SVG icons), and a keyring client for single sign-on.
#             The apps run without them, so a missing one is a warning, not a stop.
#
# Anything missing is offered for install through the machine's own package manager —
# asked first on a terminal, never silently with sudo. INSTALL_PREREQS=1 says yes without
# asking (for scripts), INSTALL_PREREQS=0 never installs. An image-based host (Silverblue,
# Vanilla OS, ...) gets told what is missing instead: layering a package there needs a
# reboot, which is not a build script's call to make.
#
# Package names are the one per-distro fact here. dnf and zypper resolve a file path to the
# package that ships it, so they are asked for the binary itself and need no table.
#
# Bash 3.2 compatible (macOS): no associative arrays, no mapfile.

PREREQ_REQUIRED_NODE="22.12.0"

# "1" if version $1 >= version $2 (dotted numeric).
prereq_version_ge() {
  local IFS=.
  local a=($1) b=($2) i
  for i in 0 1 2; do
    [ "${a[$i]:-0}" -gt "${b[$i]:-0}" ] && return 0
    [ "${a[$i]:-0}" -lt "${b[$i]:-0}" ] && return 1
  done
  return 0
}

prereq_pm() {
  if [ "$(uname -s)" = Darwin ]; then command -v brew >/dev/null 2>&1 && echo brew; return; fi
  command -v abroot >/dev/null 2>&1 && { echo abroot; return; }
  { [ -e /run/ostree-booted ] && command -v rpm-ostree >/dev/null 2>&1; } && { echo rpm-ostree; return; }
  for pm in apt-get dnf zypper pacman; do
    command -v "$pm" >/dev/null 2>&1 && { echo "$pm"; return; }
  done
}

# The package that provides tool $1 under package manager $2.
prereq_pkg() {
  case "$2:$1" in
    dnf:*|zypper:*)          echo "/usr/bin/$1" ;;
    brew:node|brew:npm)      echo node ;;
    brew:python3)            echo python ;;
    brew:*)                  echo "$1" ;;
    apt-get:node|abroot:node)                  echo nodejs ;;
    apt-get:rsvg-convert|abroot:rsvg-convert)  echo librsvg2-bin ;;
    apt-get:secret-tool|abroot:secret-tool)    echo libsecret-tools ;;
    rpm-ostree:node)                           echo nodejs ;;
    rpm-ostree:rsvg-convert)                   echo librsvg2-tools ;;
    rpm-ostree:secret-tool)                    echo libsecret ;;
    pacman:node)             echo nodejs ;;
    pacman:rsvg-convert)     echo librsvg ;;
    pacman:secret-tool)      echo libsecret ;;
    *)                       echo "$1" ;;
  esac
}

prereq_install() {
  local pm="$1"; shift
  local sudo=""
  if [ "$pm" != brew ] && [ "$(id -u)" != 0 ]; then
    command -v sudo >/dev/null 2>&1 || { echo "    (no sudo — install them yourself)"; return 1; }
    sudo=sudo
  fi
  case "$pm" in
    apt-get) $sudo apt-get install -y "$@" ;;
    dnf)     $sudo dnf install -y "$@" ;;
    zypper)  $sudo zypper --non-interactive install "$@" ;;
    pacman)  $sudo pacman -S --needed --noconfirm "$@" ;;
    brew)    brew install "$@" ;;
  esac
}

# Single sign-on needs SOME way to reach the OS keyring: session-sync.js tries secret-tool,
# libsecret through python3's gi bindings, then kwallet-query, and enables itself only for one
# that survives a real store/lookup round-trip. Any one present is enough here; the app does
# the real test. macOS always has Keychain.
prereq_has_keyring_client() {
  [ "$(uname -s)" = Darwin ] && return 0
  command -v secret-tool >/dev/null 2>&1 && return 0
  command -v kwallet-query >/dev/null 2>&1 && return 0
  python3 -c "import gi; gi.require_version('Secret', '1'); from gi.repository import Secret" >/dev/null 2>&1
}

ensure_prereqs() {
  local required="" optional="" t
  for t in node npm curl python3; do
    command -v "$t" >/dev/null 2>&1 || required="$required $t"
  done
  if command -v node >/dev/null 2>&1; then
    local have; have="$(node -p 'process.versions.node' 2>/dev/null || echo 0)"
    if ! prereq_version_ge "$have" "$PREREQ_REQUIRED_NODE"; then
      # Not offered for install: the distro's package is usually the old one that is here.
      echo "==> node $have is older than the $PREREQ_REQUIRED_NODE the build needs." \
           "Distro packages often lag; https://nodejs.org or nvm has current ones." >&2
      exit 1
    fi
  fi
  if [ "$(uname -s)" != Darwin ]; then
    command -v rsvg-convert >/dev/null 2>&1 || optional="$optional rsvg-convert"
  fi
  prereq_has_keyring_client || optional="$optional secret-tool"

  [ -z "$required$optional" ] && return 0

  local pm; pm="$(prereq_pm)"
  [ -n "$required" ] && echo "==> Missing (needed to build):$required"
  [ -n "$optional" ] && echo "==> Missing (optional):$optional" \
    "— rsvg-convert renders themed icons; secret-tool enables single sign-on between the apps"

  local pkgs=""
  for t in $required $optional; do pkgs="$pkgs $(prereq_pkg "$t" "$pm")"; done

  if [ "$pm" = abroot ]; then
    echo "    Image-based OS. To add them: sudo abroot pkg add$pkgs && sudo abroot pkg apply, then reboot"
  elif [ "$pm" = rpm-ostree ]; then
    echo "    Image-based OS. To add them: sudo rpm-ostree install$pkgs, then reboot"
  elif [ -z "$pm" ]; then
    echo "    Install these with your system's package tools:$pkgs"
  elif [ "${INSTALL_PREREQS:-}" = 0 ]; then
    echo "    Skipping install (INSTALL_PREREQS=0):$pkgs"
  else
    local go="${INSTALL_PREREQS:-}"
    if [ -z "$go" ] && [ -t 0 ]; then
      printf "    Install them now with %s:%s ? [Y/n] " "$pm" "$pkgs"
      read -r reply
      case "$reply" in [nN]*) go=0 ;; *) go=1 ;; esac
    fi
    if [ "$go" = 1 ]; then
      # shellcheck disable=SC2086 — word splitting into package names is the point
      prereq_install "$pm" $pkgs || echo "    Install failed; continuing with what is present." >&2
    else
      echo "    Not installing (no terminal to ask; INSTALL_PREREQS=1 to allow):$pkgs"
    fi
  fi

  for t in $required; do
    command -v "$t" >/dev/null 2>&1 || { echo "==> Cannot build without $t." >&2; exit 1; }
  done
}
