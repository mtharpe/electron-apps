// Getting a window back to a live page after the network, or the machine, went away.
// Two distinct problems: a single navigation that failed, and a whole machine that slept.
const { BrowserWindow, net } = require('electron');
const { APP_URL } = require('./config');
const { wait, logRecovery } = require('./util');
const { CHROME_UA } = require('./chromium');
const { getAccountsWindow } = require('./window-registry');

// Nothing in Electron retries a navigation that dies — DNS not up yet at login, the
// network still coming back after sleep, a connection dropped mid-load. The window is just
// left holding whatever it had. Gmail and Calendar mostly self-heal, because their live
// data connections keep re-rendering; Tasks and Keep inject their whole stylesheet from the
// app bundle and then go idle, so a load that dies part-way leaves a permanently blank
// white window until the user reloads by hand. Hence: retry, with a backoff so a genuinely
// unreachable network isn't hammered.
const RELOAD_BACKOFF_MS = [1000, 2000, 5000, 10000, 20000, 30000];
// While the machine is offline a retry cannot succeed, so we wait on the network coming
// back instead of spending (and escalating) an attempt on a certain failure.
const OFFLINE_POLL_MS = 2000;
const ERR_ABORTED = -3;
// Keyed by webContents so the state dies with the window it belongs to.
const reloadAttempts = new WeakMap();
const reloadTimers = new WeakMap();

function cancelReloadRetry(wc) {
  const timer = reloadTimers.get(wc);
  if (timer) { clearTimeout(timer); reloadTimers.delete(wc); }
}

// `url` is the address to retry. Retrying a failed navigation loads that address again
// explicitly rather than calling reload(), which would depend on what Chromium left in the
// history entry after the failure — loading the known-good URL does not. Omit `url` (the
// post-sleep path) to refresh whatever the window is already showing.
function scheduleReload(wc, url) {
  if (wc.isDestroyed() || reloadTimers.has(wc)) return; // one retry in flight at a time
  const attempt = reloadAttempts.get(wc) || 0;
  const delay = RELOAD_BACKOFF_MS[Math.min(attempt, RELOAD_BACKOFF_MS.length - 1)];
  reloadTimers.set(wc, setTimeout(() => {
    reloadTimers.delete(wc);
    if (wc.isDestroyed()) return;
    // Still no network: come back later WITHOUT counting this as an attempt, so the backoff
    // reflects real failed loads rather than how long the laptop sat offline.
    if (!net.isOnline()) {
      reloadTimers.set(wc, setTimeout(() => { reloadTimers.delete(wc); scheduleReload(wc, url); }, OFFLINE_POLL_MS));
      return;
    }
    reloadAttempts.set(wc, attempt + 1);
    // A rejection here is the same failure did-fail-load is about to report, and that
    // handler is what queues the next attempt — so swallow it rather than double-counting.
    if (url) wc.loadURL(url, { userAgent: CHROME_UA }).catch(() => {});
    else wc.reload();
  }, delay));
}

// Waking from sleep is not the same problem as a failed load, and net.isOnline() is not a
// good enough answer to "can we talk to the server yet". It reflects the OS network-change
// notifier, which flips to true as soon as an interface has a link — while DHCP, DNS and
// routing are still settling, and long before a VPN or a captive portal has let anything
// through. Reloading on that signal produces a window full of error page, which is exactly
// what this is supposed to prevent.
//
// So ask the only question that matters: does the app's own origin answer? Nothing is
// reloaded until something does.
const REACHABILITY_TIMEOUT_MS = 5000;
const REACHABILITY_BACKOFF_MS = [1000, 2000, 5000, 10000, 15000, 30000];
// Cap the post-wake wait: ~40 tries settle at 30s each ≈ 20 min of trying, after which a
// still-offline machine is left alone until the next resume/unlock re-arms recovery.
const RESUME_MAX_ATTEMPTS = 40;

function probeOrigin() {
  return new Promise((resolve) => {
    let settled = false;
    // The deadline is cleared on the way out, not just guarded by `settled`. recoverAfterResume
    // runs up to RESUME_MAX_ATTEMPTS probes, so leaving each one's timer armed left a trail of
    // pending 5s timers firing abort() at requests that had already finished.
    let timer = null;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      if (timer) { clearTimeout(timer); timer = null; }
      resolve(ok);
    };
    let req;
    // Any HTTP response means the server answered; the status is irrelevant, a redirect or
    // even a 4xx proves the path is open.
    try {
      req = net.request({ method: 'HEAD', url: APP_URL });
      req.on('response', () => finish(true));
      req.on('error', () => finish(false));
      req.end();
    } catch (e) {
      finish(false);
      return;
    }
    timer = setTimeout(() => { try { req.abort(); } catch (e) {} finish(false); }, REACHABILITY_TIMEOUT_MS);
  });
}

// One recovery at a time: suspend/resume can fire in quick succession (lid closed, opened,
// closed again) and a second pass would race the first.
let resumeRecovery = null;

function recoverAfterResume(trigger) {
  if (resumeRecovery) {
    logRecovery(trigger + ': already recovering, ignored');
    return resumeRecovery;
  }
  const started = Date.now();
  logRecovery(trigger + ': waiting for ' + APP_URL + ' to answer');
  resumeRecovery = (async () => {
    // Wait for the origin to answer, but not forever: if the machine simply stays offline
    // there is nothing to recover, and the NEXT resume/unlock re-arms this anyway. Bounded so
    // a permanently-offline session doesn't leave a timer looping for the life of the process.
    let reachable = false;
    for (let attempt = 0; attempt < RESUME_MAX_ATTEMPTS; attempt++) {
      if (BrowserWindow.getAllWindows().every((w) => w.isDestroyed())) return; // nothing to reload
      if (await probeOrigin()) { reachable = true; break; }
      await wait(REACHABILITY_BACKOFF_MS[Math.min(attempt, REACHABILITY_BACKOFF_MS.length - 1)]);
    }
    if (!reachable) { logRecovery(trigger + ': origin still unreachable, giving up until next wake'); return; }
    let reloaded = 0;
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      // NOT the Accounts window. It is a local form, it has nothing stale to refresh, and
      // reloading it would throw away a name the user had half-finished typing.
      if (win === getAccountsWindow()) continue;
      win.webContents.reload();
      reloaded++;
    }
    logRecovery(trigger + ': reachable after ' + (Date.now() - started) + 'ms, reloaded ' + reloaded + ' window(s)');
  })().catch(() => { /* a reload that fails is the retry layer's problem, not this one's */ })
    .finally(() => { resumeRecovery = null; });
  return resumeRecovery;
}

// Whether the load currently in flight has already reported a failure. Reset at the start
// of every navigation, so it always describes the attempt in progress and nothing else.
const loadFailed = new WeakSet();

function attachLoadRecovery(wc) {
  wc.on('did-start-loading', () => loadFailed.delete(wc));

  wc.on('did-fail-load', (e, errorCode, errorDesc, validatedURL, isMainFrame) => {
    // A dead subresource or iframe is not a dead window — Google's pages routinely lose a
    // hovercard or a cookie-rotation frame and carry on fine. Only the main frame matters.
    if (!isMainFrame) return;
    // ERR_ABORTED is an ordinary superseded navigation (a redirect taking over, the user
    // clicking through mid-load), not a failure. Reloading on it would fight the page.
    if (errorCode === ERR_ABORTED) return;
    loadFailed.add(wc);
    scheduleReload(wc, validatedURL);
  });

  wc.on('did-finish-load', () => {
    // A failed navigation still COMMITS Chromium's error document, and finishing that
    // document fires this event — measured: did-fail-load, then did-finish-load for the
    // same URL. Resetting here unconditionally cancelled the retry that had just been
    // queued, which is why nothing ever retried. Only a load that did not fail counts.
    if (loadFailed.has(wc)) return;
    // A load that lands clears the backoff, so a later unrelated failure starts fresh.
    cancelReloadRetry(wc);
    reloadAttempts.delete(wc);
  });

  wc.on('destroyed', () => cancelReloadRetry(wc));
}

module.exports = { attachLoadRecovery, recoverAfterResume };
