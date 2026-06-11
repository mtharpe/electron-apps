#!/usr/bin/env bash
# Apply the bundled Google Messages icon to the Safari "Add to Dock" web app.
#
# Google Messages is NOT part of the Electron suite (it can't be — see README):
# it's set up as a Safari web app via Safari → File → Add to Dock. This sets a
# custom icon on that web app non-invasively (like Finder's "paste icon"), so it
# does NOT modify or break the web app's code signature.
#
# Usage: ./set-messages-icon.sh [path-to-web-app.app]
#        (defaults to ~/Applications/Messages.app)
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="${1:-$HOME/Applications/Messages.app}"
ICON="$DIR/icons/messages.icns"

[ -f "$ICON" ] || { echo "Missing $ICON"; exit 1; }
[ -d "$APP" ]  || { echo "Web app not found: $APP
Create it first: open https://messages.google.com/web/ in Safari, then File → Add to Dock."; exit 1; }

swift - "$APP" "$ICON" <<'SWIFT'
import AppKit
let app = CommandLine.arguments[1], icon = CommandLine.arguments[2]
guard let img = NSImage(contentsOfFile: icon) else { print("cannot load \(icon)"); exit(1) }
print(NSWorkspace.shared.setIcon(img, forFile: app, options: []) ? "icon set on \(app)" : "setIcon failed")
SWIFT

killall Dock 2>/dev/null || true
echo "Done — if the Dock still shows the old icon, quit and reopen the web app."
