# Google Standalone Apps for macOS & Linux

Turn **Gmail, Google Calendar, Google Tasks, Google Keep, and Google Messages** into real,
standalone desktop apps — each with its own icon, its own Dock/taskbar identity, and
**native desktop notifications** — fully independent of Chrome.

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
  own `WM_CLASS`, so the apps never collapse into one taskbar group.
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
- **Links land in the right Chrome profile** — each account window can be pinned to a Chrome
  profile, so a link from your work account opens in your work profile instead of whichever
  Chrome window happened to have focus. Accounts match themselves to the profile signed into
  the same Google address, and **Accounts → Configure Accounts…** lets you rename accounts
  and override the mapping.
- **Native desktop notifications** — Calendar reminders / new-mail alerts show as real
  banners (Notification Center on macOS; your desktop's notification daemon on Linux,
  correctly attributed to the app with its own icon). See
  [Notifications](#notifications) for exactly which paths are covered on Linux.
- **All profiles stay live** — background account windows aren't throttled or suspended,
  so every open profile keeps refreshing (Calendar data) and firing notifications, not
  just the focused one. Windows also reload on wake-from-sleep to recover stale sessions.
- **Light/dark window chrome** — the titlebar, the page and the pre-paint background all
  follow the system light/dark setting, and **View ▸ Appearance** pins **Light** or **Dark**
  when detection gets it wrong. The choice is saved per app and survives restarts; **System**
  (the default) tracks the desktop live. Changing it offers a restart, because GTK only reads
  the theme at startup and the titlebar can't be repainted in place.
- **Maximized on launch** — every account window opens maximized.
- **One instance per app** — launching a second copy focuses the running one instead of
  starting a rival process fighting over the same session data.
- **One-command build** — one script packages and installs every app in `services.conf`.

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

### Choosing which apps to install

This is one person's set of apps and you probably don't want all of it. Run the installer
with no arguments and it asks:

```
Which apps do you want to install?

    1) Gmail
    2) Google Calendar
    3) Google Tasks
    4) Google Keep
    5) Google Messages

Numbers ("1 3"), names ("gmail keep"), or press Enter for all:
```

Or name them up front and skip the prompt. An app answers to its short key, its slug, or
its full name, in any case:

```bash
./build-linux.sh gmail keep          # just these two
./build-linux.sh "Google Keep"       # same app, long name
./build-linux.sh --all               # everything, no prompt
./build-linux.sh --list              # show the available names and what each one opens
```

Installing a subset leaves any app you already installed alone, so you can add one later
without rebuilding the rest. With no terminal attached (CI, a pipe) the prompt is skipped
and everything is built, so scripted builds don't hang waiting for an answer.

**Adding your own:** `services.conf` is the catalogue both installers read. Append a line
and drop a matching icon in `icons/` — nothing else needs to change.

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

#### Icons follow your icon theme

If your icon theme has its own artwork for one of these apps, that is what you get.

The app-menu and dash icons come free: the `.desktop` file says `Icon=google-keep` — a
*name*, which the desktop resolves through your active theme. Themes like Papirus, Colloid
and Numix already ship icons under exactly these names.

The one place that could not follow the theme was the icon Electron hands to the
notification daemon and the window manager, because that is a **file path**, not a name.
The installer now resolves it at install time: it reads your active icon theme (GNOME via
gsettings, KDE via `kdeglobals`), walks the theme's `Inherits` chain the way the
freedesktop spec says to, and bakes the winner in — rasterising SVG to a 256px PNG, since
Electron cannot load SVG. The build prints what it chose:

```
==> Icon theme: Colloid-Dark
==> Building Google Keep
    icon: Colloid-Dark (google-keep.svg)
```

If your theme has nothing for an app, the chain ends at `hicolor` and you get this repo's
bundled icon — which is why the bundled icons are still installed into `hicolor` even when
your theme wins. That fallback has to stay: switch to a theme that has never heard of these
apps and it is the only thing standing between you and a blank icon.

Nothing here is specific to any one theme — the installer reads whatever the machine is set
to, per install. On a box with no theme icons for these apps every one falls back to
`hicolor` and the build says so:

```
==> Icon theme: Adwaita
==> Building Google Tasks
    icon: hicolor (google-tasks.png)
```

Override the detection with `ICON_THEME` to build against a theme other than the active
one — handy for installing to someone else's setup, or previewing a theme without
switching to it:

```bash
ICON_THEME=Papirus-Dark ./build-linux.sh
```

Because this is resolved at **install** time, changing your icon theme later updates the
menu and dash icons immediately, but not the notification icon — rerun the installer to
pick that up.

Launch from your desktop's app menu, or run `gmail` / `google-calendar` /
`google-tasks` / `google-keep` / `google-messages` from a shell.

```bash
./build-linux.sh                   # pick from the menu (see above)
./build-linux.sh gmail keep        # or name the apps outright
PREFIX=/some/where ./build-linux.sh
ARCH=arm64 ./build-linux.sh        # defaults to the host architecture
./build-linux.sh --uninstall       # remove every app, launcher and icon it installed
./build-linux.sh --uninstall keep  # remove just that one
```

`--uninstall` deliberately leaves your signed-in sessions
(`~/.config/<App Name>/`) alone, so a rebuild doesn't cost you every login. With no names
it removes everything — it does **not** prompt, because that is what someone typing
`--uninstall` is asking for.

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
| `⌘/Ctrl + ,` | Configure accounts (names + Chrome profiles) |
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
| `accounts.html` | The **Configure Accounts…** window: a name field and a Chrome profile dropdown per account slot. |
| `accounts-preload.js` | Context-isolated bridge for that window — exposes load / save / close and nothing else. |
| `services.conf` | The service list (`name \| icon \| url \| bundle-id \| categories`), shared by both build scripts so they can't drift. |
| `select-services.sh` | Turns what the user asked for — names, menu numbers, `--all`, or nothing — into the set of services to build. Shared by both installers so they accept the same names. |
| `build.sh` | macOS: builds/installs/signs every app in `services.conf`. Builds for the host arch (or `ARCH=universal`). On Linux it hands off to `build-linux.sh`. |
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

### Chrome profile routing
`google-chrome <url>` drops the link into whichever profile window Chrome currently has
focused, which is rarely the one the link belongs to. Chrome takes `--profile-directory=<dir>`
to pick the target explicitly, so each account slot can be pinned to one.

The mapping is keyed by **slot number**, not by email: the slot owns the cookie jar
(`persist:account-N`), it exists before any page has loaded, and it survives a window being
signed into a different account. The originating slot is recovered from the session partition
at click time, so links clicked in the secondary windows the account switcher opens route to
the same profile as their parent.

Unmapped slots (**Auto**) match themselves: Chrome records every profile's directory, display
name and signed-in address in `Local State`, and the app reads the signed-in address out of
each account window's Google Account button. Same address → that profile. The detected address
is cached in `accounts.json`, so the mapping is already known at the next launch, before any
page has painted. A slot pinned to a profile that Chrome no longer has falls back to auto
rather than routing to a profile Chrome would then invent, and **None** hands the URL over
bare (the old focused-window behaviour). The flag is only ever passed to a Chromium-family
browser — Firefox would treat it as a URL.

### Renaming accounts
**Accounts → Configure Accounts…** (`Ctrl+,` / `⌘,`) opens a window with a name field and a
Chrome profile dropdown per slot. A name set here
outranks the page-derived title below. Leave it blank and a mapped slot takes its Chrome
profile's own name, which is the point of the mapping — the two stay consistent without
typing anything.

Names and mappings are **shared by all the apps** (`~/.config/google-standalone-apps/accounts.json`,
or `~/Library/Application Support/google-standalone-apps/` on macOS) — "Account 2 is Work" is
a fact about your Google accounts, not about Gmail-the-app, so you name them once. Only the
labels and the routing are shared; the sessions stay isolated per app exactly as before. Each
app watches the file, so a name set in Gmail reaches a running Calendar without restarting it,
and saves write only the slots that changed so one app can't revert another's edit. An older
per-app `<userData>/accounts.json` is merged in on first run (anything already in the shared
file wins) and renamed to `accounts.json.migrated`.

Unlike the account windows, this window is an ordinary hardened renderer
(`contextIsolation: true`, `sandbox: true`) with its own preload exposing exactly three
calls — the stealth preferences exist for Google's sign-in gate and have no business here.
Saved values are validated in the main process rather than trusted, since `ipcMain` handlers
are reachable from any renderer.

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
A name set in **Configure Accounts…** (or inherited from the mapped Chrome profile) wins.
With neither, a global `web-contents-created` hook titles each window with the account/org name and
re-applies it on every load (suppressing Google's own long page title). Gmail & Calendar
expose the org name in their page title (*Spectro Cloud*, *Google Calendar*, …); **Keep**
and **Tasks** have no org name in their titles, so they fall back to the signed-in **email**
read off the account avatar; **Messages** exposes neither, so it keeps its page title.

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

Messages is one of the built apps — it is in `services.conf` and `build-linux.sh` installs
it alongside the other four.

This used to be documented as impossible: Messages was said to render only with
`contextIsolation:true`, which the sign-in stealth (which needs `contextIsolation:false`)
rules out, leaving no config that both rendered and signed in. That is no longer true.
Measured against `https://messages.google.com/web/` under the standard `STEALTH_WEBPREFS`,
the page renders fully — 17 stylesheets, correct dark theme, the whole welcome screen — and
Messages once again offers **both** "Sign In" and "Pair with QR code", so the QR path that
was reported removed is back.

`set-messages-icon.sh` is left in the repo but is no longer part of setting Messages up. It
applied `icons/messages.icns` to a Safari "Add to Dock" web app on macOS, which is the
workaround this app replaces.

## Limitations

- Builds for the **host architecture** automatically (`uname -m`). On macOS export
  `ARCH=universal` for a fat binary; on Linux set `ARCH=arm64`/`x64` to cross-target.
- Web Calendar has no native snooze in notifications (a Google limitation, not this app).
- On Linux, notifications posted from inside a service worker can't be displayed — see
  [Notification paths on Linux](#notification-paths-on-linux). Calendar reminders are not
  affected.
- Not affiliated with or endorsed by Google.

---

## License

[MIT](./LICENSE) © 2026 Mike Tharpe
