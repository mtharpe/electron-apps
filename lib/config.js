// This app's identity: what it is called, what it wraps, and where its files are.
// Everything here is derived from app-config.json, which both installers write per service
// at package time -- so nothing in the codebase hardcodes a vendor or a URL.
//
// ROOT is the project root. Modules under lib/ must resolve bundled files (preload.js,
// styles/, app-icon.png) against it rather than __dirname, which now points at lib/.
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

const ROOT = path.join(__dirname, '..');

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'app-config.json'), 'utf8'));
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
    path.join(ROOT, 'app-icon.png'),
  ];
  for (const p of candidates) {
    try { if (p && fs.existsSync(p)) return p; } catch (e) { /* try next */ }
  }
  return null;
})();

// The service slug, used to find this app's shipped stylesheet (see page-tweaks.js).
const APP_SLUG = typeof cfg.slug === 'string' ? cfg.slug : '';

// Only the app's OWN host gets styled. A rule written for Gmail has no business running on
// accounts.google.com during sign-in, or on an SSO provider's page.
const APP_HOST = (() => { try { return new URL(APP_URL).hostname.toLowerCase(); } catch (e) { return ''; } })();

// Deliberately NOT under userData: "Account 2 is Work" is a fact about the user's accounts,
// not about Gmail-the-app, so every app shares one file rather than making the user name the
// same accounts once per app. (Appearance stays per app — that one really is a per-window
// preference.) The sessions themselves stay isolated per app as before; this shares the
// labels and the routing, nothing else.
const ACCOUNTS_DIR = path.join(app.getPath('appData'), 'electron-apps');

module.exports = {
  ROOT, cfg, APP_NAME, APP_URL, IS_MAC, APP_ICON, APP_SLUG, APP_HOST, ACCOUNTS_DIR,
};
