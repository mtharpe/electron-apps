// Light/dark: resolving what the desktop wants, pinning an explicit choice, and keeping the
// window frame in step. See the long note below for why none of this can be left to Electron.
const path = require('path');
const fs = require('fs');
const { app, nativeTheme, dialog } = require('electron');
const { execFileSync, spawn } = require('child_process');
const { IS_MAC, APP_NAME } = require('./config');
const { windows } = require('./window-registry');

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
  changedCb(); // refresh the radio checkmark
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

function getThemePreference() { return themePreference; }

module.exports = {
  loadThemePreference, applyColorScheme, applyGtkTheme, watchPortalColorScheme,
  windowBackground, setThemePreference, getThemePreference, onChanged,
};
