#!/usr/bin/env bash
# The shared half of the two installers. Sourced by build.sh (macOS) and build-linux.sh
# AFTER services.conf, which defines SERVICES.
#
# Two things live here, both for the same reason — the platforms must not disagree:
#   - choosing which services to act on (slugify, list_services, resolve_services)
#   - IGNORE_FLAGS, the list of paths kept OUT of the packaged app (see the end of the file)
#
# These apps are one person's set. Anyone else is likely to want a subset, so nothing here
# assumes "all" — the caller passes whatever the user asked for and gets back SELECTED.
#
# An app can be named three ways, all case-insensitive, because people reach for different
# ones: the short key from the icon column (`keep`), the slug that names the binary and the
# .desktop file (`google-keep`), or the display name (`"Google Keep"`).
#
# Kept compatible with bash 3.2, which is what macOS still ships: no associative arrays,
# no mapfile, and no bare expansion of a possibly-empty array under `set -u`.

# Display name -> filesystem slug: "Google Calendar" -> "google-calendar". The slug is the
# executable name, the symlink name, the .desktop FILENAME, the icon name AND the WM_CLASS
# the desktop matches windows on, so they all agree by construction.
#
# The .desktop filename matching matters as much as StartupWMClass: Electron tags every
# notification with a `desktop-entry` hint derived from the same name, and the desktop uses
# that hint to decide which app a notification belongs to (its icon, and its entry in the
# notification settings). Rename the file without renaming the slug and notifications
# quietly lose their identity.
slugify() { echo "$1" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | sed 's/^-*//; s/-*$//'; }

_lower() { echo "$1" | tr '[:upper:]' '[:lower:]'; }

_entry_name() { local n; IFS='|' read -r n _ _ _ _ <<< "$1"; echo "$n"; }

# True if `want` names this entry by short key, slug, or display name.
_entry_matches() {
  local entry="$1" want name icon
  want="$(_lower "$2")"
  IFS='|' read -r name icon _ _ _ <<< "$entry"
  [ "$want" = "$(_lower "$icon")" ] && return 0
  [ "$want" = "$(slugify "$name")" ] && return 0
  [ "$want" = "$(_lower "$name")" ] && return 0
  return 1
}

# Print the catalogue: what a user can ask for, and what each one actually opens.
list_services() {
  local entry name icon url
  echo "Available apps:"
  echo
  for entry in "${SERVICES[@]}"; do
    IFS='|' read -r name icon url _ _ <<< "$entry"
    printf '  %-10s %-18s %s\n' "$icon" "$(slugify "$name")" "$url"
  done
  echo
  echo 'Name any of them by short key, slug, or full name — e.g. "keep", "google-keep", "Google Keep".'
}

# Append the entry matching `want` to SELECTED, skipping anything already chosen so
# `gmail gmail` does not build twice. Fails loudly on an unknown name rather than silently
# installing nothing, which would look like success.
_select_one() {
  local want="$1" entry chosen
  for entry in "${SERVICES[@]}"; do
    if _entry_matches "$entry" "$want"; then
      for chosen in ${SELECTED[@]+"${SELECTED[@]}"}; do
        [ "$chosen" = "$entry" ] && return 0
      done
      SELECTED[${#SELECTED[@]}]="$entry"
      return 0
    fi
  done
  echo "Unknown app: $want" >&2
  echo "Run with --list to see the available names." >&2
  return 1
}

# Ask, when there is somebody there to ask. Numbers are offered because they are quicker
# than typing names, but names are accepted too so the answer can be copied from --list.
_interactive_select() {
  local entry reply token i total
  total=${#SERVICES[@]}

  echo "Which apps do you want to install?" >&2
  echo >&2
  i=1
  for entry in "${SERVICES[@]}"; do
    printf '   %2d) %s\n' "$i" "$(_entry_name "$entry")" >&2
    i=$((i + 1))
  done
  echo >&2
  printf 'Numbers ("1 3"), names ("gmail keep"), or press Enter for all: ' >&2
  read -r reply || reply=""
  echo >&2

  # Enter, or an explicit "all", takes everything.
  case "$(_lower "$reply")" in
    ''|all) SELECTED=("${SERVICES[@]}"); return 0 ;;
  esac

  # Commas are what people type even when told to use spaces.
  for token in $(echo "$reply" | tr ',' ' '); do
    case "$token" in
      ''|*[!0-9]*) _select_one "$token" || return 1 ;;
      *)
        if [ "$token" -lt 1 ] || [ "$token" -gt "$total" ]; then
          echo "No app number $token — pick between 1 and $total." >&2
          return 1
        fi
        _select_one "$(_entry_name "${SERVICES[$((token - 1))]}")" || return 1
        ;;
    esac
  done
}

# Resolve the user's arguments into SELECTED.
#   names given  -> exactly those
#   no names     -> ask, if stdin is a terminal; otherwise everything, so scripted and CI
#                   builds keep working unattended instead of blocking on a prompt
resolve_services() {
  SELECTED=()
  if [ "$#" -eq 0 ]; then
    if [ -t 0 ]; then
      _interactive_select || exit 1
    else
      SELECTED=("${SERVICES[@]}")
    fi
  else
    local want
    for want in "$@"; do
      _select_one "$want" || exit 1
    done
  fi

  if [ "${#SELECTED[@]}" -eq 0 ]; then
    echo "No apps selected — nothing to do." >&2
    exit 1
  fi
}

# --- what does NOT go into the packaged app ------------------------------------------
#
# Shared by both installers so a path excluded on one platform cannot quietly ship on the
# other. That drift was real: build-linux.sh excluded services.conf and build.sh did not.
#
# electron-packager does NOT read .gitignore, so "git-clean" is no guarantee that a file
# stays out of the bundle. .remember/ is the case that proves it — Claude Code session logs,
# gitignored via *.log, were being packaged into every app.asar (measured: 64 KB of
# transcript logs in all six installed apps). Anything generated beside the source and not
# needed at runtime has to be named here explicitly.
#
# Patterns are regexes matched against the path relative to the project root, with a leading
# slash (e.g. "/docs/apps.png"). The first two are deliberately loose substrings and have
# been that way since the beginning: "/icons" also happens to exclude docs/icons/, which is
# why only docs/apps.png was ever shipping. New entries are anchored.
PACKAGER_IGNORES=(
  "/build"
  "/icons"
  "\.sh$"
  "\.md$"
  "^/docs($|/)"
  "^/services\.conf$"
  "^/\.remember($|/)"
  "^/\.gitignore$"
  "^/node_modules/\.package-lock\.json$"   # npm's prune leftover, ~24 KB, unread at runtime
)

# electron-packager takes one --ignore per pattern. Built as an array (not a string) so the
# regexes survive word splitting intact, and with the index-append idiom rather than += so
# this stays bash 3.2 compatible for macOS.
IGNORE_FLAGS=()
for _pat in "${PACKAGER_IGNORES[@]}"; do
  IGNORE_FLAGS[${#IGNORE_FLAGS[@]}]="--ignore=$_pat"
done
unset _pat
