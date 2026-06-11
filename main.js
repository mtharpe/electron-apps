const { app, BrowserWindow, Menu, session, shell, Notification, ipcMain, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'app-config.json'), 'utf8'));
const APP_NAME = cfg.name;
const APP_URL = cfg.url;

// Pose as stock desktop Chrome. Paired with preload.js (which fixes the JS-side
// fingerprints), this is what gets past Google's "browser may not be secure" gate.
const CHROME_MAJOR = '138';
const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/' + CHROME_MAJOR + '.0.0.0 Safari/537.36';
const SEC_CH_UA =
  '"Google Chrome";v="' + CHROME_MAJOR + '", "Chromium";v="' + CHROME_MAJOR + '", "Not.A/Brand";v="24"';

// Stealth apps (Gmail/Calendar/Tasks/Keep) need contextIsolation:false so the preload can
// patch the page's main world to pass Google's sign-in checks. QR-pairing apps (Google
// Messages) render BLANK with contextIsolation:false and don't need the stealth — so they
// get a normal, isolated config with no preload; native web notifications work there as-is.
const USE_STEALTH = !/messages\.google\.com/.test(APP_URL);
const WEBPREFS = USE_STEALTH
  ? {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: false, // preload must share the page's main world to patch navigator
      sandbox: false,
      nodeIntegration: false,
      spellcheck: true,
      backgroundThrottling: false, // keep this window's timers/connection live in the background
    }
  : {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
      backgroundThrottling: false,
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

// Set the Chrome UA and (for stealth apps) matching Client-Hint headers on every request.
// For non-stealth apps (Messages) we must NOT rewrite sec-ch-ua: the page's JS still reports
// Electron's real client hints, and a header/JS mismatch makes Google flag it "not secure".
function spoofSession(sess, stealth) {
  if (sess.__spoofed) return;
  sess.__spoofed = true;
  sess.setUserAgent(CHROME_UA);
  if (stealth) {
    sess.webRequest.onBeforeSendHeaders((details, cb) => {
      const h = details.requestHeaders;
      h['User-Agent'] = CHROME_UA;
      h['sec-ch-ua'] = SEC_CH_UA;
      h['sec-ch-ua-mobile'] = '?0';
      h['sec-ch-ua-platform'] = '"macOS"';
      delete h['X-Requested-With'];
      cb({ requestHeaders: h });
    });
  }

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

function isGoogleHost(host) {
  return /(^|\.)(google\.com|gstatic\.com|googleusercontent\.com|googleapis\.com|google\.[a-z.]+)$/.test(host);
}

function openAccountWindow(n) {
  const existing = windows.get(n);
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    return existing;
  }

  const partition = 'persist:account-' + n; // isolated, persistent cookie jar per account
  const sess = session.fromPartition(partition);
  spoofSession(sess, USE_STEALTH);

  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: APP_NAME + ' — Account ' + n,
    backgroundColor: '#ffffff',
    webPreferences: Object.assign({ partition }, WEBPREFS),
  });

  win.webContents.setUserAgent(CHROME_UA);

  // target=_blank / pop-outs (Gmail compose, etc.): keep Google links in-app & isolated; send the rest to the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const host = new URL(url).hostname;
      if (isGoogleHost(host)) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: { webPreferences: Object.assign({ partition }, WEBPREFS) },
        };
      }
    } catch (e) { /* fall through */ }
    shell.openExternal(url);
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
