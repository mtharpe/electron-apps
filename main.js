const { app, BrowserWindow, Menu, session, shell, Notification, ipcMain, powerMonitor, nativeTheme, dialog, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile, execFileSync, spawn } = require('child_process');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'app-config.json'), 'utf8'));
const APP_NAME = cfg.name;
const APP_URL = cfg.url;

const IS_MAC = process.platform === 'darwin';

// Linux has no per-app icon baked into the executable the way a macOS .app carries its
// .icns, so the Linux build ships a PNG we hand to every window (taskbar/alt-tab identity)
// and to native notifications. Absent on macOS — where the bundle icon already covers
// both — so this is null there and every use site is a no-op.
//
// It lives in resources/ NEXT TO the asar rather than inside it: the notification icon is
// handed to the desktop's notification daemon as a plain filesystem path, and a separate
// process cannot read a path inside an asar archive (Electron's asar support is a patch
// over ITS OWN fs, not a real mount). resourcesPath covers the packaged app; __dirname
// covers running unpackaged from a checkout.
const APP_ICON = (() => {
  if (IS_MAC) return null;
  const candidates = [
    path.join(process.resourcesPath || '', 'app-icon.png'),
    path.join(__dirname, 'app-icon.png'),
  ];
  for (const p of candidates) {
    try { if (p && fs.existsSync(p)) return p; } catch (e) { /* try next */ }
  }
  return null;
})();

// Per-app CSS. Two sources, both optional, concatenated in this order:
//
//   styles/<slug>.css                 shipped with the app (styles/gmail.css hides Workspace
//                                     Gmail's Mail/Chat/Meet/Spaces rail, for example)
//   <userData>/custom.css             the user's own, not overwritten by a rebuild
//
// This used to be a Gmail-specific constant and a hostname test hardcoded in this file.
// Nothing about "restyle this app's pages" is Gmail-specific, and a wrapper for a
// non-Google app is just as likely to want a rule, so it is a file convention now.
//
// Injected as a stylesheet rather than an inline style so it survives the page's re-renders.
const APP_SLUG = typeof cfg.slug === 'string' ? cfg.slug : '';

// Only the app's OWN host gets styled. A rule written for Gmail has no business running on
// accounts.google.com during sign-in, or on an SSO provider's page.
const APP_HOST = (() => { try { return new URL(APP_URL).hostname.toLowerCase(); } catch (e) { return ''; } })();

let CUSTOM_CSS = '';

// Read once, after app.setName() — userData is named after the app, so the path is not
// stable before then.
function loadCustomCss() {
  const parts = [];
  const sources = [
    APP_SLUG ? path.join(__dirname, 'styles', APP_SLUG + '.css') : null,
    path.join(app.getPath('userData'), 'custom.css'),
  ];
  for (const file of sources) {
    if (!file) continue;
    // __dirname is inside the asar in a packaged build; Electron patches fs to read it.
    try { parts.push(fs.readFileSync(file, 'utf8')); } catch (e) { /* absent is the normal case */ }
  }
  CUSTOM_CSS = parts.join('\n');
}

// Re-apply on every document load. This must cover EVERY webContents, not just the first
// account window: picking another account from an account switcher opens it in a NEW window,
// and that window needs the rule too. Registered globally below via 'web-contents-created'.
function applyCustomStyles(wc) {
  wc.on('dom-ready', () => {
    if (!CUSTOM_CSS) return;
    try {
      if (hasSuffix(new URL(wc.getURL()).hostname, [APP_HOST])) wc.insertCSS(CUSTOM_CSS);
    } catch (e) { /* ignore */ }
  });
}

// Window title = JUST the account/org name (e.g. "Acme Corp", "Gmail") so each account's
// window is easy to pick out in ⌘-Tab / Mission Control / the Window menu. Google puts the org
// name in the page title for Gmail & Calendar; Keep/Tasks don't, so we fall back to the
// signed-in email (read from the account avatar), then to whatever the page title is.
const ACCOUNT_TITLE_JS = `(function(){
  function s(x){return (x||'').trim();}
  var host=location.hostname, t=document.title||'';
  if (/mail\\.google\\.com$/.test(host)) { var p=t.split(' - '); return s((p[p.length-1]||'').replace(/\\s*Mail$/,'')); }
  if (/calendar\\.google\\.com$/.test(host)) { return s(t.split(' - ')[0]); }
  var a=document.querySelector('[aria-label*="Google Account" i]');
  if (a) { var m=(a.getAttribute('aria-label')||'').match(/[\\w.+-]+@[\\w.-]+\\.[A-Za-z]{2,}/); if (m) return m[0]; }
  return s(t);
})()`;

function manageWindowTitle(wc) {
  const apply = () => {
    // A configured account name (or the name of the Chrome profile it maps to) is a
    // deliberate choice by the user and outranks anything scraped from the page.
    const pinned = accountLabel(slotOf(wc));
    if (pinned) {
      const win = BrowserWindow.fromWebContents(wc);
      if (win && !win.isDestroyed()) win.setTitle(pinned);
      return;
    }
    wc.executeJavaScript(ACCOUNT_TITLE_JS, true).then((label) => {
      const win = BrowserWindow.fromWebContents(wc);
      if (win && !win.isDestroyed() && label) win.setTitle(label);
    }).catch(() => { /* ignore */ });
  };
  // Stop Electron from auto-applying Google's full page title, then set our short one.
  wc.on('page-title-updated', (e) => { e.preventDefault(); apply(); });
  wc.on('dom-ready', apply);
}

// Nothing in Electron retries a navigation that dies — DNS not up yet at login, the
// network still coming back after sleep, a connection dropped mid-load. The window is just
// left holding whatever it had. Gmail and Calendar mostly self-heal, because their live
// data connections keep re-rendering; Tasks and Keep inject their whole stylesheet from the
// app bundle and then go idle, so a load that dies part-way leaves a permanently blank
// white window until the user reloads by hand. Hence: retry, with a backoff so a genuinely
// unreachable network isn't hammered.
const RELOAD_BACKOFF_MS = [1000, 2000, 5000, 10000, 20000, 30000];
// While the machine is offline a retry cannot succeed, so we wait on the network coming
// back instead of spending (and escalating) an attempt on a certain failure.
const OFFLINE_POLL_MS = 2000;
const ERR_ABORTED = -3;
// How long a new window waits for a first frame before it is shown anyway.
const REVEAL_DEADLINE_MS = 4000;

// Keyed by webContents so the state dies with the window it belongs to.
const reloadAttempts = new WeakMap();
const reloadTimers = new WeakMap();

function cancelReloadRetry(wc) {
  const timer = reloadTimers.get(wc);
  if (timer) { clearTimeout(timer); reloadTimers.delete(wc); }
}

// `url` is the address to retry. Retrying a failed navigation loads that address again
// explicitly rather than calling reload(), which would depend on what Chromium left in the
// history entry after the failure — loading the known-good URL does not. Omit `url` (the
// post-sleep path) to refresh whatever the window is already showing.
function scheduleReload(wc, url) {
  if (wc.isDestroyed() || reloadTimers.has(wc)) return; // one retry in flight at a time
  const attempt = reloadAttempts.get(wc) || 0;
  const delay = RELOAD_BACKOFF_MS[Math.min(attempt, RELOAD_BACKOFF_MS.length - 1)];
  reloadTimers.set(wc, setTimeout(() => {
    reloadTimers.delete(wc);
    if (wc.isDestroyed()) return;
    // Still no network: come back later WITHOUT counting this as an attempt, so the backoff
    // reflects real failed loads rather than how long the laptop sat offline.
    if (!net.isOnline()) {
      reloadTimers.set(wc, setTimeout(() => { reloadTimers.delete(wc); scheduleReload(wc, url); }, OFFLINE_POLL_MS));
      return;
    }
    reloadAttempts.set(wc, attempt + 1);
    // A rejection here is the same failure did-fail-load is about to report, and that
    // handler is what queues the next attempt — so swallow it rather than double-counting.
    if (url) wc.loadURL(url, { userAgent: CHROME_UA }).catch(() => {});
    else wc.reload();
  }, delay));
}

// Whether the load currently in flight has already reported a failure. Reset at the start
// of every navigation, so it always describes the attempt in progress and nothing else.
const loadFailed = new WeakSet();

function attachLoadRecovery(wc) {
  wc.on('did-start-loading', () => loadFailed.delete(wc));

  wc.on('did-fail-load', (e, errorCode, errorDesc, validatedURL, isMainFrame) => {
    // A dead subresource or iframe is not a dead window — Google's pages routinely lose a
    // hovercard or a cookie-rotation frame and carry on fine. Only the main frame matters.
    if (!isMainFrame) return;
    // ERR_ABORTED is an ordinary superseded navigation (a redirect taking over, the user
    // clicking through mid-load), not a failure. Reloading on it would fight the page.
    if (errorCode === ERR_ABORTED) return;
    loadFailed.add(wc);
    scheduleReload(wc, validatedURL);
  });

  wc.on('did-finish-load', () => {
    // A failed navigation still COMMITS Chromium's error document, and finishing that
    // document fires this event — measured: did-fail-load, then did-finish-load for the
    // same URL. Resetting here unconditionally cancelled the retry that had just been
    // queued, which is why nothing ever retried. Only a load that did not fail counts.
    if (loadFailed.has(wc)) return;
    // A load that lands clears the backoff, so a later unrelated failure starts fresh.
    cancelReloadRetry(wc);
    reloadAttempts.delete(wc);
  });

  wc.on('destroyed', () => cancelReloadRetry(wc));
}

app.on('web-contents-created', (e, wc) => {
  applyCustomStyles(wc);
  manageWindowTitle(wc);
  attachExternalLinkRouting(wc);
  attachLoadRecovery(wc);
  wc.on('dom-ready', () => rememberAccountEmail(wc));
});

// Pose as stock desktop Chrome. Report the REAL bundled Chromium major (not a hardcoded
// number) so the spoofed version can never lag the engine after an Electron bump — a stale
// major makes Google reject the app (Calendar then shows "could not load the data"). Paired
// with preload.js (which fixes the JS-side fingerprints), this is what gets past Google's
// "browser may not be secure" gate.
// Spoof the HOST platform, not a fixed one: claiming macOS while running on Linux would
// contradict every other signal Google sees (Sec-CH-UA-Platform, navigator.platform, the
// GPU/font fingerprint), and a self-inconsistent client is exactly what the "browser may
// not be secure" check looks for. preload.js derives the same values from process.platform.
const CHROME_MAJOR = process.versions.chrome.split('.')[0];
const UA_OS = IS_MAC ? 'Macintosh; Intel Mac OS X 10_15_7' : 'X11; Linux x86_64';
const CHROME_UA =
  'Mozilla/5.0 (' + UA_OS + ') AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/' + CHROME_MAJOR + '.0.0.0 Safari/537.36';
const SEC_CH_UA =
  '"Google Chrome";v="' + CHROME_MAJOR + '", "Chromium";v="' + CHROME_MAJOR + '", "Not.A/Brand";v="24"';
const SEC_CH_UA_PLATFORM = IS_MAC ? '"macOS"' : '"Linux"';

const STEALTH_WEBPREFS = {
  preload: path.join(__dirname, 'preload.js'),
  contextIsolation: false, // preload must share the page's main world to patch navigator
  // Keep the renderer sandboxed. contextIsolation:false WITH sandbox:false intermittently
  // breaks Google Calendar data loading for SECONDARY multi-login accounts (the cross-origin
  // signaler-pa.clients6.google.com channel fails with net::ERR_FAILED → "could not load the
  // data"); sandbox:true fixes it. The preload still patches the main world (sign-in stealth)
  // and still gets ipcRenderer via require('electron') (notification mirror) when sandboxed.
  sandbox: true,
  nodeIntegration: false,
  spellcheck: true,
  backgroundThrottling: false, // keep this window's timers/connection live in the background
};

// Electron does not pick up the desktop's dark preference on Linux: on a GNOME 50
// session with gtk-theme=Adwaita-dark, gtk-application-prefer-dark-theme=1 AND the
// portal reporting color-scheme=1, Electron 42 still reports
// nativeTheme.shouldUseDarkColors === false under every ozone platform (wayland,
// x11, default). Left alone that means a light window frame and a white flash on
// open, regardless of how the desktop is themed.
//
// So resolve the preference ourselves from the freedesktop appearance portal — the
// same source GNOME's own settings feed — and set themeSource explicitly. Reading
// it rather than hardcoding 'dark' keeps the app following the desktop if it
// switches to light. gdbus is used instead of a D-Bus module to avoid adding a
// runtime dependency to a package that otherwise has none.
//
// The portal is not always right either: a desktop can report color-scheme=1 while the
// user runs light window decorations (or the reverse), and there is no way for us to tell
// which one the user actually meant. So the portal is only ever consulted in "System"
// mode — View ▸ Appearance lets the user pin Light or Dark, and that choice wins over
// every form of detection and persists across restarts.
//
//   org.freedesktop.appearance color-scheme: 0 = no preference, 1 = dark, 2 = light
const COLOR_SCHEME_DARK = 1;
const COLOR_SCHEME_LIGHT = 2;

// 'system' | 'light' | 'dark'. Stored per app (each app has its own userData dir), so
// Gmail can be dark while Calendar is light if that is what the user wants.
const THEME_PREFS = ['system', 'light', 'dark'];
let themePreference = 'system';

function themePrefFile() {
  // app.getPath('userData') derives from the app name, so this is only correct after
  // app.setName() has run — every call site below is on that side of it.
  return path.join(app.getPath('userData'), 'appearance.json');
}

function loadThemePreference() {
  try {
    const v = JSON.parse(fs.readFileSync(themePrefFile(), 'utf8')).theme;
    if (THEME_PREFS.includes(v)) themePreference = v;
  } catch {
    // No file yet, or it is unreadable/corrupt — 'system' is the right answer either way.
  }
}

function saveThemePreference() {
  try {
    fs.writeFileSync(themePrefFile(), JSON.stringify({ theme: themePreference }) + '\n');
  } catch (e) {
    // A failed write only costs the choice at next launch; don't take the app down for it.
  }
}

function portalColorScheme() {
  if (IS_MAC || process.platform === 'win32') return null;
  try {
    const out = execFileSync('gdbus', [
      'call', '--session',
      '--dest', 'org.freedesktop.portal.Desktop',
      '--object-path', '/org/freedesktop/portal/desktop',
      '--method', 'org.freedesktop.portal.Settings.ReadOne',
      'org.freedesktop.appearance', 'color-scheme',
    ], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
    const m = out.match(/uint32\s+(\d+)/);
    return m ? Number(m[1]) : null;
  } catch {
    return null; // no portal, no gdbus, or the call timed out
  }
}

// The one place that decides which way this app should look: the pinned preference if
// there is one, otherwise whatever the portal reports. null = "genuinely no answer",
// which every caller treats as "leave the platform alone".
function resolveScheme() {
  if (themePreference !== 'system') return themePreference;
  const scheme = portalColorScheme();
  if (scheme === COLOR_SCHEME_DARK) return 'dark';
  if (scheme === COLOR_SCHEME_LIGHT) return 'light';
  return null;
}

function applyColorScheme() {
  const scheme = resolveScheme();
  // No answer falls back to the desktop-wide setting Electron *did* manage to read,
  // rather than forcing a choice.
  nativeTheme.themeSource = scheme || 'system';
}

// themeSource covers the web content and Electron's own UI, but NOT the window frame.
// On GNOME the titlebar is drawn from the GTK theme Chromium loads, and Chromium misses
// the desktop's dark preference the same way nativeTheme does — hence a light titlebar on
// a fully dark desktop. GTK_THEME=<theme>:<variant> is the only lever that moves it, and
// GTK reads it once at init, so it has to be in the environment before the toolkit starts.
//
// The base theme name comes from the desktop rather than being hardcoded to Adwaita, so a
// custom GTK theme keeps its own look and only its light/dark variant is pinned.
function gtkThemeBase() {
  try {
    const out = execFileSync('gsettings', ['get', 'org.gnome.desktop.interface', 'gtk-theme'], {
      encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const name = out.trim().replace(/^'|'$/g, '').split(':')[0];
    // "Adwaita-dark" and "Adwaita" are the same theme; the variant is what we are setting.
    const base = name.replace(/-dark$/i, '');
    if (base) return base;
  } catch {
    // gsettings missing or non-GNOME — fall through.
  }
  return 'Adwaita';
}

// What GTK_THEME was set to for this process, so a later menu change can tell whether the
// frame is actually stale (a restart is needed) or already correct.
let appliedGtkVariant = null;

function applyGtkTheme() {
  if (IS_MAC || process.platform === 'win32') return;
  // An explicitly exported GTK_THEME is the user overriding us from outside; don't fight it.
  // GTK_THEME_FROM_APP marks the value as one WE set: app.relaunch() hands the child our
  // environment, so without the marker a restart would inherit the stale value it was
  // supposed to replace and treat it as a user override forever.
  if (process.env.GTK_THEME && !process.env.GTK_THEME_FROM_APP) {
    appliedGtkVariant = /:light/i.test(process.env.GTK_THEME) ? 'light'
      : /:dark/i.test(process.env.GTK_THEME) ? 'dark' : null;
    return;
  }
  const scheme = resolveScheme();
  if (!scheme) return; // nothing to go on — leave GTK to its own defaults
  process.env.GTK_THEME = gtkThemeBase() + ':' + scheme;
  process.env.GTK_THEME_FROM_APP = '1';
  appliedGtkVariant = scheme;
}

// GTK only reads GTK_THEME at init, so a change made from the menu cannot repaint the
// frame of a running process — only a restart can. Ask rather than yanking the windows
// out from under the user, and only when the frame is genuinely stale.
function offerRestartIfFrameStale() {
  if (IS_MAC || process.platform === 'win32') return;
  const scheme = resolveScheme();
  if (!scheme || scheme === appliedGtkVariant) return;
  dialog.showMessageBox({
    type: 'question',
    buttons: ['Restart Now', 'Later'],
    defaultId: 0,
    cancelId: 1,
    message: 'Restart ' + APP_NAME + ' to finish switching to ' + scheme + '?',
    detail: 'The page and window background have already changed. The window frame is drawn '
      + 'by GTK, which only reads the theme when the app starts, so the titlebar keeps its '
      + 'current colour until ' + APP_NAME + ' is restarted.',
  }).then(({ response }) => {
    if (response !== 0) return;
    app.relaunch();
    app.exit(0);
  }).catch(() => { /* dialog failed; the choice is still saved for next launch */ });
}

// Window background must match, or every window opens as a white rectangle before
// the page paints — the most visible part of the problem on a dark desktop.
function windowBackground() {
  return nativeTheme.shouldUseDarkColors ? '#202124' : '#ffffff';
}

function setThemePreference(pref) {
  if (!THEME_PREFS.includes(pref)) return;
  themePreference = pref;
  saveThemePreference();
  applyColorScheme();
  // Repaint what is already open: backgroundColor is otherwise only read at construction,
  // so live windows would keep the old flash colour until they were reopened.
  for (const win of windows.values()) {
    if (win && !win.isDestroyed()) win.setBackgroundColor(windowBackground());
  }
  buildMenu(); // refresh the radio checkmark
  offerRestartIfFrameStale();
}

// In System mode, follow the desktop when it changes rather than only at launch. Electron's
// own nativeTheme 'updated' event does not fire for this on Linux (it never saw the change
// in the first place — that is the whole reason the portal is read here), so watch the
// portal's SettingChanged signal directly. Best-effort: if gdbus or the portal is missing,
// System mode simply stays at whatever it resolved to on startup.
let portalWatcher = null;
function watchPortalColorScheme() {
  if (IS_MAC || process.platform === 'win32' || portalWatcher) return;
  try {
    portalWatcher = spawn('gdbus', [
      'monitor', '--session',
      '--dest', 'org.freedesktop.portal.Desktop',
      '--object-path', '/org/freedesktop/portal/desktop',
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    portalWatcher.stdout.setEncoding('utf8');
    portalWatcher.stdout.on('data', (chunk) => {
      if (!/SettingChanged/.test(chunk) || !/color-scheme/.test(chunk)) return;
      if (themePreference !== 'system') return; // an explicit choice outranks the desktop
      applyColorScheme();
      for (const win of windows.values()) {
        if (win && !win.isDestroyed()) win.setBackgroundColor(windowBackground());
      }
    });
    portalWatcher.on('error', () => { portalWatcher = null; });
    portalWatcher.unref();
  } catch (e) {
    portalWatcher = null;
  }
}

// Accounts: a display name and a Chrome profile per account slot.
//
// Clicking a link used to hand the URL to `google-chrome <url>`, which drops it into
// whichever profile window Chrome happens to have in focus — so a link from the work
// account could land in the personal profile (or a profile that can't even see it).
// Chrome takes --profile-directory=<dir> to pick the target explicitly, so each slot can
// be pinned to one.
//
// The mapping is keyed by slot number rather than by email: the slot is what actually owns
// the cookie jar (persist:account-N), it exists before any page has loaded, and it survives
// the user signing a window into a different account.
const ACCOUNT_SLOTS = 6;

// chromeProfile is 'auto' (match the signed-in address to a Chrome profile), 'none' (hand
// the URL over with no profile flag — Chrome's focused-window behaviour), or a profile
// directory name such as 'Default' / 'Profile 2'.
const PROFILE_AUTO = 'auto';
const PROFILE_NONE = 'none';

const accounts = new Map(); // slot -> { name, chromeProfile, email }

// Deliberately NOT under userData: "Account 2 is Work" is a fact about the user's accounts,
// not about Gmail-the-app, so every app shares one file rather than making the user name the
// same accounts once per app. (Appearance stays per app — that one really is a per-window
// preference.) The sessions themselves stay isolated per app as before; this shares the
// labels and the routing, nothing else.
const ACCOUNTS_DIR = path.join(app.getPath('appData'), 'electron-apps');

function accountsFile() {
  return path.join(ACCOUNTS_DIR, 'accounts.json');
}

// Where this app's own copy used to live, before the file was shared.
function legacyAccountsFile() {
  return path.join(app.getPath('userData'), 'accounts.json');
}

// Where the shared file lived while every app in the set was a Google app.
function legacySharedAccountsFile() {
  return path.join(app.getPath('appData'), 'google-standalone-apps', 'accounts.json');
}

function parseAccounts(text) {
  const out = new Map();
  const raw = JSON.parse(text);
  for (const [k, v] of Object.entries(raw)) {
    const n = Number(k);
    if (!Number.isInteger(n) || n < 1 || !v || typeof v !== 'object') continue;
    out.set(n, {
      name: typeof v.name === 'string' ? v.name.trim() : '',
      chromeProfile: typeof v.chromeProfile === 'string' ? v.chromeProfile : PROFILE_AUTO,
      email: typeof v.email === 'string' ? v.email : '',
    });
  }
  return out;
}

function loadAccounts() {
  try {
    const parsed = parseAccounts(fs.readFileSync(accountsFile(), 'utf8'));
    accounts.clear();
    for (const [n, cfg] of parsed) accounts.set(n, cfg);
  } catch {
    // Missing or corrupt: missing is the first run, corrupt should not wipe the mapping.
  }
  migrateLegacyAccounts();
}

// Fold older locations into the current shared file. Deliberately a merge rather than a
// "shared file missing? adopt mine": the apps start in any order, and the first of them to
// detect an address creates the shared file — so a plain existence check would let whichever
// app happened to start first discard names set in another.
//
// Newest scheme first, so a gap is filled from the most recent source that has a value.
function migrateLegacyAccounts() {
  // The old SHARED file is never renamed away. Apps are installed individually now, so
  // rebuilding just one of them must not strand the others — anything still running the old
  // build keeps reading that file, and leaving it costs nothing because the merge only ever
  // fills gaps. It stops being consulted once every app has been rebuilt.
  mergeAccountsFrom(legacySharedAccountsFile(), false);
  // This app's pre-sharing copy, which only it can own — safe to retire once merged.
  mergeAccountsFrom(legacyAccountsFile(), true);
}

// Only gaps are filled; anything already in the shared file was set later and wins. When
// `retire` is set the source is renamed rather than deleted, both so it runs once and so the
// old values are still there if the merge ever gets it wrong.
function mergeAccountsFrom(file, retire) {
  let legacy;
  try {
    legacy = parseAccounts(fs.readFileSync(file, 'utf8'));
  } catch {
    return; // not present (the normal case from here on)
  }
  const touched = [];
  for (const [n, old] of legacy) {
    const current = accounts.get(n);
    if (!current) {
      accounts.set(n, old);
      touched.push(n);
      continue;
    }
    const merged = Object.assign({}, current);
    let changed = false;
    if (!merged.name && old.name) { merged.name = old.name; changed = true; }
    if (!merged.email && old.email) { merged.email = old.email; changed = true; }
    if ((!merged.chromeProfile || merged.chromeProfile === PROFILE_AUTO)
        && old.chromeProfile && old.chromeProfile !== PROFILE_AUTO) {
      merged.chromeProfile = old.chromeProfile;
      changed = true;
    }
    if (changed) { accounts.set(n, merged); touched.push(n); }
  }
  if (touched.length) persistSlots(touched);
  if (retire) {
    try { fs.renameSync(file, file + '.migrated'); } catch (e) { /* leave it; the merge is idempotent */ }
  }
}

// Write only the slots that actually changed, merging into whatever is on disk right now.
// With several apps sharing one file, serializing this process's whole in-memory copy would
// let a long-running app quietly revert a change another app made after it started.
function persistSlots(slotNumbers) {
  let onDisk = {};
  try {
    onDisk = JSON.parse(fs.readFileSync(accountsFile(), 'utf8')) || {};
  } catch {
    onDisk = {};
  }
  for (const n of slotNumbers) {
    const cfg = accountConfig(n);
    // A slot carrying no information is dropped rather than written as an empty record.
    if (!cfg.name && !cfg.email && (!cfg.chromeProfile || cfg.chromeProfile === PROFILE_AUTO)) {
      delete onDisk[n];
    } else {
      onDisk[n] = {
        name: cfg.name || '',
        chromeProfile: cfg.chromeProfile || PROFILE_AUTO,
        email: cfg.email || '',
      };
    }
  }
  try {
    fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });
    fs.writeFileSync(accountsFile(), JSON.stringify(onDisk, null, 2) + '\n');
  } catch (e) {
    // Same tradeoff as the appearance file: losing the write costs the setting, not the app.
  }
}

// Pick up changes made in one of the other three apps while this one is running, so a name
// set in Gmail shows up in Calendar's Accounts menu without restarting it. Watching the
// directory rather than the file survives the write replacing the inode.
let accountsWatcher = null;
let accountsReloadTimer = null;
function watchAccountsFile() {
  if (accountsWatcher) return;
  try {
    fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });
    accountsWatcher = fs.watch(ACCOUNTS_DIR, (eventType, filename) => {
      if (filename && filename !== 'accounts.json') return;
      // Debounced: a single save can emit several events, and our own writes land here too.
      clearTimeout(accountsReloadTimer);
      accountsReloadTimer = setTimeout(() => {
        loadAccounts();
        refreshAccountPresentation();
      }, 150);
    });
  } catch (e) {
    accountsWatcher = null; // no inotify (or no directory) — changes land at next launch
  }
}

function accountConfig(n) {
  return accounts.get(n) || { name: '', chromeProfile: PROFILE_AUTO, email: '' };
}

// Chrome records every profile — its directory, its display name and the address it is
// signed into — in Local State. That is the whole reason auto-detection can work without
// the user mapping anything by hand. Cached on mtime: it is re-read when Chrome actually
// changes it (profile added/renamed), not on every link click.
const CHROME_STATE_FILES = IS_MAC
  ? [path.join(app.getPath('home'), 'Library/Application Support/Google/Chrome/Local State')]
  : [
    path.join(app.getPath('home'), '.config/google-chrome/Local State'),
    path.join(app.getPath('home'), '.var/app/com.google.Chrome/config/google-chrome/Local State'),
    path.join(app.getPath('home'), '.config/chromium/Local State'),
  ];

let profileCache = { key: null, list: [] };

function chromeProfiles() {
  for (const file of CHROME_STATE_FILES) {
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    const key = file + ':' + stat.mtimeMs;
    if (profileCache.key === key) return profileCache.list;
    try {
      const cache = JSON.parse(fs.readFileSync(file, 'utf8')).profile.info_cache || {};
      const list = Object.entries(cache).map(([dir, info]) => ({
        dir,
        name: (info && info.name) || dir,
        email: (info && info.user_name) || '',
      }));
      // 'Default' is Chrome's first profile and has no number to sort by; keep it first.
      list.sort((a, b) => (a.dir === 'Default' ? -1 : b.dir === 'Default' ? 1 : a.name.localeCompare(b.name)));
      profileCache = { key, list };
      return list;
    } catch {
      continue; // unreadable or unexpected shape — try the next candidate
    }
  }
  return [];
}

function profileByDir(dir) {
  return dir ? chromeProfiles().find((p) => p.dir === dir) || null : null;
}

// The Chrome profile a slot's links should open in, or null for "let Chrome decide".
function profileForSlot(n) {
  const cfg = accountConfig(n);
  if (cfg.chromeProfile === PROFILE_NONE) return null;
  if (cfg.chromeProfile && cfg.chromeProfile !== PROFILE_AUTO) {
    // An explicitly chosen profile that Chrome no longer has would silently send links to a
    // profile Chrome then invents. Fall back to auto rather than routing somewhere wrong.
    const pinned = profileByDir(cfg.chromeProfile);
    if (pinned) return pinned;
  }
  if (!cfg.email) return null;
  const want = cfg.email.toLowerCase();
  return chromeProfiles().find((p) => p.email && p.email.toLowerCase() === want) || null;
}

// Slot label: an explicit name wins, then the mapped Chrome profile's name (which is the
// point of the mapping — the two stay consistent without typing anything), then null,
// meaning "leave the page-derived title alone".
function accountLabel(n) {
  const cfg = accountConfig(n);
  if (cfg.name) return cfg.name;
  const profile = profileForSlot(n);
  return profile ? profile.name : null;
}

function accountMenuLabel(n) {
  return accountLabel(n) || 'Account ' + n;
}

// Which slot a webContents belongs to. The partition is the reliable link: it is set on the
// session before the window exists, and child windows opened from the account switcher
// inherit it, so links clicked in those route to the same Chrome profile as their parent.
function slotOf(wc) {
  try {
    const m = /^persist:account-(\d+)$/.exec((wc.session && wc.session.__partition) || '');
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

// Read the signed-in address out of the account button Google renders on every one of these
// apps. This is what makes auto-detection work, and it is cached in accounts.json so the
// mapping is already known at the next launch, before any page has painted.
const ACCOUNT_EMAIL_JS = `(function(){
  var a=document.querySelector('[aria-label*="Google Account" i]');
  var s=a?(a.getAttribute('aria-label')||''):(document.title||'');
  var m=s.match(/[\\w.+-]+@[\\w.-]+\\.[A-Za-z]{2,}/);
  return m?m[0]:'';
})()`;

function rememberAccountEmail(wc) {
  const n = slotOf(wc);
  if (!n) return;
  wc.executeJavaScript(ACCOUNT_EMAIL_JS, true).then((email) => {
    if (!email || accountConfig(n).email === email) return;
    accounts.set(n, Object.assign(accountConfig(n), { email }));
    persistSlots([n]);
    // A newly detected address can change both the routing and the window title.
    refreshAccountPresentation();
  }).catch(() => { /* page not ready or no account button — try again on the next load */ });
}

app.setName(APP_NAME);
// Must follow setName: one of the stylesheet sources lives under userData.
loadCustomCss();
// Must follow setName: the preference file lives under userData, which is named after the app.
loadAccounts();
watchAccountsFile();
loadThemePreference();
applyColorScheme();
// Before app ready on purpose: GTK reads GTK_THEME once, when the toolkit initializes.
applyGtkTheme();
watchPortalColorScheme();
app.userAgentFallback = CHROME_UA;
// Drop the Electron build flag that can taint requests.
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
// Keep EVERY window live — not just the focused one — so background account windows
// keep refreshing (Calendar data) and keep firing reminders/notifications. Without these,
// Chromium throttles/suspends background renderers and only the foreground profile updates.
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

// Force the Chrome UA + matching Client-Hint headers on every request. The preload spoofs
// the page-side navigator to match, so there's no header/JS mismatch for Google to flag.
function spoofSession(sess) {
  if (sess.__spoofed) return;
  sess.__spoofed = true;
  sess.setUserAgent(CHROME_UA);
  sess.webRequest.onBeforeSendHeaders((details, cb) => {
    const h = details.requestHeaders;
    h['User-Agent'] = CHROME_UA;
    h['sec-ch-ua'] = SEC_CH_UA;
    h['sec-ch-ua-mobile'] = '?0';
    h['sec-ch-ua-platform'] = SEC_CH_UA_PLATFORM;
    delete h['X-Requested-With'];
    cb({ requestHeaders: h });
  });

  // Grant the web permissions Google services need — most importantly notifications,
  // which Electron then forwards to the OS notification service (macOS Notification
  // Center; libnotify / the desktop's notification daemon on Linux).
  const GRANTED = new Set([
    'notifications', 'media', 'mediaKeySystem', 'fullscreen', 'pointerLock',
    'clipboard-read', 'clipboard-sanitized-write', 'background-sync',
    'idle-detection', 'persistent-storage', 'storage-access',
  ]);
  sess.setPermissionRequestHandler((wc, permission, callback) => callback(GRANTED.has(permission)));
  sess.setPermissionCheckHandler((wc, permission) => GRANTED.has(permission));
}

// acctNum -> BrowserWindow
const windows = new Map();

// Build a native notification. On Linux the banner has no bundle to inherit an icon from,
// so the app PNG is attached explicitly; on macOS the .app icon is used automatically and
// APP_ICON is null, leaving the options untouched.
function nativeNotification(opts) {
  return new Notification(APP_ICON ? Object.assign({ icon: APP_ICON }, opts) : opts);
}

// Show one mirrored notification. `focus` is called when the user clicks the banner.
function showMirroredNotification(n, focus) {
  if (!Notification.isSupported()) return;
  const native = nativeNotification({
    title: (n && n.title) ? n.title : APP_NAME,
    body: (n && n.body) ? n.body : '',
  });
  if (focus) native.on('click', focus);
  native.show();
}

function focusWindow(win) {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// Web notifications from the PAGE (Google Calendar reminders, new Gmail, etc.) are
// mirrored here and shown via the native main-process Notification. Clicking one focuses
// the window.
//
// Which notifications get mirrored is platform-specific. Measured on Linux (Electron 42)
// by watching the desktop's notification bus while firing each kind:
//
//   page-level `new Notification(...)`         -> Electron delivers it natively
//   page-called registration.showNotification  -> never delivered; needs this mirror
//   showNotification() from INSIDE a worker    -> never delivered; see the note below
//
// So on Linux the page-level path must NOT be mirrored: Electron already shows it, and
// mirroring it too made every reminder appear as two identical banners. macOS keeps its
// existing, field-tested behaviour of mirroring it. That half of the policy is enforced in
// preload.js, where the hook lives.
ipcMain.on('mirror-notification', (event, n) => {
  showMirroredNotification(n, () => {
    focusWindow(BrowserWindow.fromWebContents(event.sender));
    try { event.sender.send('mirror-notification-click', n && n.id); } catch (e) {}
  });
});

// KNOWN LIMITATION, Linux: a notification posted from INSIDE a service worker's own scope
// never reaches the desktop. Electron does not display persistent notifications on Linux,
// showNotification() resolves successfully and nothing appears, and the worker's scope
// cannot be patched from here — Electron's service-worker preload scripts run in a
// separate realm, so a hook installed there does not affect the worker's own calls
// (measured: the worker still sees the original showNotification).
//
// In practice Google Calendar reminders are unaffected: Calendar's web notifications
// require an open Calendar view and are posted from the PAGE, which the two mirrors above
// do cover. This only bites a notification pushed to a worker with no page driving it.

// True if `host` equals or is a subdomain of any suffix in the list. Suffix-matched rather
// than regex'd, so lookalikes like "google.com.evil.com" / "google.evil.com" don't match.
function hasSuffix(host, suffixes) {
  host = String(host || '').toLowerCase();
  return suffixes.some((s) => host === s || host.endsWith('.' + s));
}

// First-party Google hosts we keep IN-APP (anything else opens in the user's real browser).
const GOOGLE_HOST_SUFFIXES = [
  'google.com', 'gstatic.com', 'googleusercontent.com', 'googleapis.com',
];
function isGoogleHost(host) {
  return hasSuffix(host, GOOGLE_HOST_SUFFIXES);
}

// Enterprise SSO / identity-provider domains. Corporate Google Workspace sign-in commonly
// redirects to a third-party IdP (Okta, Microsoft Entra, Ping, Duo, etc.) — frequently in a
// popup window. Those popups must stay IN-APP, in the same session/cookie jar, so the SSO
// flow can complete and hand control back to Google; if they were pushed out to the external
// browser the login would break (different cookies, can't close/postback to the opener).
const IDP_HOST_SUFFIXES = [
  // Okta
  'okta.com', 'oktapreview.com', 'okta-emea.com', 'oktacdn.com', 'okta-gov.com',
  // Microsoft Entra ID / Azure AD
  'microsoftonline.com', 'microsoftonline-p.com', 'login.microsoft.com',
  'login.live.com', 'msftauth.net', 'msauth.net',
  // Ping Identity
  'pingidentity.com', 'pingone.com',
  // OneLogin
  'onelogin.com',
  // Duo Security (MFA)
  'duosecurity.com',
  // Auth0
  'auth0.com',
  // JumpCloud
  'jumpcloud.com',
  // CyberArk Identity (formerly Idaptive)
  'idaptive.app', 'cyberark.cloud',
];

// Companies often host SSO on a vanity domain (e.g. login.example.com) no built-in list can
// predict. Let users add their own suffixes WITHOUT rebuilding: a comma/space-separated env
// var (GOOGLE_APP_AUTH_DOMAINS) and/or a JSON array at <userData>/auth-domains.json. Read
// once at startup.
function loadExtraAuthSuffixes() {
  const out = [];
  try {
    if (process.env.GOOGLE_APP_AUTH_DOMAINS) out.push(...process.env.GOOGLE_APP_AUTH_DOMAINS.split(/[,\s]+/));
  } catch (e) { /* ignore */ }
  try {
    const f = path.join(app.getPath('userData'), 'auth-domains.json');
    if (fs.existsSync(f)) {
      const arr = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (Array.isArray(arr)) out.push(...arr);
    }
  } catch (e) { /* malformed file is non-fatal */ }
  return out
    .map((s) => String(s || '').trim().toLowerCase().replace(/^\.+/, ''))
    .filter(Boolean);
}
const EXTRA_AUTH_SUFFIXES = loadExtraAuthSuffixes();

function isAuthHost(host) {
  return hasSuffix(host, IDP_HOST_SUFFIXES) || hasSuffix(host, EXTRA_AUTH_SUFFIXES);
}

// Open external links (e.g. links inside emails) in the user's Chrome browser, falling
// back to the system default browser if Chrome isn't installed.
//
// macOS resolves "Google Chrome" by bundle name via `open -a`; Linux has no such lookup,
// so we probe PATH for the usual Chrome/Chromium executables ourselves. Either way the
// last resort is shell.openExternal (LaunchServices / xdg-open), which honours whatever
// the user actually set as their default browser. GOOGLE_APP_BROWSER overrides the probe
// with an explicit command for anyone who wants a different browser (or a flatpak wrapper).
const LINUX_BROWSERS = [
  'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser',
  'brave-browser', 'microsoft-edge',
];

// Resolve the browser command ONCE, by looking for an executable on PATH — deliberately
// not by spawning and watching the exit code. A browser launched into a fresh instance
// doesn't exit until the user quits it, so an exit-code fallback would sit armed for
// hours and then re-open a long-forgotten link in a second browser.
function resolveBrowser() {
  const explicit = String(process.env.GOOGLE_APP_BROWSER || '').trim();
  const names = explicit ? [explicit] : (IS_MAC ? [] : LINUX_BROWSERS);
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const name of names) {
    // An absolute/relative path in GOOGLE_APP_BROWSER is used as given.
    if (name.includes(path.sep)) {
      try { fs.accessSync(name, fs.constants.X_OK); return name; } catch (e) { continue; }
    }
    for (const dir of dirs) {
      const full = path.join(dir, name);
      try { fs.accessSync(full, fs.constants.X_OK); return full; } catch (e) { /* keep looking */ }
    }
  }
  return null;
}
const BROWSER_CMD = resolveBrowser();

// --profile-directory is a Chromium switch. Handing it to a browser that doesn't understand
// it (Firefox, or anything set via GOOGLE_APP_BROWSER) would at best be ignored and at worst
// be treated as a URL, so it is only ever passed to a browser known to take it.
const CHROMIUM_BROWSER_RE = /(^|[^a-z])(chrome|chromium|brave|msedge|microsoft-edge|vivaldi|opera)([^a-z]|$)/i;

function browserTakesProfileFlag() {
  return !!BROWSER_CMD && CHROMIUM_BROWSER_RE.test(path.basename(BROWSER_CMD));
}

// slot is the account window the link came from; its mapped Chrome profile decides where
// the URL lands. Without one, the URL is handed over bare and Chrome uses its focused
// window — the old behaviour, kept as the fallback rather than guessing.
function openInChrome(url, slot) {
  if (!/^https?:\/\//i.test(url || '')) { if (url) shell.openExternal(url); return; }
  const profile = slot ? profileForSlot(slot) : null;
  // macOS: resolve Chrome by bundle name, falling back to the default browser. `open`
  // exits as soon as it hands off, so its exit code is a safe success signal here.
  if (IS_MAC && !BROWSER_CMD) {
    // -n plus --args is the only way to get a switch through `open`; without a profile
    // there is nothing to pass, so the simpler form (which reuses a running Chrome) stands.
    const args = profile
      ? ['-na', 'Google Chrome', '--args', '--profile-directory=' + profile.dir, url]
      : ['-a', 'Google Chrome', url];
    execFile('open', args, (err) => {
      if (err) shell.openExternal(url);
    });
    return;
  }
  if (!BROWSER_CMD) { shell.openExternal(url); return; }
  const args = (profile && browserTakesProfileFlag())
    ? ['--profile-directory=' + profile.dir, url]
    : [url];
  // Detached + unref'd so a browser we cold-start isn't tied to this app's lifetime
  // (quitting the app must not take the user's browser window down with it).
  try {
    const child = spawn(BROWSER_CMD, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => shell.openExternal(url));
    child.unref();
  } catch (e) {
    shell.openExternal(url);
  }
}

// target=_blank / pop-outs: open links inside emails & calendar events (and any external link)
// in Chrome; keep the app's own Google UI (compose pop-outs, sign-in) AND enterprise SSO popups
// (Okta, Entra, etc.) in-app & isolated so corporate sign-in completes in-session.
//
// Registered on EVERY webContents via 'web-contents-created' — NOT just the first account
// window. Switching accounts in Gmail/Calendar opens the next account in a NEW window (via the
// 'allow' branch below); that window needs the handler too, or clicking a link in it falls
// through to Electron's default (a dead in-app window) instead of opening the real browser.
// The new window inherits its opener's persist:account-N session; we tag that session with
// __partition (see openAccountWindow) so the allowed child stays in the same cookie jar.
function attachExternalLinkRouting(wc) {
  wc.setWindowOpenHandler(({ url }) => {
    // Resolved per click, not captured once: the slot's Chrome profile can change from the
    // Accounts window while these handlers stay attached.
    const slot = slotOf(wc);
    try {
      const u = new URL(url);
      // Gmail wraps links inside emails in a google.com/url?q=<target> redirector → Chrome.
      if (/(^|\.)google\.com$/.test(u.hostname) && u.pathname === '/url') {
        openInChrome(u.searchParams.get('q') || u.searchParams.get('url') || url, slot);
        return { action: 'deny' };
      }
      if (isGoogleHost(u.hostname) || isAuthHost(u.hostname)) {
        const part = wc.session && wc.session.__partition;
        const webPreferences = part
          ? Object.assign({ partition: part }, STEALTH_WEBPREFS)
          : STEALTH_WEBPREFS;
        return { action: 'allow', overrideBrowserWindowOptions: { webPreferences } };
      }
    } catch (e) { /* fall through to Chrome */ }
    openInChrome(url, slot);
    return { action: 'deny' };
  });
}

function openAccountWindow(n) {
  const existing = windows.get(n);
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    return existing;
  }

  const partition = 'persist:account-' + n; // isolated, persistent cookie jar per account
  const sess = session.fromPartition(partition);
  spoofSession(sess);
  // Remember which partition this session belongs to so attachExternalLinkRouting can keep
  // any allowed child window (account switcher, SSO popup) in the same cookie jar.
  sess.__partition = partition;

  const win = new BrowserWindow(Object.assign({
    width: 1280,
    height: 860,
    // Held back until the renderer has a first frame — see reveal() below.
    show: false,
    title: accountLabel(n) || APP_NAME + ' — Account ' + n,
    backgroundColor: windowBackground(),
    webPreferences: Object.assign({ partition }, STEALTH_WEBPREFS),
  }, APP_ICON ? { icon: APP_ICON } : {}));

  win.webContents.setUserAgent(CHROME_UA);

  // Link routing (target=_blank / pop-outs → Chrome, Google/SSO popups in-app) is attached
  // globally in 'web-contents-created' so it covers secondary account windows too.

  // 'ready-to-show' means the renderer has something to present, so the window never
  // appears mid-paint. But it is not guaranteed to fire — a load that stalls is exactly the
  // case this is guarding against — and a window that never appears is worse than one that
  // appears blank. So a deadline reveals it regardless; getting content INTO it is the
  // retry layer's job, not this one's.
  let revealTimer = null;
  const reveal = () => {
    if (revealTimer) { clearTimeout(revealTimer); revealTimer = null; }
    if (win.isDestroyed() || win.isVisible()) return;
    // Maximizing a hidden window is unreliable across Linux WMs, so re-assert it here where
    // the window is about to be mapped.
    if (!win.isMaximized()) win.maximize();
    win.show();
  };
  revealTimer = setTimeout(reveal, REVEAL_DEADLINE_MS);
  win.once('ready-to-show', reveal);

  win.maximize();
  win.loadURL(APP_URL, { userAgent: CHROME_UA });
  windows.set(n, win);
  win.on('closed', () => {
    if (revealTimer) { clearTimeout(revealTimer); revealTimer = null; }
    windows.delete(n);
  });
  return win;
}

function nextFreeSlot() {
  for (let i = 1; i <= 50; i++) {
    const w = windows.get(i);
    if (!w || w.isDestroyed()) return i;
  }
  return 1;
}

// Re-apply names everywhere they show after anything that can change them: the settings
// window saving, or an address being detected for the first time.
function refreshAccountPresentation() {
  for (const [n, win] of windows) {
    if (!win || win.isDestroyed()) continue;
    const label = accountLabel(n);
    if (label) {
      win.setTitle(label);
    } else if (win.webContents && !win.webContents.isDestroyed()) {
      // A name that was cleared hands the title back to the page.
      win.webContents.executeJavaScript(ACCOUNT_TITLE_JS, true)
        .then((l) => { if (!win.isDestroyed() && l) win.setTitle(l); })
        .catch(() => { /* ignore */ });
    }
  }
  buildMenu(); // the Accounts menu lists the same names
}

let accountsWindow = null;

function openAccountsWindow() {
  if (accountsWindow && !accountsWindow.isDestroyed()) {
    accountsWindow.focus();
    return accountsWindow;
  }
  accountsWindow = new BrowserWindow(Object.assign({
    width: 660,
    height: 480,
    title: 'Accounts',
    backgroundColor: windowBackground(),
    // This is our own page, not Google's — so it gets the ordinary hardened defaults
    // rather than the stealth preferences the account windows need.
    webPreferences: {
      preload: path.join(__dirname, 'accounts-preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  }, APP_ICON ? { icon: APP_ICON } : {}));
  accountsWindow.setMenuBarVisibility(false);
  accountsWindow.loadFile(path.join(__dirname, 'accounts.html'));
  accountsWindow.on('closed', () => { accountsWindow = null; });
  return accountsWindow;
}

ipcMain.handle('accounts:load', () => ({
  slots: Array.from({ length: ACCOUNT_SLOTS }, (unused, i) => {
    const n = i + 1;
    const cfg = accountConfig(n);
    const resolved = profileForSlot(n);
    return {
      n,
      name: cfg.name || '',
      chromeProfile: cfg.chromeProfile || PROFILE_AUTO,
      email: cfg.email || '',
      resolvedProfile: resolved ? resolved.name : '',
    };
  }),
  profiles: chromeProfiles(),
}));

ipcMain.handle('accounts:save', (event, incoming) => {
  if (!Array.isArray(incoming)) return false;
  // Validate rather than trust: an ipcMain handler is reachable from any renderer, and a
  // profile directory that Chrome doesn't have would send links into a profile it invents.
  const known = new Set(chromeProfiles().map((p) => p.dir));
  const touched = [];
  for (const row of incoming) {
    const n = Number(row && row.n);
    if (!Number.isInteger(n) || n < 1 || n > ACCOUNT_SLOTS) continue;
    touched.push(n);
    let profile = typeof row.chromeProfile === 'string' ? row.chromeProfile : PROFILE_AUTO;
    if (profile !== PROFILE_AUTO && profile !== PROFILE_NONE && !known.has(profile)) profile = PROFILE_AUTO;
    const name = typeof row.name === 'string' ? row.name.trim().slice(0, 64) : '';
    // The detected address is ours, not the renderer's — keep whatever we already learned.
    accounts.set(n, Object.assign(accountConfig(n), { name, chromeProfile: profile }));
  }
  persistSlots(touched);
  refreshAccountPresentation();
  return true;
});

ipcMain.on('accounts:close', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) win.close();
});

function buildMenu() {
  const accountItems = [];
  for (let i = 1; i <= ACCOUNT_SLOTS; i++) {
    accountItems.push({
      label: accountMenuLabel(i),
      accelerator: 'CmdOrCtrl+' + i,
      click: () => openAccountWindow(i),
    });
  }

  // The leading menu differs by platform: macOS gets the standard application menu
  // (About / Hide / Hide Others / Unhide are macOS-only roles and are ignored elsewhere),
  // while Linux gets a conventional File menu — the menu bar is drawn inside the window
  // there, so there is no app-name menu for those items to live in.
  const leadingMenu = IS_MAC
    ? {
      label: APP_NAME,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }
    : {
      label: 'File',
      submenu: [
        { role: 'close' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    };

  const template = [
    leadingMenu,
    {
      label: 'Accounts',
      submenu: [
        {
          label: 'New Account Window',
          accelerator: 'CmdOrCtrl+N',
          click: () => openAccountWindow(nextFreeSlot()),
        },
        { type: 'separator' },
        ...accountItems,
        { type: 'separator' },
        {
          label: 'Configure Accounts…',
          accelerator: 'CmdOrCtrl+,',
          click: () => openAccountsWindow(),
        },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
        { role: 'pasteAndMatchStyle' }, { role: 'delete' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' }, { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' },
        { role: 'togglefullscreen' }, { role: 'toggleDevTools' }, { type: 'separator' },
        {
          // Escape hatch for when detection disagrees with the desktop the user actually
          // sees. "System" is the default and follows the appearance portal.
          label: 'Appearance',
          submenu: [
            {
              label: 'System',
              type: 'radio',
              checked: themePreference === 'system',
              click: () => setThemePreference('system'),
            },
            {
              label: 'Light',
              type: 'radio',
              checked: themePreference === 'light',
              click: () => setThemePreference('light'),
            },
            {
              label: 'Dark',
              type: 'radio',
              checked: themePreference === 'dark',
              click: () => setThemePreference('dark'),
            },
          ],
        },
      ],
    },
    {
      label: 'Window',
      // 'zoom' and 'front' are macOS-only roles.
      submenu: IS_MAC
        ? [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }, { role: 'front' }]
        : [{ role: 'minimize' }, { role: 'close' }],
    },
    {
      label: 'Help',
      submenu: [
        // On macOS About lives in the application menu; on Linux it belongs here.
        ...(IS_MAC ? [] : [{ role: 'about' }, { type: 'separator' }]),
        {
          label: 'Send Test Notification (now)',
          click: () => {
            if (Notification.isSupported()) {
              nativeNotification({ title: APP_NAME, body: 'Native desktop notifications are working ✓' }).show();
            }
          },
        },
        {
          label: 'Send Test Notification in 5s (click away to see the banner)',
          click: () => {
            if (!Notification.isSupported()) return;
            setTimeout(() => {
              nativeNotification({
                title: APP_NAME,
                body: 'If you can see this banner, notifications work while ' + APP_NAME + ' is in the background ✓',
              }).show();
            }, 5000);
          },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// One process per app. macOS gives this for free (re-launching a .app just activates the
// running copy), but on Linux every click in the app grid / every `gmail` from a shell
// would otherwise start a SECOND process pointed at the same per-account partition dirs —
// which Chromium's profile lock rejects, so the new copy comes up with broken storage.
// Instead, hand the request to the running instance and let it surface a window.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const open = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
    if (open.length === 0) { openAccountWindow(nextFreeSlot()); return; }
    const win = open[0];
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  app.whenReady().then(() => {
    // Populates the Help → About dialog. macOS fills this from the bundle's Info.plist,
    // but on Linux the About panel is empty unless it's set explicitly.
    app.setAboutPanelOptions(Object.assign({
      applicationName: APP_NAME,
      applicationVersion: app.getVersion(),
      version: 'Electron ' + process.versions.electron + ' / Chromium ' + process.versions.chrome,
      copyright: 'MIT — not affiliated with or endorsed by Google',
    }, APP_ICON ? { iconPath: APP_ICON } : {}));

    buildMenu();
    openAccountWindow(1);

    // On the very first launch, fire one native notification so the OS registers this app
    // with its notification settings (macOS only lists apps under System Settings →
    // Notifications once they've notified; GNOME likewise only shows a per-app entry after
    // the first notification arrives).
    try {
      const marker = path.join(app.getPath('userData'), '.notif-registered');
      if (!fs.existsSync(marker) && Notification.isSupported()) {
        nativeNotification({ title: APP_NAME, body: APP_NAME + ' notifications are enabled.' }).show();
        fs.writeFileSync(marker, '1');
      }
    } catch (e) { /* non-fatal */ }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) openAccountWindow(1);
    });

    // After the machine wakes from sleep, a long-idle Google session can drop its live
    // connection (Calendar then shows "could not load the data"). Reload every window so
    // all open profiles refresh and resume firing notifications. Fires on macOS wake and
    // on Linux via logind's PrepareForSleep signal.
    //
    // 'resume' arrives well before the network does: reloading immediately used to strand
    // every window on ERR_INTERNET_DISCONNECTED, with nothing to recover it, so the whole
    // app sat dead until each window was reloaded by hand. So wait for the connection.
    // net.isOnline() reporting true is not proof the route is usable either — the retry
    // layer is what actually settles it — but it keeps the common case off a doomed load.
    powerMonitor.on('resume', () => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed()) continue;
        if (net.isOnline()) win.webContents.reload();
        else scheduleReload(win.webContents);
      }
    });
  });
}

app.on('window-all-closed', () => {
  if (!IS_MAC) app.quit();
});
