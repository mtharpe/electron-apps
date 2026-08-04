const { app, BrowserWindow, Menu, session, shell, Notification, ipcMain, powerMonitor, nativeTheme } = require('electron');
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

// Normalize Workspace Gmail to match personal Gmail by hiding the left Mail/Chat/Meet/Spaces
// "app-rail" that Workspace accounts show (personal accounts don't). Anchored on the buttons'
// stable aria-labels via :has() — not Gmail's churning class names — so it keeps working
// across redesigns and harmlessly matches nothing if the rail ever goes away. Injected as a
// stylesheet (not an inline style) so it survives Gmail's re-renders.
const GMAIL_RAIL_HIDE_CSS = `
[role="navigation"]:has([role="link"][aria-label^="Chat"]),
[role="navigation"]:has([role="link"][aria-label="Meet"]),
[role="navigation"]:has([role="link"][aria-label^="Spaces"]) { display: none !important; }
`;
const mailHost = (h) => /(^|\.)mail\.google\.com$/.test(h);
const IS_GMAIL_APP = (() => { try { return mailHost(new URL(APP_URL).hostname); } catch (e) { return false; } })();

// Re-apply on every document load. This must cover EVERY webContents, not just the first
// account window: picking another account from Gmail's switcher opens it in a NEW window,
// and that window needs the rule too. Registered globally below via 'web-contents-created'.
function applyGmailNormalization(wc) {
  wc.on('dom-ready', () => {
    try { if (mailHost(new URL(wc.getURL()).hostname)) wc.insertCSS(GMAIL_RAIL_HIDE_CSS); } catch (e) { /* ignore */ }
  });
}

// Window title = JUST the account/org name (e.g. "Spectro Cloud", "Gmail") so each account's
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
    wc.executeJavaScript(ACCOUNT_TITLE_JS, true).then((label) => {
      const win = BrowserWindow.fromWebContents(wc);
      if (win && !win.isDestroyed() && label) win.setTitle(label);
    }).catch(() => { /* ignore */ });
  };
  // Stop Electron from auto-applying Google's full page title, then set our short one.
  wc.on('page-title-updated', (e) => { e.preventDefault(); apply(); });
  wc.on('dom-ready', apply);
}

app.on('web-contents-created', (e, wc) => {
  if (IS_GMAIL_APP) applyGmailNormalization(wc);
  manageWindowTitle(wc);
  attachExternalLinkRouting(wc);
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
//   org.freedesktop.appearance color-scheme: 0 = no preference, 1 = dark, 2 = light
const COLOR_SCHEME_DARK = 1;
const COLOR_SCHEME_LIGHT = 2;

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

function applyColorScheme() {
  const scheme = portalColorScheme();
  // Unreadable portal or "no preference" both fall back to the desktop-wide
  // setting Electron *did* manage to read, rather than forcing a choice.
  if (scheme === COLOR_SCHEME_DARK) nativeTheme.themeSource = 'dark';
  else if (scheme === COLOR_SCHEME_LIGHT) nativeTheme.themeSource = 'light';
}

applyColorScheme();

// Window background must match, or every window opens as a white rectangle before
// the page paints — the most visible part of the problem on a dark desktop.
function windowBackground() {
  return nativeTheme.shouldUseDarkColors ? '#202124' : '#ffffff';
}

app.setName(APP_NAME);
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

function openInChrome(url) {
  if (!/^https?:\/\//i.test(url || '')) { if (url) shell.openExternal(url); return; }
  // macOS: resolve Chrome by bundle name, falling back to the default browser. `open`
  // exits as soon as it hands off, so its exit code is a safe success signal here.
  if (IS_MAC && !BROWSER_CMD) {
    execFile('open', ['-a', 'Google Chrome', url], (err) => {
      if (err) shell.openExternal(url);
    });
    return;
  }
  if (!BROWSER_CMD) { shell.openExternal(url); return; }
  // Detached + unref'd so a browser we cold-start isn't tied to this app's lifetime
  // (quitting the app must not take the user's browser window down with it).
  try {
    const child = spawn(BROWSER_CMD, [url], { detached: true, stdio: 'ignore' });
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
    try {
      const u = new URL(url);
      // Gmail wraps links inside emails in a google.com/url?q=<target> redirector → Chrome.
      if (/(^|\.)google\.com$/.test(u.hostname) && u.pathname === '/url') {
        openInChrome(u.searchParams.get('q') || u.searchParams.get('url') || url);
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
    openInChrome(url);
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
    title: APP_NAME + ' — Account ' + n,
    backgroundColor: windowBackground(),
    webPreferences: Object.assign({ partition }, STEALTH_WEBPREFS),
  }, APP_ICON ? { icon: APP_ICON } : {}));

  win.webContents.setUserAgent(CHROME_UA);

  // Link routing (target=_blank / pop-outs → Chrome, Google/SSO popups in-app) is attached
  // globally in 'web-contents-created' so it covers secondary account windows too.

  win.maximize();
  win.loadURL(APP_URL, { userAgent: CHROME_UA });
  windows.set(n, win);
  win.on('closed', () => windows.delete(n));
  return win;
}

function nextFreeSlot() {
  for (let i = 1; i <= 50; i++) {
    const w = windows.get(i);
    if (!w || w.isDestroyed()) return i;
  }
  return 1;
}

function buildMenu() {
  const accountItems = [];
  for (let i = 1; i <= 6; i++) {
    accountItems.push({
      label: 'Account ' + i,
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
        { role: 'togglefullscreen' }, { role: 'toggleDevTools' },
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
    powerMonitor.on('resume', () => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.reload();
      }
    });
  });
}

app.on('window-all-closed', () => {
  if (!IS_MAC) app.quit();
});
