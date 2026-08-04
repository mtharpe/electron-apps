# Google Standalone Apps for macOS & Linux

Turn **Gmail, Google Calendar, Google Tasks, and Google Keep** into real, standalone desktop
apps — each with its own icon, its own Dock/taskbar identity, and **native desktop
notifications** — fully independent of Chrome.

Unlike Chrome PWAs, these are genuine separate applications. Unlike plain
[Nativefier](https://github.com/nativefier/nativefier), they actually get **past Google's
"this browser or app may not be secure" sign-in block**, and they deliver **real
notification banners** (not just a sound).

> macOS: built and tested on Apple Silicon (arm64), macOS 26.
> Linux: built and tested on x86_64, Fedora 44 / GNOME 49 (Wayland and X11).

| | macOS | Linux |
|---|---|---|
| Build | `./build.sh` | `./build-linux.sh` (or `./build.sh`, which dispatches) |
| Installs to | `~/Applications/<Name>.app` | `~/.local/lib/<slug>` + a `.desktop` launcher |
| Shortcut modifier | `⌘` | `Ctrl` |

---

## Features

- **Standalone apps** — own icon, own Dock tile / taskbar entry, own app-switcher entry;
  not "Google Chrome". On Linux each service gets its own launcher, its own icon and its
  own `WM_CLASS`, so the four apps never collapse into one taskbar group.
- **Google sign-in works** — a stealth layer makes the embedded Chromium look like stock
  desktop Chrome, defeating the embedded-browser login block.
- **Multiple accounts, isolated** — every window uses its own persistent session
  (separate cookie jar), so each window can be a different Google account. Open as many
  as you like (`⌘N`, or the **Accounts** menu / `⌘1`–`⌘6`).
- **Enterprise SSO works** — corporate Workspace sign-in that redirects to a third-party
  identity provider (Okta, Microsoft Entra, Ping, Duo, …) completes **in-app**, even when
  the IdP opens in a popup. Vanity SSO domains are configurable without a rebuild.
- **Per-account window titles** — each window is titled with just the account/org name
  (e.g. *Spectro Cloud*), so account windows are easy to tell apart in ⌘-Tab / Mission
  Control / the **Window** menu.
- **Consistent Gmail view** — Workspace Gmail's extra left **Mail/Chat/Meet/Spaces** rail
  is hidden so every account looks like clean personal Gmail.
- **Links open in your browser** — links that leave Google (in emails, Calendar events, …)
  open in Chrome / your default browser, from **every** window — including secondary account
  windows opened by the account switcher.
- **Native desktop notifications** — Calendar reminders / new-mail alerts show as real
  banners (Notification Center on macOS; your desktop's notification daemon on Linux,
  correctly attributed to the app with its own icon). See
  [Notifications](#notifications) for exactly which paths are covered on Linux.
- **All profiles stay live** — background account windows aren't throttled or suspended,
  so every open profile keeps refreshing (Calendar data) and firing notifications, not
  just the focused one. Windows also reload on wake-from-sleep to recover stale sessions.
- **Dark window chrome** — window decorations follow the system light/dark setting.
- **Maximized on launch** — every account window opens maximized.
- **One instance per app** — launching a second copy focuses the running one instead of
  starting a rival process fighting over the same session data.
- **One-command build** — one script packages and installs all four.

---

## Requirements

**macOS**
- macOS (Apple Silicon / arm64 or Intel / x64)
- [Node.js](https://nodejs.org) + npm — `brew install node`
- Xcode command line tools (for `codesign`) — usually already present

**Linux**
- A desktop with a notification daemon (GNOME, KDE, …) and `libnotify`
- [Node.js](https://nodejs.org) + npm
- Optional: ImageMagick **or** python3-Pillow, used to render the icon-size ladder.
  Without either, a single unscaled icon is installed instead.

---

## Install / Build

```bash
git clone https://github.com/mtharpe/<repo>.git
cd <repo>
./build.sh          # macOS; on Linux this dispatches to ./build-linux.sh
```

### macOS

`build.sh` will, on first run:

1. `npm install` the build deps (`electron`, `@electron/packager`),
2. package each service into a `.app`,
3. copy them to `~/Applications`,
4. ad-hoc code-sign each app (so macOS attributes notifications correctly).

Launch them from `~/Applications`, Spotlight, or Launchpad. Pin to the Dock via
right-click → **Options → Keep in Dock**.

### Linux

`./build-linux.sh` packages each service and installs it entirely under `$PREFIX`
(default `~/.local`) — no root, nothing outside your home:

| Path | What |
|---|---|
| `~/.local/lib/<slug>/` | the packaged Electron app |
| `~/.local/bin/<slug>` | launcher symlink (run `gmail`, `google-calendar`, …) |
| `~/.local/share/applications/<slug>.desktop` | app-menu entry |
| `~/.local/share/icons/hicolor/*/apps/<slug>.png` | icons, 16px→512px |

Launch from your desktop's app menu, or run `gmail` / `google-calendar` /
`google-tasks` / `google-keep` from a shell.

```bash
./build-linux.sh                 # build + install all four
PREFIX=/some/where ./build-linux.sh
ARCH=arm64 ./build-linux.sh      # defaults to the host architecture
./build-linux.sh --uninstall     # remove apps, launchers and icons
```

`--uninstall` deliberately leaves your signed-in sessions
(`~/.config/<App Name>/`) alone, so a rebuild doesn't cost you every login.

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
  **Notification settings → Desktop notifications**). Calendar only fires reminders while
  a Calendar view is open — which for these apps means keeping the window open.
- Test via **Help → Send Test Notification in 5s** (then click away).

**macOS**
- Banners are hidden while the posting app is **frontmost** — alerts show while you're in
  another app.
- For reminders that **persist** on screen, set
  **System Settings → Notifications → \<app\> → Alert style → Alerts**.

**Linux**
- Notifications carry the app's own name and icon, and are tagged with a `desktop-entry`
  hint matching the installed `.desktop` file — so your desktop attributes them to the
  right app and gives each one its own entry in the notification settings.
- Reminders posted by the page (what Google Calendar does) are delivered. There is one
  gap, described under [Notification paths on Linux](#notification-paths-on-linux).

### Keyboard shortcuts
`⌘` on macOS, `Ctrl` on Linux.

| Shortcut | Action |
|---|---|
| `⌘/Ctrl + N` | New isolated account window |
| `⌘/Ctrl + 1`–`6` | Open/focus Account 1–6 |
| `⌘/Ctrl + R` / `⇧ + …R` | Reload / force reload |
| `⌘/Ctrl + +` / `-` / `0` | Zoom in / out / reset |
| `⌥⌘I` / `Ctrl+Shift+I` | Toggle DevTools |

---

## How it works

Each app is a thin [Electron](https://www.electronjs.org/) wrapper around one Google URL,
built with [`@electron/packager`](https://github.com/electron/packager).

| File | Role |
|---|---|
| `main.js` | Main process: per-account isolated windows, menus, request-header spoofing, permission grants, the **notification mirror** IPC handler, **external-link routing** (every window), **enterprise-SSO routing**, **per-account window titles**, the **Gmail view normalizer**, maximize-on-start, single-instance lock. Platform differences (UA, menus, link opening, icons) branch on `IS_MAC`. |
| `preload.js` | Runs in the page's main world; the **stealth layer** + the client-side **notification mirror**. |
| `services.conf` | The service list (`name \| icon \| url \| bundle-id \| categories`), shared by both build scripts so they can't drift. |
| `build.sh` | macOS: builds/installs/signs all four. Builds for the host arch (or `ARCH=universal`). On Linux it hands off to `build-linux.sh`. |
| `build-linux.sh` | Linux: packages each service, installs under `$PREFIX`, writes `.desktop` files and the icon ladder, registers with the desktop. Also `--uninstall`. |
| `icons/` | 1024px `.icns` app icons (macOS). |
| `icons/png/` | PNGs extracted from those `.icns` files, used by the Linux build. Regenerated automatically if missing. |

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

The spoof always claims the **host** platform — `Macintosh; Intel Mac OS X` on macOS,
`X11; Linux x86_64` on Linux — and `preload.js` derives `navigator.platform`,
`userAgentData.platform`, `architecture` and `platformVersion` from the same source. A
client claiming macOS while running on Linux would contradict the rest of its fingerprint,
and self-inconsistency is exactly what the "browser may not be secure" check looks for.
(The Linux values were checked field-by-field against the real Chrome on the same machine.)

### Native notifications
Google's web notifications don't all reach the desktop on their own. So `preload.js`
intercepts them and forwards a copy over IPC (`mirror-notification`) to `main.js`, which
posts it through Electron's native main-process `Notification` — the path that reliably
renders a banner.

**Which** notifications get mirrored is platform-specific, because the two platforms drop
different ones. Mirroring a notification the platform *already* delivers doesn't fail
safely — it shows the user two identical banners.

#### Notification paths on Linux
Measured on Electron 42 by watching the desktop notification bus (`org.freedesktop.Notifications`)
while firing each kind of notification:

| How the notification is posted | Electron delivers it? | What this app does |
|---|---|---|
| `new Notification(...)` from the page | ✅ yes | leave it alone — mirroring it would double every banner |
| `registration.showNotification(...)` called by the page | ❌ never | mirrored by `preload.js` |
| `showNotification(...)` from **inside** a service worker | ❌ never | **not covered** — see below |

The third row is a genuine limitation, not an oversight. Electron doesn't display
persistent notifications on Linux (the promise resolves and nothing appears), and the
worker's own scope can't be patched from the app: Electron's service-worker preload
scripts run in a *separate realm*, so a hook installed there doesn't affect the worker's
own calls — verified, the worker still sees the original `showNotification`.

In practice **Google Calendar reminders are unaffected**: Calendar only fires reminders
while a Calendar view is open, and posts them from the page, which the first two rows
cover. The gap only bites a notification pushed to a worker with no page driving it.

On macOS the mirror keeps its original, field-tested behaviour (page-level notifications
are mirrored); none of the Linux tuning changes it.

### Sandboxed renderer
Windows run with `contextIsolation: false` (so the stealth preload can patch the page's
main world) **and `sandbox: true`**. The sandbox matters beyond security: with *both* off,
Google Calendar's live-data channel (`signaler-pa.clients6.google.com`) intermittently
failed for **secondary** multi-login accounts — the "Could not load the data" error on
Workspace calendars. A sandboxed preload still patches the main world and still reaches
`ipcRenderer` (via `require('electron')`) for the notification mirror, so nothing is lost.

### Enterprise SSO routing
Most navigation to non-Google hosts opens in your real browser, but `main.js` keeps known
**identity-provider** hosts (Okta, Entra, Ping, OneLogin, Duo, Auth0, JumpCloud, CyberArk,
plus any you configure) **in-app, in the same session**, including when the IdP opens in a
popup — so corporate sign-in can complete and hand back to Google. Host matching is
suffix-based, so lookalikes (`okta.com.evil.com`) are correctly treated as external.

### External link routing
Links that leave Google (links inside emails, Calendar event details, etc.) open in your
real browser — Google Chrome, falling back to the system default. First-party Google UI
(compose pop-outs, sign-in) and recognized SSO popups stay **in-app, in the same session**.
This router is attached globally via `web-contents-created`, so it covers **every** window —
including the secondary account windows that Gmail/Calendar's account switcher opens. (It used
to be attached only to the first window, so links clicked in a second account's window opened
a dead in-app window instead of the browser.) Allowed in-app child windows inherit the opener's
per-account session, so they stay in the right cookie jar.

macOS finds Chrome by bundle name (`open -a "Google Chrome"`). Linux has no such lookup, so
the app probes `PATH` once at startup for `google-chrome`, `chromium`, `brave-browser` and
friends, and falls back to `xdg-open` (your actual default browser) if none are found. Set
**`GOOGLE_APP_BROWSER`** to a command or absolute path to override the probe on either
platform.

### Desktop integration on Linux
Each service is installed under its own **slug** (`gmail`, `google-calendar`, …), and that
one string is used as the executable name, the launcher symlink, the `.desktop` **filename**,
the icon name and the window's `WM_CLASS` — so they all line up by construction:

- **`WM_CLASS`** comes from `package.json`'s `productName`, which the build bakes in per
  service. It is *not* taken from the executable name, `app.setName()`, or Chromium's
  `--class` switch — all of which are applied too late to affect it. Without this every
  app would share one `WM_CLASS` and the four apps would collapse into a single taskbar
  icon that no `.desktop` file could match.
- **Notification identity** comes from the `desktop-entry` hint Electron derives from the
  same name, which is why the `.desktop` filename has to match the slug too. Rename one
  without the other and notifications quietly lose their icon and their entry in the
  desktop's notification settings.

### Per-account window titles
A global `web-contents-created` hook titles each window with just the account/org name and
re-applies it on every load (suppressing Google's own long page title). Gmail & Calendar
expose the org name in their page title (*Spectro Cloud*, *Google Calendar*, …); **Keep**
has no org name in its title so it falls back to the signed-in **email**; **Tasks** stays
*Tasks* (a single embedded view with no per-account context).

### Consistent Gmail view
For the Gmail app only, `main.js` injects a stylesheet that hides Workspace Gmail's left
**Mail/Chat/Meet/Spaces** app-rail so every account matches the clean personal-Gmail
layout. The rule targets the rail via `:has()` anchored on the buttons' stable `aria-label`s
(not Gmail's churning class names), is injected as a stylesheet (which survives Gmail's
re-renders), and is applied to every window — including account-switch windows.

---

## Configuration

### Add / change a service
Edit **`services.conf`** (`name | icon | url | bundle-id | categories`) — it's shared by
both build scripts, so a service added there appears on both platforms. Drop a matching
`icons/<name>.icns` in place and re-run the build. The Linux build extracts the PNG it
needs from that `.icns` automatically, so you don't have to supply both.

The last field is the [freedesktop category
list](https://specifications.freedesktop.org/menu-spec/latest/apa.html) used for the Linux
app-menu entry; macOS ignores it.

### Spoofed Chrome version
The spoofed Chrome major is derived automatically from the real bundled Chromium
(`process.versions.chrome`) in both `main.js` (`CHROME_MAJOR`) and `preload.js` (`V`), so it
can never lag the engine. If Google ever rejects the version as too old (symptom: Calendar
shows *"Could not load the data"*, or sign-in misbehaves), bump `electron` in
`package.json` and rebuild — the spoofed version follows automatically.

### Enterprise SSO / third-party login (Okta, Microsoft Entra, …)
Corporate Google Workspace sign-in usually redirects to a company identity provider — often
in a popup. Those popups are kept **in-app, in the same session**, so the SSO flow completes
and hands control back to Google (pushing them out to the external browser would break the
login). The major IdPs are recognized out of the box: **Okta, Microsoft Entra ID / Azure AD,
Ping Identity, OneLogin, Duo, Auth0, JumpCloud, CyberArk**.

If your company hosts SSO on a **vanity domain** (e.g. `login.example.com`) that isn't one of
those, add it — no rebuild needed — by either:
- setting `GOOGLE_APP_AUTH_DOMAINS` (comma/space-separated suffixes) in the app's
  environment, or
- creating a JSON array at the app's config dir, e.g.
  ```json
  ["login.example.com", "sso.example.com"]
  ```
  | Platform | Path |
  |---|---|
  | macOS | `~/Library/Application Support/<App Name>/auth-domains.json` |
  | Linux | `~/.config/<App Name>/auth-domains.json` |

Suffixes are matched against the host and its subdomains; lookalikes like `okta.com.evil.com`
are correctly treated as external.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| "This browser or app may not be secure" at sign-in | The stealth layer should handle it; if it regresses, bump the Chrome version (above). |
| Calendar: "Could not load the data" on a **Workspace** calendar | Fixed by the sandboxed renderer (secondary multi-login accounts no longer fail). If it ever recurs: `⌘R` to reload (windows also auto-reload on wake); if it happens on *first* load for everyone, the bundled Chromium may be too old — bump `electron` in `package.json` and rebuild. |
| Gmail still shows the Mail/Chat/Meet left rail | Make sure you relaunched the rebuilt app (⌘Q first). The hider keys off the buttons' `aria-label`s; if a Gmail redesign changes them it'll quietly stop matching — open an issue / update the selector in `main.js` (`GMAIL_RAIL_HIDE_CSS`). |
| Notification plays a sound but no banner | **macOS:** expected if the app is frontmost (macOS suppresses it) — switch apps. Otherwise set the app's macOS notification style to **Alerts**. |
| App won't open ("unidentified developer") | Apps are ad-hoc signed and built locally (not quarantined); if macOS still blocks, right-click → **Open** once. |
| **Linux:** app doesn't appear in the app menu | The build refreshes the desktop caches, but some sessions only re-scan on login. Log out and back in, or run `update-desktop-database ~/.local/share/applications`. |
| **Linux:** all four apps share one taskbar icon | You're running a build from before the per-service `WM_CLASS` fix — rebuild with `./build-linux.sh`. |
| **Linux:** notifications show a generic icon / wrong app name | The `.desktop` filename must match the app's slug (see **Desktop integration on Linux**). Rebuild rather than renaming files by hand. |
| **Linux:** Calendar reminder never appeared | Calendar only fires reminders with a Calendar view open. If it was open, see [Notification paths on Linux](#notification-paths-on-linux) for the one path that can't be delivered. |
| **Linux:** links open in the wrong browser | The app prefers Chrome/Chromium on `PATH`, else your `xdg-open` default. Set `GOOGLE_APP_BROWSER=/path/to/browser` to pin it. |
| **Linux:** `gmail: command not found` | `~/.local/bin` isn't on your `PATH` (the build warns about this), or launch from the app menu instead. |
| Need to re-login everywhere | Sessions are per-app and per-account-slot by design (full isolation). |
| Corporate (SSO) sign-in opens in Chrome / can't complete | The IdP isn't recognized. If it's on a company vanity domain, add it via `GOOGLE_APP_AUTH_DOMAINS` or `auth-domains.json` (see **Enterprise SSO** above), then retry. |
| Clicking a link in a **second** account's window does nothing | Fixed — link routing now runs in every window, not just the first. Relaunch the rebuilt app (⌘Q first). |

---

## Security notes

- The User-Agent / fingerprint spoofing exists solely to let **your own** Google accounts
  sign in to **your own** standalone apps — it doesn't bypass any authentication.
- `contextIsolation` is disabled because the stealth preload must run in the page's main
  world, but the renderer **sandbox stays on** (`sandbox: true`). These wrappers load only
  first-party Google URLs (plus recognized SSO providers during sign-in); other external
  links open in your default browser. Google-host matching is suffix-based, so lookalike
  domains are treated as external.
- Apps are **ad-hoc** code-signed for local use on macOS, not notarized for distribution.
  The Linux build is unsigned and installs only under your home directory — it never needs
  root and touches nothing system-wide.

---

## Google Messages

Messages **can't** be one of these Electron apps: it now requires Google sign-in (QR
pairing was removed), but its renderer only works with `contextIsolation:true`, which is
incompatible with the sign-in stealth — every way to add the stealth blanks the page, and
without it Google blocks sign-in. There's no Electron config where it both renders **and**
signs in.

Set it up as a **browser web app** instead (a real browser → sign-in works, standalone
icon, notifications):

**macOS** — Safari web app:
1. Open `https://messages.google.com/web/` in **Safari**, sign in.
2. **File → Add to Dock** → name it *Google Messages* → Add.
3. Give it the matching icon from this repo:
   ```bash
   ./set-messages-icon.sh            # applies icons/messages.icns to ~/Applications/Messages.app
   ```
   (A PWA in a non-Chrome Chromium browser like Brave/Edge works too.)

**Linux** — install it as a PWA from any Chromium-based browser:
1. Open `https://messages.google.com/web/`, sign in.
2. Menu → **Cast, save and share → Install page as app** (wording varies by browser).

The browser writes its own `.desktop` entry and icon, so `set-messages-icon.sh` (which is
macOS-only — it uses `NSWorkspace`) isn't needed.

## Limitations

- Builds for the **host architecture** automatically (`uname -m`). On macOS export
  `ARCH=universal` for a fat binary; on Linux set `ARCH=arm64`/`x64` to cross-target.
- Google Tasks has no standalone page; it uses the embedded Tasks view.
- Web Calendar has no native snooze in notifications (a Google limitation, not this app).
- On Linux, notifications posted from inside a service worker can't be displayed — see
  [Notification paths on Linux](#notification-paths-on-linux). Calendar reminders are not
  affected.
- Not affiliated with or endorsed by Google.

---

## License

[MIT](./LICENSE) © 2026 Mike Tharpe
