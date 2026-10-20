// Native desktop notifications, and mirroring the page's web notifications onto them.
// Which notifications get mirrored is platform-specific and was settled by measurement --
// see the table below, and the matching half of the policy in preload.js.
const { Notification, BrowserWindow, ipcMain } = require('electron');
const { APP_ICON, APP_NAME } = require('./config');
const { focusWindow } = require('./window-registry');
const { slotOf } = require('./accounts');
const { logRecovery } = require('./util');

// Build a native notification. On Linux the banner has no bundle to inherit an icon from,
// so the app PNG is attached explicitly; on macOS the .app icon is used automatically and
// APP_ICON is null, leaving the options untouched.
function nativeNotification(opts) {
  return new Notification(APP_ICON ? Object.assign({ icon: APP_ICON }, opts) : opts);
}

// Notifications on screen, held until clicked or closed. Electron does not keep a shown
// Notification alive itself: once the JS object is collected its destructor detaches the
// native banner (electron_api_notification.cc, set_delegate(nullptr)), which stays on
// screen and in the tray but no longer reports the click. A banner the user opens from the
// tray minutes later is exactly the one most likely to have been collected by then.
const live = new Set();

// Bring `win` forward, then report whether the desktop actually let it come forward. On
// GNOME Wayland a raise is only honoured with an activation token; a notification click
// carries one (Electron hands libnotify's token to the next activation), anything else is
// refused while another app has focus. A refusal is silent -- the window just stays put --
// so the log line is the only place it shows.
function focusFromNotification(win, source) {
  if (!win || win.isDestroyed()) {
    logRecovery('notification click (' + source + ') → no window left to focus');
    return;
  }
  const slot = slotOf(win.webContents) || '?';
  // Wait for the focus event rather than sampling once: the raise is a round trip through the
  // compositor, and a fixed 500ms check reported Messenger "NOT focused" on a click the user
  // watched bring it forward.
  let timer = null;
  const focused = () => {
    clearTimeout(timer);
    logRecovery('notification click (' + source + ') → slot ' + slot + ' focused');
  };
  win.once('focus', focused);
  timer = setTimeout(() => {
    if (win.isDestroyed()) return;
    win.removeListener('focus', focused);
    logRecovery('notification click (' + source + ') → slot ' + slot +
      (win.isFocused() ? ' focused' : ' NOT focused after 3s (desktop refused the raise)'));
  }, 3000);
  focusWindow(win);
}

// Show a native notification that brings `win` forward when clicked.
function showNotificationFor(win, opts, source, onClick) {
  if (!Notification.isSupported()) return;
  const native = nativeNotification(opts);
  live.add(native);
  const release = () => live.delete(native);
  native.on('close', release);
  native.on('failed', release);
  native.on('click', () => {
    release();
    focusFromNotification(win, source);
    if (onClick) onClick();
  });
  native.show();
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
  // The page's own click handling for these lives in its service worker, which Electron never
  // reaches, so a click can bring the right window forward but not open the specific item.
  // Logging which apps take this path, and what their data carries (keys only), is what a
  // later deep link would be built from.
  const keys = n && n.data && typeof n.data === 'object' ? Object.keys(n.data).join(',') : typeof (n && n.data);
  logRecovery('mirrored notification from slot ' + (slotOf(event.sender) || '?') + ', data: ' + keys);
  showNotificationFor(BrowserWindow.fromWebContents(event.sender), {
    title: (n && n.title) ? n.title : APP_NAME,
    body: (n && n.body) ? n.body : '',
  }, 'mirrored', () => {
    try { event.sender.send('mirror-notification-click', n && n.id); } catch (e) {}
  });
});

// A page-level notification (one Electron shows itself on Linux, so it is NOT mirrored) was
// clicked. Electron does not focus the app for those, so the preload forwards the click here
// and we raise the window it belongs to. This is the click→focus that the mirrored path gets
// for free but the native path did not — the reason clicking e.g. a Google Messages
// notification did nothing.
ipcMain.on('notification-focus', (event, source) => {
  focusFromNotification(BrowserWindow.fromWebContents(event.sender),
    source === 'window.focus' ? 'window.focus' : 'page');
});

// One line per page-level notification, so a banner that never shows up here was posted
// somewhere the preload's hook does not reach.
ipcMain.on('notification-posted', (event) => {
  logRecovery('page notification posted from slot ' + (slotOf(event.sender) || '?'));
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

module.exports = { nativeNotification, showNotificationFor, focusFromNotification };
