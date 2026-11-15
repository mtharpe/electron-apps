// Native desktop notifications, and mirroring the page's web notifications onto them.
// Which notifications get mirrored is platform-specific and was settled by measurement --
// see the table below, and the matching half of the policy in preload.js.
const { Notification, BrowserWindow, ipcMain } = require('electron');
const { APP_ICON, APP_NAME, APP_HOST, cfg } = require('./config');
const { windows, focusWindow } = require('./window-registry');
const { slotOf } = require('./accounts');
const { logRecovery } = require('./util');

// The hosts whose pages may drive the notification IPC. Computed here rather than imported
// from routing.js, which already requires this module -- requiring it back would close a
// require cycle. The set mirrors routing's first-party hosts: the app's own host, its
// registrable domain (so a viewer window on another page of the same site still counts), the
// `related` domains a service declares, and Google's two common ones. This is a sanity gate
// on an IPC channel, not a routing decision, so it only ever needs host granularity.
const NOTIFICATION_HOSTS = (() => {
  const out = new Set(['google.com', 'gstatic.com']);
  const host = String(APP_HOST || '').toLowerCase();
  if (host) {
    out.add(host);
    const parts = host.split('.').filter(Boolean);
    // Same naive last-two-labels registrable domain routing uses. Over-broad for a public
    // suffix such as .co.uk, but every bundled app is a .com service and a too-narrow set
    // would silently drop real notification clicks.
    if (parts.length >= 2) out.add(parts.slice(-2).join('.'));
  }
  for (const d of String(cfg.related || '').split(/[,\s]+/)) {
    const v = d.trim().toLowerCase().replace(/^\.+/, '');
    if (v) out.add(v);
  }
  return out;
})();

function hostIsFirstParty(host) {
  host = String(host || '').toLowerCase();
  if (!host) return false;
  for (const d of NOTIFICATION_HOSTS) {
    if (host === d || host.endsWith('.' + d)) return true;
  }
  return false;
}

function senderHost(event) {
  try { return new URL(event.senderFrame.url).hostname; } catch (e) { return '?'; }
}

// Only the top frame of a page still on a first-party host may post banners or raise a
// window. A renderer that has navigated elsewhere (an SSO provider, an outside site) or an
// iframe must not be able to drive the OS notification/raise path at all.
function isTrustedSender(event) {
  try {
    const frame = event.senderFrame;
    if (!frame || frame !== event.sender.mainFrame) return false;
    return hostIsFirstParty(new URL(frame.url).hostname);
  } catch (e) {
    return false;
  }
}

// Page-controlled strings reach log lines. Collapse line breaks (which could forge extra log
// entries) and cap the length so a hostile page cannot flood the journal.
function logValue(value, max) {
  return String(value == null ? '' : value).replace(/[\r\n\u2028\u2029]+/g, ' ').slice(0, max);
}

// Native banner fields are page-controlled too; coerce and bound them before handing them to
// the desktop.
function bounded(value, max) {
  return String(value == null ? '' : value).slice(0, max);
}

const TITLE_MAX = 200;
const BODY_MAX = 2000;

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
//
// Bounded anyway: a desktop that never reports close/failed, or a page posting in a loop,
// must not retain every Notification for the process's lifetime. Insertion order is oldest
// first, so the cap drops banners least likely to still be on screen. The age limit is
// deliberately generous -- comfortably past the "clicked from the tray minutes later" case
// this set exists for -- and only bounds a slow trickle no new notification would prune.
const LIVE_MAX = 100;
const LIVE_TTL_MS = 60 * 60 * 1000;
const live = new Map(); // Notification -> Date.now() when shown

function pruneLive() {
  const cutoff = Date.now() - LIVE_TTL_MS;
  // No early exit: a backwards clock step could otherwise hide an old entry behind a fresh
  // one, and the collection is capped at LIVE_MAX so scanning it is cheap.
  for (const [native, at] of live) {
    if (at < cutoff) live.delete(native);
  }
  while (live.size > LIVE_MAX) {
    const oldest = live.keys().next().value;
    if (oldest === undefined) break;
    live.delete(oldest);
  }
}

// Bring `win` forward, then report whether the desktop actually let it come forward. On
// GNOME Wayland a raise is only honoured with an activation token; a notification click
// carries one (Electron hands libnotify's token to the next activation), anything else is
// refused while another app has focus. A refusal is silent -- the window just stays put --
// so the log line is the only place it shows.
//
// `slotHint` is the slot captured when the banner was shown. By click time the window may
// have been replaced (closing and reopening an account slot does not move the slot), and the
// destroyed BrowserWindow cannot say which slot it was; without the hint there is nothing
// left to look up. A replacement is focused, never reopened.
function focusFromNotification(win, source, slotHint) {
  let slot = slotHint;
  if (slot == null && win && !win.isDestroyed()) slot = slotOf(win.webContents);
  let target = win;
  if (!target || target.isDestroyed()) {
    const replacement = slot == null ? null : windows.get(slot);
    if (!replacement || replacement.isDestroyed()) {
      logRecovery('notification click (' + source + ') → no window left to focus' +
        (slot == null ? '' : ' (slot ' + slot + ')'));
      return;
    }
    logRecovery('notification click (' + source + ') → slot ' + slot +
      ' window was replaced; focusing the new one');
    target = replacement;
  }
  const label = slot == null ? '?' : slot;
  // Wait for the focus event rather than sampling once: the raise is a round trip through the
  // compositor, and a fixed 500ms check reported Messenger "NOT focused" on a click the user
  // watched bring it forward.
  let timer = null;
  const focused = () => {
    clearTimeout(timer);
    logRecovery('notification click (' + source + ') → slot ' + label + ' focused');
  };
  target.once('focus', focused);
  timer = setTimeout(() => {
    if (target.isDestroyed()) return;
    target.removeListener('focus', focused);
    logRecovery('notification click (' + source + ') → slot ' + label +
      (target.isFocused() ? ' focused' : ' NOT focused after 3s (desktop refused the raise)'));
  }, 3000);
  focusWindow(target);
}

// Show a native notification that brings `win` forward when clicked.
function showNotificationFor(win, opts, source, onClick) {
  if (!Notification.isSupported()) return;
  // Captured while the window still exists -- see focusFromNotification.
  const slot = win && !win.isDestroyed() ? slotOf(win.webContents) : null;
  let native;
  try { native = nativeNotification(opts); } catch (e) {
    logRecovery('could not build native notification: ' + logValue(e && e.message, 120));
    return;
  }
  live.set(native, Date.now());
  pruneLive();
  const release = () => live.delete(native);
  native.on('close', release);
  native.on('failed', release);
  native.on('click', () => {
    release();
    focusFromNotification(win, source, slot);
    if (onClick) onClick();
  });
  try { native.show(); } catch (e) {
    release();
    logRecovery('native notification failed to show: ' + logValue(e && e.message, 120));
  }
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
  if (!isTrustedSender(event)) {
    logRecovery('ignored mirrored notification from untrusted sender (' +
      logValue(senderHost(event), 80) + ')');
    return;
  }
  // The page's own click handling for these lives in its service worker, which Electron never
  // reaches, so a click can bring the right window forward but not open the specific item.
  // Logging which apps take this path, and what their data carries (keys only), is what a
  // later deep link would be built from. The keys are page-controlled, so they are sanitised.
  const keys = n && n.data && typeof n.data === 'object' ? Object.keys(n.data).join(',') : typeof (n && n.data);
  logRecovery('mirrored notification from slot ' + (slotOf(event.sender) || '?') +
    ', data: ' + logValue(keys, 200));
  showNotificationFor(BrowserWindow.fromWebContents(event.sender), {
    title: bounded(n && n.title, TITLE_MAX) || APP_NAME,
    body: bounded(n && n.body, BODY_MAX),
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
  if (!isTrustedSender(event)) {
    logRecovery('ignored notification-focus from untrusted sender (' +
      logValue(senderHost(event), 80) + ')');
    return;
  }
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
