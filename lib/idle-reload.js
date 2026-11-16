// Opt-in memory relief: reload an account window that the user is not looking at and has
// not focused for a while, reclaiming whatever its long-lived page accumulated. Kept out of
// main.js so the decision table (focused / visible / audible / URL / threshold) is testable
// without Electron.

function createIdleReloader(opts) {
  const windows = opts.windows;
  const appUrl = opts.appUrl || '';
  const idleMs = opts.idleMs || 0;
  const log = opts.log || (() => {});
  const now = opts.now || (() => Date.now());
  const lastFocusAt = new WeakMap();
  const createdAt = new WeakMap();

  function noteWindow(win) {
    const t = now();
    createdAt.set(win, t);
    lastFocusAt.set(win, t);
  }

  function noteFocus(win) {
    lastFocusAt.set(win, now());
  }

  function maybeReload() {
    if (!idleMs) return 0;
    const t = now();
    let reloaded = 0;
    for (const [n, win] of windows) {
      if (!win || win.isDestroyed()) continue;
      const wc = win.webContents;
      if (!wc || wc.isDestroyed()) continue;
      // A focused window is in use; refresh its idle clock.
      if (win.isFocused()) { lastFocusAt.set(win, t); continue; }
      // Only windows the user is not looking at: minimized or on another workspace. A
      // visible side-by-side window is left alone even when unfocused.
      if (!win.isMinimized() && win.isVisible()) continue;
      if (wc.isCurrentlyAudible()) continue; // never interrupt a call or playing media
      try { if (wc.isDevToolsOpened && wc.isDevToolsOpened()) continue; } catch (e) { continue; }
      let href = '';
      try { href = wc.getURL(); } catch (e) { continue; }
      if (!href || !appUrl || !href.startsWith(appUrl)) continue;
      const last = lastFocusAt.get(win) || createdAt.get(win) || 0;
      if (!last || t - last < idleMs) continue;
      lastFocusAt.set(win, t);
      log('idle reload: slot ' + n + ' hidden for ' + Math.round((t - last) / 60000) + 'm');
      try {
        // Load the app's home rather than reload(): if the window was sitting on a stale
        // or error document, this returns to a known-good URL, and the load-recovery layer
        // retries a failure — so an idle reload never leaves the window down.
        if (appUrl && typeof wc.loadURL === 'function') {
          const p = wc.loadURL(appUrl);
          if (p && typeof p.catch === 'function') p.catch(() => {});
        } else {
          wc.reload();
        }
        reloaded++;
      } catch (e) { log('idle reload failed: ' + (e && e.message)); }
    }
    return reloaded;
  }

  return { noteWindow, noteFocus, maybeReload };
}

module.exports = { createIdleReloader };
