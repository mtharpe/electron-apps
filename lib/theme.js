// Light/dark: resolving what the desktop wants, pinning an explicit choice, and keeping the
// window frame in step. See the long note below for why none of this can be left to Electron.
const path = require('path');
const fs = require('fs');
const { app, nativeTheme, dialog } = require('electron');
const { execFileSync, spawn } = require('child_process');
const { IS_MAC, APP_NAME } = require('./config');
const { windows, getAccountsWindow } = require('./window-registry');

// Both lookups below are synchronous and sit on the startup path. gdbus and gsettings answer
// in a few milliseconds normally; a hung or absent bus should cost the first window a
// fraction of a second, not two of them.
const SYNC_TIMEOUT_MS = 400;

// Rebuilding the application menu is the caller's business, not this module's -- menu.js
// depends on theme.js for the radio state, so calling buildMenu() from here directly would
// close a cycle. main.js registers the callback once.
let changedCb = () => {};
function onChanged(cb) { changedCb = cb; }

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

// undefined = not read yet; a number = what the portal last said. Deliberately never caches
// null: a timeout on a busy session bus at startup must not pin System mode to "no answer"
// for the life of the process. Invalidated by the SettingChanged watcher below.
let portalSchemeCache;

function portalColorScheme() {
  if (IS_MAC || process.platform === 'win32') return null;
  if (portalSchemeCache !== undefined) return portalSchemeCache;
  try {
    const out = execFileSync('gdbus', [
      'call', '--session',
      '--dest', 'org.freedesktop.portal.Desktop',
      '--object-path', '/org/freedesktop/portal/desktop',
      '--method', 'org.freedesktop.portal.Settings.ReadOne',
      'org.freedesktop.appearance', 'color-scheme',
    ], { encoding: 'utf8', timeout: SYNC_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] });
    const m = out.match(/uint32\s+(\d+)/);
    if (!m) return null;
    portalSchemeCache = Number(m[1]);
    return portalSchemeCache;
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

// A null portal answer is not cached, but nothing re-reads it unless the desktop changes
// again — so a busy session bus at startup could keep System mode wrong for the whole
// session. Retry a bounded number of times; the watcher takes over once it is connected.
let portalRetryAttempts = 0;

// `scheme` is optional so a caller that already resolved it (startup does, once) does not
// pay for a second lookup; with no argument it resolves for itself.
function applyColorScheme(scheme) {
  if (scheme === undefined) scheme = resolveScheme();
  // No answer falls back to the desktop-wide setting Electron *did* manage to read,
  // rather than forcing a choice.
  nativeTheme.themeSource = scheme || 'system';
  if (scheme === null && themePreference === 'system' && portalRetryAttempts < 3) {
    portalRetryAttempts++;
    const t = setTimeout(() => { applyColorScheme(); repaintWindowBackgrounds(); }, 8000);
    if (t.unref) t.unref();
  } else if (scheme !== null) {
    portalRetryAttempts = 0;
  }
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
      encoding: 'utf8', timeout: SYNC_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'],
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
// True when GTK_THEME came from outside this app. The frame then follows the user's value
// no matter what we set, so offering a restart to "fix" it would be a lie.
let gtkThemeExternallySet = false;

function applyGtkTheme(scheme) {
  if (IS_MAC || process.platform === 'win32') return;
  // An explicitly exported GTK_THEME is the user overriding us from outside; don't fight it.
  // GTK_THEME_FROM_APP marks the value as one WE set: app.relaunch() hands the child our
  // environment, so without the marker a restart would inherit the stale value it was
  // supposed to replace and treat it as a user override forever.
  if (process.env.GTK_THEME && !process.env.GTK_THEME_FROM_APP) {
    gtkThemeExternallySet = true;
    const declared = /:light/i.test(process.env.GTK_THEME) ? 'light'
      : /:dark/i.test(process.env.GTK_THEME) ? 'dark' : null;
    // No variant in the external value means GTK picks its own, outside our reach: record
    // the scheme we resolved so the frame is not reported stale on every preference change,
    // which would loop the restart prompt with no restart able to end it.
    appliedGtkVariant = declared || (scheme === undefined ? resolveScheme() : scheme);
    return;
  }
  gtkThemeExternallySet = false;
  if (scheme === undefined) scheme = resolveScheme();
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
  if (gtkThemeExternallySet) return; // a restart cannot change an externally pinned theme
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
    // quit(), not exit(): exit() skips before-quit, where window-restore flushes its
    // debounced geometry write.
    app.quit();
  }).catch(() => { /* dialog failed; the choice is still saved for next launch */ });
}

// Window background must match, or every window opens as a white rectangle before
// the page paints — the most visible part of the problem on a dark desktop.
function windowBackground() {
  return nativeTheme.shouldUseDarkColors ? '#202124' : '#ffffff';
}

// backgroundColor is only read at construction, so every live window needs repainting when
// the resolved scheme changes. The Accounts window is not in the slot map (window-registry
// keeps it separately), so it has to be asked for explicitly.
function repaintWindowBackgrounds() {
  const bg = windowBackground();
  for (const win of windows.values()) {
    if (win && !win.isDestroyed()) win.setBackgroundColor(bg);
  }
  const accountsWin = getAccountsWindow();
  if (accountsWin && !accountsWin.isDestroyed()) accountsWin.setBackgroundColor(bg);
}

function setThemePreference(pref) {
  if (!THEME_PREFS.includes(pref)) return;
  themePreference = pref;
  saveThemePreference();
  applyColorScheme();
  repaintWindowBackgrounds();
  changedCb(); // refresh the radio checkmark
  offerRestartIfFrameStale();
}

// In System mode, follow the desktop when it changes rather than only at launch. Electron's
// own nativeTheme 'updated' event does not fire for this on Linux (it never saw the change
// in the first place — that is the whole reason the portal is read here), so watch the
// portal's SettingChanged signal directly. Best-effort: if gdbus or the portal is missing,
// System mode simply stays at whatever it resolved to on startup.
//
// gdbus monitor is a long-lived child, and the session bus or portal can restart under it.
// A watcher that has died without noticing would silently stop following the desktop, so an
// exit (or a spawn error) schedules a re-spawn with exponential backoff, capped.
let portalWatcher = null;
let portalRetryTimer = null;
let portalRetryAttempt = 0;

function schedulePortalRetry() {
  if (portalRetryTimer) return;
  const delay = Math.min(1000 * (2 ** portalRetryAttempt), 60000);
  portalRetryAttempt += 1;
  portalRetryTimer = setTimeout(() => {
    portalRetryTimer = null;
    startPortalWatcher();
  }, delay);
  if (portalRetryTimer.unref) portalRetryTimer.unref();
}

function startPortalWatcher() {
  if (IS_MAC || process.platform === 'win32' || portalWatcher || portalRetryTimer) return;
  let child;
  try {
    child = spawn('gdbus', [
      'monitor', '--session',
      '--dest', 'org.freedesktop.portal.Desktop',
      '--object-path', '/org/freedesktop/portal/desktop',
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    schedulePortalRetry();
    return;
  }
  portalWatcher = child;

  // stdout is a stream, not line-oriented: a chunk can end mid-line, and matching a partial
  // "SettingChanged" would either miss the event or match it twice. Hold the tail until the
  // next chunk completes it.
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!/SettingChanged/.test(line) || !/color-scheme/.test(line)) continue;
      portalRetryAttempt = 0; // it is demonstrably alive
      portalSchemeCache = undefined; // whatever we read at startup is now out of date
      if (themePreference !== 'system') continue; // an explicit choice outranks the desktop
      applyColorScheme();
      repaintWindowBackgrounds();
      // The desktop flipped light/dark: the page follows, but the GTK frame cannot until a
      // restart. Offer it here too (it returns early for an externally pinned GTK_THEME).
      offerRestartIfFrameStale();
    }
  });

  // 'exit' and 'error' can both arrive; tear down once.
  let gone = false;
  const onGone = () => {
    if (gone) return;
    gone = true;
    if (portalWatcher === child) portalWatcher = null;
    schedulePortalRetry();
  };
  child.on('exit', onGone);
  child.on('error', onGone);
  child.unref();
}

function watchPortalColorScheme() {
  startPortalWatcher();
}

function getThemePreference() { return themePreference; }

module.exports = {
  loadThemePreference, applyColorScheme, applyGtkTheme, watchPortalColorScheme,
  windowBackground, setThemePreference, getThemePreference, onChanged,
};
