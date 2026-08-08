# CLAUDE.md

Guidance for Claude Code working in this repo.

**The common request is "add \<some web app\>".** That is a config change, not a code change
— jump to [Adding an app](#adding-an-app). Everything else here exists so you don't have to
rediscover it.

---

## What this repo is

Each app is one Electron binary wrapping one web URL, packaged per service by a build
script. There is no framework and no runtime dependency: `main.js` + `preload.js` are the
whole program, and `services.conf` is the list of apps.

**Nothing here is Google-specific.** Any URL can be an app; the bundled set just happens to
be Google's. Most web apps need only a `services.conf` line and an icon, and the stealth
layer is inert for them.

The non-obvious code exists for sites that resist being embedded. A browser PWA stays tied
to a browser profile; a plain Nativefier wrapper gets blocked at Google sign-in with *"This
browser or app may not be secure."* Defeating that, while still behaving like a normal
desktop app, is what most of `main.js` and `preload.js` are for.

| File | Role |
|---|---|
| `services.conf` | **The app list.** `name \| icon \| url \| bundle-id \| categories`. Read by both installers. |
| `select-services.sh` | Turns user input (names, menu numbers, `--all`) into the set to build. Shared by both installers. |
| `build-linux.sh` | Linux: package, install under `$PREFIX`, write `.desktop` + icon ladder, resolve the icon theme. |
| `build.sh` | macOS: package, install to `~/Applications`, ad-hoc codesign. Dispatches to `build-linux.sh` on Linux. |
| `main.js` | Main process: per-account windows, header spoofing, link routing, notifications, titles, load recovery. |
| `preload.js` | Runs in the page's main world: the stealth layer + notification mirror. |
| `accounts.html` / `accounts-preload.js` | The Configure Accounts window (ordinary hardened renderer, not the stealth one). |
| `session-sync.js` | Single sign-on: shares an established Google session between the apps, encrypted, keyed by email. Fail-closed if no keyring. |
| `icons/*.icns`, `icons/png/` | App artwork. The Linux build extracts PNG from `.icns` automatically. |
| `docs/` | README images, generated from `icons/png/`. |
| `styles/<slug>.css` | Optional per-app CSS, injected on that app's own host. `styles/gmail.css` is the shipped example. |
| `icons/png/<icon>.png` | App artwork. Tidal's came from its own web app manifest, which is where to look for any site's icon. |
| `icons/theme/<Theme>/` | Icons hand-authored to match a specific icon theme, for apps that theme has nothing for. Not installed by the build — copied in by hand, and re-copied after a theme update. |

---

## The one rule: the slug

`slugify(name)` (in `select-services.sh`) turns `"Google Calendar"` into `google-calendar`,
and that one string is **simultaneously**:

- the executable name,
- the `~/.local/bin` symlink,
- the `.desktop` **filename**,
- the icon name (`Icon=google-calendar`),
- `package.json`'s `productName`, which becomes the window's `WM_CLASS`.

Break the agreement and things fail in ways that don't look related:

- `WM_CLASS` comes from `productName` baked in at package time. **Not** from the executable
  name, `app.setName()`, or `--class` — those are applied too late. Get it wrong and every
  app collapses into one taskbar icon that no `.desktop` file matches.
- Notification identity comes from the `desktop-entry` hint Electron derives from the same
  name. Rename the `.desktop` file without renaming the slug and notifications silently
  lose their icon and their entry in the desktop's notification settings.

Never rename one of these by hand. Change the name in `services.conf` and rebuild.

---

## Adding an app

### 1. Choose the URL carefully — this is where the real trap is

**Prefer the standalone page a human would use.** Plenty of web apps ship an *embedded*
variant meant to live in an iframe inside another product. Loaded standalone it renders as
a stripped-down panel and cannot theme itself, because it expects a parent frame to drive it.

This repo shipped that exact bug: Tasks was configured as
`tasks.google.com/embed/?origin=https://calendar.google.com`, which is the panel Calendar
hosts in an iframe. It rendered with no sidebar, no Lists, no account UI, and in light mode
on a dark desktop. It also redirects itself to `/tasks/`, so a manual reload "fixed" it —
which made it look like a load bug for a long time. The fix was one line:
`https://tasks.google.com/tasks/`.

Before committing a URL, load it and confirm it looks like the real app, not a widget.

### 2. Add the entry and an icon

```bash
# services.conf — Google or not, same shape
"Linear|linear|https://linear.app/|com.example.linearapp|Development;ProjectManagement;"
```

Drop `icons/linear.icns` **or** `icons/png/linear.png` in place. Supplying only the `.icns`
is fine — the Linux build extracts the largest embedded PNG itself.

The last field is a [freedesktop category
list](https://specifications.freedesktop.org/menu-spec/latest/apa.html); macOS ignores it.

### 3. Build just that app

```bash
./build-linux.sh linear          # short key, slug, or full name — any case
./build-linux.sh --list          # if unsure what a service is called
```

A subset build leaves other installed apps untouched, so this is safe to iterate on.

### 4. Verify it actually works — do not skip this

A new app can fail in ways the build cannot detect: the site may block sign-in, the page may
render blank under the stealth preferences, or the URL may be an embedded variant. See
[Verifying an app](#verifying-an-app) for the recipe.

---

## Verifying an app

**A complete DOM is not proof the right page loaded.** `readyState: "complete"` with
stylesheets and text present is entirely consistent with having loaded the wrong page. When
a symptom is visual, capture pixels — do not reason from the DOM and do not argue with what
the user reports seeing.

Launch with a debugging port and drive it over CDP:

```bash
/home/$USER/.local/lib/<slug>/<slug> --remote-debugging-port=9222 &
curl -s http://127.0.0.1:9222/json/list | python3 -m json.tool   # confirm the target + URL
```

Node 22+ has a built-in `WebSocket`, so a CDP client needs no dependencies. Write it as an
ES module (`import`, not `require`, or Node rejects the file for mixing `require` with
top-level `await`):

```js
// cdp.mjs — evaluate an expression in the app's page
import fs from 'node:fs';
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
const send = (method, params) => new Promise((resolve) => {
  const id = 1;
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id === id) resolve(m.result);
  });
  ws.send(JSON.stringify({ id, method, params }));
});
// Screenshot: the only honest check for "does this look right"
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('shot.png', Buffer.from(shot.data, 'base64'));
ws.close();
```

Then **look at the image**. Check the app's real chrome is present (sidebar, account avatar,
navigation) — not just that some text rendered.

Useful things to evaluate via `Runtime.evaluate`:

```js
location.href                                          // did it redirect somewhere else?
document.readyState
getComputedStyle(document.body).backgroundColor        // light/dark actually applied
matchMedia('(prefers-color-scheme: dark)').matches     // what the page was told
document.styleSheets.length
```

Sign-in cannot be verified without real credentials. Say so rather than implying it works.

**Always close the debug-port instance and relaunch normally when done** — it leaves an open
localhost debugging socket otherwise.

---

## Architecture notes

Things that look like they could be simplified, but cannot.

### The stealth layer

`main.js` forces a Chrome User-Agent plus matching `Sec-CH-UA` client-hint headers on every
request; `preload.js` patches the page-side fingerprint (`navigator.userAgentData`,
`navigator.webdriver`, `window.chrome`, and scrubs Electron/Node globals). **Both halves are
required** — UA spoofing alone is what Nativefier does, and it is not enough.

The spoof always claims the **host** platform. Claiming macOS while running on Linux
contradicts the rest of the fingerprint, and self-inconsistency is exactly what the check
looks for. The Chrome major is derived from `process.versions.chrome` so it can never lag
the bundled engine.

### `contextIsolation: false` **and** `sandbox: true`

Both, together, deliberately. The preload must share the page's main world to patch
`navigator`, hence no context isolation. But with the sandbox *also* off, Calendar's
live-data channel (`signaler-pa.clients6.google.com`) intermittently fails for **secondary**
multi-login accounts — the "Could not load the data" error. A sandboxed preload still
patches the main world and still reaches `ipcRenderer`, so nothing is lost.

### Notifications

Google's web notifications do not all reach the Linux desktop, and mirroring one the
platform *already* delivers shows the user two identical banners. Measured on Electron 42:

| Posted by | Electron delivers it? | What we do |
|---|---|---|
| `new Notification(...)` from the page | yes | leave alone (mirroring double-banners it) |
| `registration.showNotification(...)` from the page | never | mirror it |
| `showNotification(...)` inside a service worker | never | **cannot be fixed** — worker preloads run in a separate realm |

### Load recovery

Nothing in Electron retries a failed navigation. `main.js` adds a backoff retry on
`did-fail-load`. Two non-obvious details, both found by measurement:

- **A failed navigation still commits Chromium's error document, which fires
  `did-finish-load`.** Resetting retry state there cancels the retry microseconds after
  queueing it — the symptom is that nothing ever retries. Hence the `loadFailed` WeakSet,
  reset on `did-start-loading`.
- Retries call `loadURL(url)` rather than `reload()`, so recovery doesn't depend on what
  Chromium left in the history entry.

`ERR_ABORTED` (-3) is an ordinary superseded navigation, not a failure — retrying on it
fights the page.

### Single sign-on (session-sync.js)

Shares an *established* Google web session between the apps so each account is signed in
once, not once per app. It does not create sessions or bypass 2FA — it copies auth cookies
between the user's own apps.

Design points that are load-bearing, not incidental:

- **Keyed by `sha256(email)`, never by slot.** Slot N in two apps is *supposed* to be the
  same account, but if it isn't, keying by slot would let one app log another out of the
  right account. Keying by identity means an app only ever adopts a session for the email
  that slot is meant to be.
- **Encrypted with a key in the OS keyring**, not Electron `safeStorage` — safeStorage's key
  is scoped per app name, so one app cannot decrypt another's blob (measured). The keyring is
  chosen by capability, not platform: `getKey()` tries libsecret (`secret-tool`), KDE Wallet
  (`kwallet-query`), and macOS Keychain (`security`) in order, and enables the feature only
  for a backend that survives a real store→lookup→compare round-trip. A backend whose binary
  is absent, whose store is locked, or that silently drops the write fails that check and is
  passed over; if none passes, the feature is off. This is the answer to "we can't know the
  capabilities on someone else's machine" — it finds out by using it, never by assuming.
  Only libsecret is verified on real hardware here; kwallet and keychain are written to spec
  and made safe by the round-trip, which never reports success it didn't observe (macOS note:
  the `security -w` key is briefly visible in `ps` — a stdin path would be better once someone
  can verify it on real macOS).
- **Publish on `did-finish-load`, not only on cookie-`changed`.** Cookies restored from disk
  on a normal launch arrive with no `changed` event, so a signed-in app that just starts up
  would never share its session. The cookie listener still covers interactive login and
  rotation.
- **Gather cookies with `get({})` then filter, never `get({domain})`.** The domain query
  misses host-only auth cookies on subdomains (accounts./mail.google.com) — measured 17 vs 43,
  and a 17-cookie graft does NOT sign you in. This one shipped as a bug in the first draft and
  was only caught by loading Gmail and checking the result, not by counting cookies.

Test the round-trip without touching a real profile: run `session-sync.js`'s `adoptBeforeLoad`
against the real store file but into a scratch `--user-data-dir`, then load the app and check
`signedIn`. A cookie count is not enough — verify the page is actually authenticated.

### DRM (why Electron is a fork here)

`package.json` pins Electron to [castlabs ECS](https://github.com/castlabs/electron-releases)
(`v42.8.0+wvcus`), not stock Electron. Stock ships no Widevine CDM, so a DRM service cannot
play in it — measured, `requestMediaKeySystemAccess('com.widevine.alpha')` throws
`NotSupportedError`. It is a drop-in fork at the same Electron version, so the non-DRM apps
run on an identical Chromium.

Three ways this bites if you are not expecting it:

- **Never run `npm install electron`.** Naming the package explicitly resolves stock Electron
  from the registry and silently replaces the fork; apps still build and simply never play
  DRM. The build scripts run a bare `npm install` deliberately.
- **`ELECTRON_MIRROR` must point at the fork.** `@electron/packager` downloads the Electron
  dist itself and defaults to `electron/electron`, where the `+wvcus` tag does not exist —
  the build 404s. Both build scripts export it.
- **Windows in a DRM app must wait for `components.whenReady()`.** A renderer created before
  the CDM is installed never gets one and fails to play for its whole life.
  `whenWidevineReady()` does this, bounded at 15s so a machine with no network still opens
  its windows. **Non-DRM apps skip the wait**: it is gated on `cfg.drm`, which is set from
  the `drm` column in `services.conf`. Without the flag the wait is 0 ms AND the ~21 MB
  Widevine CDM is never downloaded per app — pure loss for apps that never touch DRM.

Verify with `createMediaKeys()`, not just `requestMediaKeySystemAccess` — the former proves a
usable CDM rather than a feature-detect:

```js
const a = await navigator.requestMediaKeySystemAccess('com.widevine.alpha', [{
  initDataTypes: ['cenc'],
  audioCapabilities: [{ contentType: 'audio/mp4; codecs="mp4a.40.2"' }]
}]);
await a.createMediaKeys();
```

### Per-app CSS

`styles/<slug>.css` (shipped) and `<userData>/custom.css` (the user's) are concatenated and
injected on every document load, but **only on the app's own host** — a Gmail rule has no
business running on the sign-in page or an SSO provider's.

This was Gmail-specific code in `main.js` until it became a file convention. If a new app
needs a tweak, add a stylesheet; do not add a hostname branch.

`app-config.json` carries the `slug` for this, written by both build scripts.

**Verifying injection:** `document.styleSheets` does **not** enumerate what
`webContents.insertCSS` adds — checking there reports a false negative. Test with a custom
property instead:

```css
:root { --probe: yes; }        /* temporarily, in the stylesheet */
```
```js
getComputedStyle(document.documentElement).getPropertyValue('--probe')
```

### Icon theming (Linux)

The `.desktop` icon is themed for free: `Icon=<slug>` is a *name*, resolved through the
user's active theme. The runtime icon (`resources/app-icon.png`, used for notification
banners and the window) is a *path*, so the installer resolves it at build time against the
machine's theme and rasterises SVG to 256px.

**Read each theme's `index.theme` `Directories`, never walk the tree.** Themes symlink
subdirectories into sibling themes (`Colloid-Dark/apps/scalable ->
../../Colloid-Light/apps/scalable`), and `os.walk` does not follow symlinks — a walk
silently misses those icons and falls through to hicolor, the opposite of what the desktop
shows. Bundled icons stay installed in `hicolor` even when a theme wins; it is the end of
every inheritance chain and the only thing preventing a blank icon after a theme switch.

Cross-check any change here against GTK's own resolver:

```bash
python3 -c "
import gi; gi.require_version('Gtk','3.0')
from gi.repository import Gtk
print(Gtk.IconTheme.get_default().lookup_icon('google-keep', 256, 0).get_filename())"
```

---

## Build & install

```bash
./build-linux.sh                   # interactive menu; all apps if not a terminal
./build-linux.sh gmail keep        # subset — leaves other installed apps alone
./build-linux.sh --all --list      # everything / show the catalogue
./build-linux.sh --uninstall [names...]
PREFIX=/some/where ./build-linux.sh
ICON_THEME=Papirus-Dark ./build-linux.sh
```

Installs entirely under `$PREFIX` (default `~/.local`) — no root, nothing system-wide.
`--uninstall` deliberately leaves signed-in sessions in `~/.config/<App Name>/` alone.

The build rewrites `package.json`'s `productName` per service and restores it on exit,
trapping `INT TERM HUP PIPE` as well as `EXIT` — piping the build into something that exits
early would otherwise strand a half-built `productName` in the working tree.

Scripts must stay **bash 3.2 compatible** (macOS still ships it): no associative arrays, no
`mapfile`, no bare expansion of a possibly-empty array under `set -u` — use
`${arr[@]+"${arr[@]}"}`.

---

## Debugging playbook

| Symptom | First thing to check |
|---|---|
| Page looks wrong / half-rendered | Screenshot it over CDP. Then compare `location.href` against `services.conf` — an embedded variant is the usual cause. |
| Blank or stale after wake-from-sleep | `journalctl --user --since today \| grep -i <slug>` for `ERR_INTERNET_DISCONNECTED`. |
| App doesn't appear in the menu | `update-desktop-database ~/.local/share/applications`; some sessions only rescan at login. |
| All apps share one taskbar icon | `WM_CLASS` / `productName` mismatch — rebuild, don't rename files. |
| Notification has a generic icon | `.desktop` filename must equal the slug. |
| Sign-in says "browser may not be secure" | Bump `electron` in `package.json` and rebuild; the spoofed version follows automatically. |

Apps enforce a single instance **per user-data dir**, so a second launch just focuses the
running window. To run an isolated instance for testing, pass
`--user-data-dir=/tmp/scratch` — that also gives you a signed-out profile.

---

## Conventions

- **Commits must be signed.** `main` is protected: signed commits required, enforced for
  admins, no force-push, no deletion. Direct pushes to `main` are allowed if signed.
- Branch for changes and open a PR; recent history is all merged PRs.
- Conventional-commit subjects (`fix:`, `feat:`, `docs:`, `fix(tasks):`).
- Commit bodies here carry *why*, and record what was measured rather than assumed. Match
  that — a body explaining a non-obvious finding is worth more than a tidy subject.
- Comments in this codebase explain reasoning, not mechanics. Keep that density; do not add
  narration of what the next line does.
- **Do not claim something works that you did not verify.** Say plainly what was tested,
  what was not, and why.
