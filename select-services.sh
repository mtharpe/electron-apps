#!/usr/bin/env bash
# Choosing which services to act on. Sourced by build.sh (macOS) and build-linux.sh
# AFTER services.conf, which defines SERVICES.
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
