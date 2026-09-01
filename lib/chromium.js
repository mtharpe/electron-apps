// How the embedded Chromium is configured: the stealth fingerprint that gets past Google's
// "browser may not be secure" gate, the per-session header spoof, and the Widevine wait.
const path = require('path');
const { ROOT, IS_MAC, cfg } = require('./config');
const { wait, logRecovery } = require('./util');

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
  preload: path.join(ROOT, 'preload.js'),
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

// Widevine. Stock Electron ships no CDM, so a DRM service (Tidal's audio, for one) simply
// cannot play in it — measured: requestMediaKeySystemAccess('com.widevine.alpha') throws
// NotSupportedError. This repo therefore builds on castlabs' Electron for Content Security,
// a drop-in fork pinned to the same Electron version, which installs the CDM on first run.
//
// The install has to finish BEFORE any window exists: a renderer created without a CDM
// keeps that handicap for its whole life, so an early window would silently never play.
//
// But it is a network operation, and blocking window creation on the network is how you end
// up with an app that shows nothing at all on a machine that woke up without Wi-Fi. So it
// is bounded: wait, and if it has not finished in time, open the windows anyway. A DRM app
// then fails to play until the next launch, which is a far better outcome than no window.
//
// Only DRM apps pay this cost. components.whenReady() triggers a ~21 MB CDM download and
// costs up to WIDEVINE_READY_TIMEOUT_MS of first-paint delay — pure waste for any app that
// never touches Widevine (Gmail, Calendar, Keep, Tasks, Messages, Messenger). Gated on
// `drm` in services.conf, plumbed through app-config.json.
const WIDEVINE_READY_TIMEOUT_MS = 15000;

async function whenWidevineReady() {
  // Non-DRM apps neither wait for nor cache the CDM — see the note above.
  if (!cfg.drm) return;
  let components;
  try { components = require('electron').components; } catch (e) { return; }
  // Stock Electron has no `components` at all; nothing to wait for.
  if (!components || typeof components.whenReady !== 'function') return;
  const started = Date.now();
  try {
    await Promise.race([
      components.whenReady(),
      wait(WIDEVINE_READY_TIMEOUT_MS).then(() => { throw new Error('timed out'); }),
    ]);
    logRecovery('widevine ready in ' + (Date.now() - started) + 'ms');
  } catch (e) {
    logRecovery('widevine not ready after ' + (Date.now() - started) + 'ms (' +
      (e && e.message) + ') — opening windows anyway; DRM playback will not work this run');
  }
}

module.exports = {
  CHROME_UA, SEC_CH_UA, SEC_CH_UA_PLATFORM, STEALTH_WEBPREFS, spoofSession, whenWidevineReady,
};
