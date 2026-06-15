const { app, BrowserWindow, Menu, session, shell, Notification, ipcMain, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'app-config.json'), 'utf8'));
const APP_NAME = cfg.name;
const APP_URL = cfg.url;

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
});

// Pose as stock desktop Chrome. Report the REAL bundled Chromium major (not a hardcoded
// number) so the spoofed version can never lag the engine after an Electron bump — a stale
// major makes Google reject the app (Calendar then shows "could not load the data"). Paired
// with preload.js (which fixes the JS-side fingerprints), this is what gets past Google's
// "browser may not be secure" gate.
const CHROME_MAJOR = process.versions.chrome.split('.')[0];
const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/' + CHROME_MAJOR + '.0.0.0 Safari/537.36';
const SEC_CH_UA =
  '"Google Chrome";v="' + CHROME_MAJOR + '", "Chromium";v="' + CHROME_MAJOR + '", "Not.A/Brand";v="24"';

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
    h['sec-ch-ua-platform'] = '"macOS"';
    delete h['X-Requested-With'];
    cb({ requestHeaders: h });
  });

  // Grant the web permissions Google services need — most importantly notifications,
  // which Electron then forwards to the native macOS Notification Center.
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

// Web/service-worker notifications from the renderer (Google Calendar reminders, new
// Gmail, etc.) are mirrored here and shown via the native main-process Notification —
// the path that reliably renders macOS banners. Clicking one focuses the window.
ipcMain.on('mirror-notification', (event, n) => {
  if (!Notification.isSupported()) return;
  const native = new Notification({
    title: (n && n.title) ? n.title : APP_NAME,
    body: (n && n.body) ? n.body : '',
  });
  native.on('click', () => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
    try { event.sender.send('mirror-notification-click', n && n.id); } catch (e) {}
  });
  native.show();
});

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

// Open external links (e.g. links inside emails) in the user's Chrome browser,
// falling back to the system default browser if Chrome isn't installed.
function openInChrome(url) {
  if (!/^https?:\/\//i.test(url || '')) { if (url) shell.openExternal(url); return; }
  execFile('open', ['-a', 'Google Chrome', url], (err) => {
    if (err) shell.openExternal(url);
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

  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: APP_NAME + ' — Account ' + n,
    backgroundColor: '#ffffff',
    webPreferences: Object.assign({ partition }, STEALTH_WEBPREFS),
  });

  win.webContents.setUserAgent(CHROME_UA);

  // target=_blank / pop-outs: open links inside emails (and any external link) in Chrome;
  // keep the app's own Google UI (compose pop-outs, sign-in) AND enterprise SSO popups
  // (Okta, Entra, etc.) in-app & isolated so corporate sign-in completes in-session.
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const u = new URL(url);
      // Gmail wraps links inside emails in a google.com/url?q=<target> redirector → Chrome.
      if (/(^|\.)google\.com$/.test(u.hostname) && u.pathname === '/url') {
        openInChrome(u.searchParams.get('q') || u.searchParams.get('url') || url);
        return { action: 'deny' };
      }
      if (isGoogleHost(u.hostname) || isAuthHost(u.hostname)) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: { webPreferences: Object.assign({ partition }, STEALTH_WEBPREFS) },
        };
      }
    } catch (e) { /* fall through to Chrome */ }
    openInChrome(url);
    return { action: 'deny' };
  });

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

  const template = [
    {
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
    },
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
      submenu: [
        { role: 'minimize' }, { role: 'zoom' }, { role: 'close' }, { role: 'front' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Send Test Notification (now)',
          click: () => {
            if (Notification.isSupported()) {
              new Notification({ title: APP_NAME, body: 'Native macOS notifications are working ✓' }).show();
            }
          },
        },
        {
          label: 'Send Test Notification in 5s (click away to see the banner)',
          click: () => {
            if (!Notification.isSupported()) return;
            setTimeout(() => {
              new Notification({
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

app.whenReady().then(() => {
  buildMenu();
  openAccountWindow(1);

  // On the very first launch, fire one native notification so macOS registers this
  // app under System Settings → Notifications (apps only appear there once they notify).
  try {
    const marker = path.join(app.getPath('userData'), '.notif-registered');
    if (!fs.existsSync(marker) && Notification.isSupported()) {
      new Notification({ title: APP_NAME, body: APP_NAME + ' notifications are enabled.' }).show();
      fs.writeFileSync(marker, '1');
    }
  } catch (e) { /* non-fatal */ }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openAccountWindow(1);
  });

  // After the Mac wakes from sleep, a long-idle Google session can drop its live
  // connection (Calendar then shows "could not load the data"). Reload every window so
  // all open profiles refresh and resume firing notifications.
  powerMonitor.on('resume', () => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.reload();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
