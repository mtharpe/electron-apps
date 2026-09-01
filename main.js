// Entry point. Everything substantive lives in lib/ -- this file creates the windows, wires
// the modules to each other, and owns the app lifecycle.
//
// The module graph is deliberately acyclic. Two places would otherwise close a loop, and
// both are broken the same way, by injection from here rather than by a back-import:
//
//   theme.js and accounts.js both need the application menu rebuilt when they change, but
//   menu.js reads from both -> they take a callback (onChanged), registered below.
//
//   menu.js needs to open account windows, which are created here -> it takes those actions
//   through menu.init(), registered below.
const { app, BrowserWindow, session, ipcMain, powerMonitor, Notification } = require('electron');
const path = require('path');
const fs = require('fs');

const sessionSync = require('./session-sync');
const { APP_NAME, APP_URL, APP_ICON, IS_MAC, ACCOUNTS_DIR } = require('./lib/config');
const { logRecovery } = require('./lib/util');
const { windows, focusWindow, getAccountsWindow, setAccountsWindow } = require('./lib/window-registry');
const { CHROME_UA, STEALTH_WEBPREFS, spoofSession, whenWidevineReady } = require('./lib/chromium');
const {
  loadThemePreference, applyColorScheme, applyGtkTheme, watchPortalColorScheme,
  windowBackground,
} = require('./lib/theme');
const theme = require('./lib/theme');
const {
  ACCOUNT_SLOTS, PROFILE_AUTO, PROFILE_NONE, loadAccounts, watchAccountsFile, accountConfig,
  persistSlots, accounts, chromeProfiles, profileForSlot, accountLabel, rememberAccountEmail,
  refreshAccountPresentation,
} = require('./lib/accounts');
const accountsModule = require('./lib/accounts');
const { attachExternalLinkRouting } = require('./lib/routing');
const { nativeNotification } = require('./lib/notifications');
const { attachLoadRecovery, recoverAfterResume } = require('./lib/recovery');
const {
  loadCustomCss, applyCustomStyles, manageWindowTitle, attachContextMenu,
} = require('./lib/page-tweaks');
const menu = require('./lib/menu');
const { buildMenu } = menu;

// How long a new window waits for a first frame before it is shown anyway.
const REVEAL_DEADLINE_MS = 4000;

app.on('web-contents-created', (e, wc) => {
  applyCustomStyles(wc);
  manageWindowTitle(wc);
  attachExternalLinkRouting(wc);
  attachLoadRecovery(wc);
  attachContextMenu(wc);
  wc.on('dom-ready', () => rememberAccountEmail(wc));
});

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
  // Publish this slot's session when the user signs in here, so the other apps for the same
  // account can adopt it. Idempotent, so calling it every open is fine.
  sessionSync.attachSlot(n);

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
  windows.set(n, win);
  // Publish this slot's session once its page is up. The cookie-'changed' listener in
  // session-sync only fires on an interactive login or a rotation — cookies restored from
  // disk on a normal launch arrive with no event — so a signed-in app that just starts up
  // would otherwise never share its session. did-finish-load covers that; publish is
  // hash-guarded, so the repeat loads a Google page does are no-ops.
  win.webContents.on('did-finish-load', () => sessionSync.publish(n));
  // Adopt a shared session ONLY if this window actually reaches Google sign-in — so the
  // Google apps (and Tidal's "continue with Google") pick up an existing session, while an
  // app that never authenticates through Google never has a Google session injected into its
  // jar. The trade for that scoping: a signed-out Google app flashes its login redirect once
  // before the session is adopted and it reloads, rather than painting pre-authenticated.
  sessionSync.watchAuthNavigation(n, win.webContents);
  win.loadURL(APP_URL, { userAgent: CHROME_UA });
  win.on('closed', () => {
    if (revealTimer) { clearTimeout(revealTimer); revealTimer = null; }
    windows.delete(n);
  });
  return win;
}

// ACCOUNT_SLOTS is the bound, not an arbitrary ceiling: this used to scan to 50, which meant
// "New Account Window" past the sixth built a slot nothing else in the app could reach. The
// Accounts window only renders slots 1..ACCOUNT_SLOTS and accounts:save drops anything above
// it, so slot 7 could never be named — yet rememberAccountEmail happily persisted a detected
// address for it into the SHARED accounts.json, where every app then read it back forever.
// The write path and the UI path have to agree about how many slots exist.
//
// With every slot occupied this returns 1, and openAccountWindow focuses that window rather
// than opening anything — the honest outcome of "there is no free slot".
function nextFreeSlot() {
  for (let i = 1; i <= ACCOUNT_SLOTS; i++) {
    const w = windows.get(i);
    if (!w || w.isDestroyed()) return i;
  }
  return 1;
}

function openAccountsWindow() {
  const open = getAccountsWindow();
  if (open && !open.isDestroyed()) {
    open.focus();
    return open;
  }
  const accountsWindow = new BrowserWindow(Object.assign({
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
  setAccountsWindow(accountsWindow);
  accountsWindow.setMenuBarVisibility(false);
  accountsWindow.loadFile(path.join(__dirname, 'accounts.html'));
  accountsWindow.on('closed', () => setAccountsWindow(null));
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

app.setName(APP_NAME);
// Must follow setName: one of the stylesheet sources lives under userData.
loadCustomCss();
// Must follow setName: the preference file lives under userData, which is named after the app.
loadAccounts();
watchAccountsFile();
// Single sign-on across the apps: sign into an account once, and the other apps for it adopt
// the session. Shares only Google auth cookies, encrypted at rest with a key in the OS
// keyring, keyed by the signed-in email — see session-sync.js. Disables itself if the
// keyring is unavailable, so this call is safe on any platform.
sessionSync.init({
  storeDir: path.join(ACCOUNTS_DIR, 'sessions'),
  emailForSlot: (n) => accountConfig(n).email,
  windowsForSlot: (n) => { const w = windows.get(n); return w ? [w] : []; },
  log: logRecovery,
});
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


// Close the two would-be cycles described at the top of this file.
menu.init({ openAccountWindow, nextFreeSlot, openAccountsWindow });
theme.onChanged(buildMenu);
accountsModule.onChanged(buildMenu);

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

  app.whenReady().then(async () => {
    await whenWidevineReady();
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
    // app sat dead until each window was reloaded by hand. recoverAfterResume() waits until
    // the origin actually answers before touching anything.
    powerMonitor.on('resume', () => recoverAfterResume('resume'));

    // Belt and braces: on a machine where 'resume' does not arrive (it comes from logind's
    // PrepareForSleep on Linux, and a session without that just never fires it), a long
    // sleep would otherwise leave every window holding a dead connection with nothing to
    // notice. Waking a laptop reliably produces a screen unlock, so treat that as the
    // backstop trigger. The reachability probe means a spurious unlock costs one HEAD
    // request, and the single-flight guard means a real wake does not recover twice.
    powerMonitor.on('unlock-screen', () => recoverAfterResume('unlock-screen'));
  });
}

app.on('window-all-closed', () => {
  if (!IS_MAC) app.quit();
});

