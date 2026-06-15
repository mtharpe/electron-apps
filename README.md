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
- **Enterprise SSO works** — corporate Workspace sign-in that redirects to a third-party
  identity provider (Okta, Microsoft Entra, Ping, Duo, …) completes **in-app**, even when
  the IdP opens in a popup. Vanity SSO domains are configurable without a rebuild.
- **Per-account window titles** — each window is titled with just the account/org name
  (e.g. *Spectro Cloud*), so account windows are easy to tell apart in ⌘-Tab / Mission
  Control / the **Window** menu.
- **Consistent Gmail view** — Workspace Gmail's extra left **Mail/Chat/Meet/Spaces** rail
  is hidden so every account looks like clean personal Gmail.
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
| `main.js` | Main process: per-account isolated windows, menus, request-header spoofing, permission grants, the **notification mirror** IPC handler, **enterprise-SSO routing**, **per-account window titles**, the **Gmail view normalizer**, maximize-on-start. |
| `preload.js` | Runs in the page's main world; the **stealth layer** + the client-side **notification mirror**. |
| `build.sh` | Builds/installs/signs all four; service list lives in the `SERVICES` array. Builds for the host arch (or `ARCH=universal`). |
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
Edit the `SERVICES` array in `build.sh` (`name | icon | url | bundle-id`), drop a matching
`icons/<name>.icns` in place, and re-run `./build.sh`.

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
- creating a JSON array at `~/Library/Application Support/<App Name>/auth-domains.json`, e.g.
  ```json
  ["login.example.com", "sso.example.com"]
  ```

Suffixes are matched against the host and its subdomains; lookalikes like `okta.com.evil.com`
are correctly treated as external.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| "This browser or app may not be secure" at sign-in | The stealth layer should handle it; if it regresses, bump the Chrome version (above). |
| Calendar: "Could not load the data" on a **Workspace** calendar | Fixed by the sandboxed renderer (secondary multi-login accounts no longer fail). If it ever recurs: `⌘R` to reload (windows also auto-reload on wake); if it happens on *first* load for everyone, the bundled Chromium may be too old — bump `electron` in `package.json` and rebuild. |
| Gmail still shows the Mail/Chat/Meet left rail | Make sure you relaunched the rebuilt app (⌘Q first). The hider keys off the buttons' `aria-label`s; if a Gmail redesign changes them it'll quietly stop matching — open an issue / update the selector in `main.js` (`GMAIL_RAIL_HIDE_CSS`). |
| Notification plays a sound but no banner | Expected if the app is frontmost (macOS suppresses it) — switch apps. Otherwise set the app's macOS notification style to **Alerts**. |
| App won't open ("unidentified developer") | Apps are ad-hoc signed and built locally (not quarantined); if macOS still blocks, right-click → **Open** once. |
| Need to re-login everywhere | Sessions are per-app and per-account-slot by design (full isolation). |
| Corporate (SSO) sign-in opens in Chrome / can't complete | The IdP isn't recognized. If it's on a company vanity domain, add it via `GOOGLE_APP_AUTH_DOMAINS` or `auth-domains.json` (see **Enterprise SSO** above), then retry. |

---

## Security notes

- The User-Agent / fingerprint spoofing exists solely to let **your own** Google accounts
  sign in to **your own** standalone apps — it doesn't bypass any authentication.
- `contextIsolation` is disabled because the stealth preload must run in the page's main
  world, but the renderer **sandbox stays on** (`sandbox: true`). These wrappers load only
  first-party Google URLs (plus recognized SSO providers during sign-in); other external
  links open in your default browser. Google-host matching is suffix-based, so lookalike
  domains are treated as external.
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
