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

// A page-level notification (one Electron shows itself on Linux, so it is NOT mirrored) was
// clicked. Electron does not focus the app for those, so the preload forwards the click here
// and we raise the window it belongs to. This is the click→focus that the mirrored path gets
// for free but the native path did not — the reason clicking e.g. a Google Messages
// notification did nothing.
ipcMain.on('notification-focus', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  logRecovery('notification click → focus ' + (win ? 'slot ' + (slotOf(event.sender) || '?') : 'no window'));
  focusWindow(win);
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

module.exports = { nativeNotification, showMirroredNotification };
