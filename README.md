# Google Standalone Apps for macOS

Turn **Gmail, Google Calendar, Google Tasks, and Google Keep** into real, standalone macOS
apps — each with its own icon, its own Dock/⌘-Tab identity, dark window chrome, and
**native macOS notifications** — fully independent of Chrome.

Unlike Chrome PWAs, these are genuine separate applications. Unlike plain
[Nativefier](https://github.com/nativefier/nativefier), they actually get **past Google's
"this browser or app may not be secure" sign-in block**, and they deliver **real
notification banners** (not just a sound).

> Built and tested on Apple Silicon (arm64), macOS 26.

---

## Features

- **Standalone apps** — own icon, own Dock tile, own ⌘-Tab entry; not "Google Chrome".
- **Google sign-in works** — a stealth layer makes the embedded Chromium look like stock
  desktop Chrome, defeating the embedded-browser login block.
- **Multiple accounts, isolated** — every window uses its own persistent session
  (separate cookie jar), so each window can be a different Google account. Open as many
  as you like (`⌘N`, or the **Accounts** menu / `⌘1`–`⌘6`).
- **Native macOS notifications** — web and service-worker notifications are mirrored to
  the native notification path, so Calendar reminders / new-mail alerts show as real
  banners in Notification Center.
- **All profiles stay live** — background account windows aren't throttled or suspended,
  so every open profile keeps refreshing (Calendar data) and firing notifications, not
  just the focused one. Windows also reload on wake-from-sleep to recover stale sessions.
- **Dark window chrome** — the window decorations follow macOS dark mode.
- **Maximized on launch** — every account window opens maximized.
- **One-command build** — `./build.sh` packages, installs, and code-signs all four.

---

## Requirements

- macOS (Apple Silicon / arm64)
- [Node.js](https://nodejs.org) + npm — `brew install node`
- Xcode command line tools (for `codesign`) — usually already present

---

## Install / Build

```bash
git clone https://github.com/mtharpe/<repo>.git
cd <repo>
./build.sh
```

`build.sh` will, on first run:

1. `npm install` the build deps (`electron`, `@electron/packager`),
2. package each service into a `.app`,
3. copy them to `~/Applications`,
4. ad-hoc code-sign each app (so macOS attributes notifications correctly).

Launch them from `~/Applications`, Spotlight, or Launchpad. Pin to the Dock via
right-click → **Options → Keep in Dock**.

---

## Usage

### Multiple accounts (one window per account)
- The app opens with **Account 1**.
- **⌘N** (or **Accounts → New Account Window**, or `⌘1`–`⌘6`) opens a new window with a
  **fully isolated session** — sign a different Google account into each. Logins persist
  per slot across restarts.
- Each app keeps its own session store, so you sign in per app.

### Notifications
- Turn on the service's own desktop notifications (e.g. Google Calendar → ⚙ Settings →
  **Notification settings → Desktop notifications**).
- macOS hides banners while the posting app is **frontmost** — alerts show while you're in
  another app. Test via **Help → Send Test Notification in 5s** (then click away).
- For reminders that **persist** on screen, set
  **System Settings → Notifications → \<app\> → Alert style → Alerts**.

### Keyboard shortcuts
| Shortcut | Action |
|---|---|
| `⌘N` | New isolated account window |
| `⌘1`–`⌘6` | Open/focus Account 1–6 |
| `⌘R` / `⇧⌘R` | Reload / force reload |
| `⌘+` / `⌘-` / `⌘0` | Zoom in / out / reset |
| `⌥⌘I` | Toggle DevTools |

---

## How it works

Each app is a thin [Electron](https://www.electronjs.org/) wrapper around one Google URL,
built with [`@electron/packager`](https://github.com/electron/packager).

| File | Role |
|---|---|
| `main.js` | Main process: per-account isolated windows, menus, request-header spoofing, permission grants, the **notification mirror** IPC handler, maximize-on-start. |
| `preload.js` | Runs in the page's main world; the **stealth layer** + the client-side **notification mirror**. |
| `build.sh` | Builds/installs/signs all four; service list lives in the `SERVICES` array. |
| `icons/` | 1024px `.icns` app icons. |

### Getting past Google's login block
Spoofing the User-Agent alone (what plain Nativefier does) is **not** enough — Google also
inspects JavaScript signals. `preload.js` therefore patches, in the page itself:
- `navigator.userAgentData` → Chrome brands (no "Electron"),
- `navigator.webdriver` → `false`,
- `window.chrome` → fleshed out like real Chrome,
- removes Electron/Node globals,

while `main.js` forces a Chrome **User-Agent + matching `Sec-CH-UA` client-hint headers**
on every request. Together these make the embedded Chromium indistinguishable from stock
Chrome at sign-in.

### Native notifications
Google's web notifications wouldn't render as macOS banners on their own (you'd only hear
a sound). So `preload.js` intercepts both **page-level** `Notification` and
**service-worker** `showNotification`, and forwards them over IPC
(`mirror-notification`) to `main.js`, which shows them through Electron's native
main-process `Notification` — the path that reliably renders banners.

---

## Configuration

### Add / change a service
Edit the `SERVICES` array in `build.sh` (`name | icon | url | bundle-id`), drop a matching
`icons/<name>.icns` in place, and re-run `./build.sh`.

### Bump the spoofed Chrome version
If Google ever rejects the version as too old (symptom: Calendar shows *"Could not load the
data"*, or sign-in misbehaves), raise the version in **both** files (keep them in sync):
- `main.js` → `CHROME_MAJOR`
- `preload.js` → `V`

Then rebuild.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| "This browser or app may not be secure" at sign-in | The stealth layer should handle it; if it regresses, bump the Chrome version (above). |
| Calendar: "Could not load the data. Please try reloading later." | Usually a stale session after the window sat idle/asleep — `⌘R` to reload (windows also auto-reload on wake). If it happens on first load, the spoofed Chrome version may be too old — bump `CHROME_MAJOR` / `V`. |
| Notification plays a sound but no banner | Expected if the app is frontmost (macOS suppresses it) — switch apps. Otherwise set the app's macOS notification style to **Alerts**. |
| App won't open ("unidentified developer") | Apps are ad-hoc signed and built locally (not quarantined); if macOS still blocks, right-click → **Open** once. |
| Need to re-login everywhere | Sessions are per-app and per-account-slot by design (full isolation). |

---

## Security notes

- The User-Agent / fingerprint spoofing exists solely to let **your own** Google accounts
  sign in to **your own** standalone apps — it doesn't bypass any authentication.
- `contextIsolation` is disabled because the stealth preload must run in the page's main
  world. These wrappers load only first-party Google URLs; external links open in your
  default browser.
- Apps are **ad-hoc** code-signed for local use, not notarized for distribution.

---

## Google Messages

Messages **can't** be one of these Electron apps: it now requires Google sign-in (QR
pairing was removed), but its renderer only works with `contextIsolation:true`, which is
incompatible with the sign-in stealth — every way to add the stealth blanks the page, and
without it Google blocks sign-in. There's no Electron config where it both renders **and**
signs in.

Set it up as a **Safari web app** instead (real browser → sign-in works, standalone icon,
notifications, no Chrome):

1. Open `https://messages.google.com/web/` in **Safari**, sign in.
2. **File → Add to Dock** → name it *Google Messages* → Add.
3. Give it the matching icon from this repo:
   ```bash
   ./set-messages-icon.sh            # applies icons/messages.icns to ~/Applications/Messages.app
   ```
   (A PWA in a non-Chrome Chromium browser like Brave/Edge works too.)

## Limitations

- Builds for the **host architecture** automatically (Apple Silicon `arm64` or Intel `x64`,
  via `uname -m`); export `ARCH=universal` before `./build.sh` for a fat binary.
- Google Tasks has no standalone page; it uses the embedded Tasks view.
- Web Calendar has no native snooze in notifications (a Google limitation, not this app).
- Not affiliated with or endorsed by Google.

---

## License

[MIT](./LICENSE) © 2026 Mike Tharpe
