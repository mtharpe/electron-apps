// Link schemes this app takes over from the desktop — mailto: opening Gmail's compose, say.
// Declared per service in services.conf (the `handlers` field) and carried in
// app-config.json, so no vendor's URL is hardcoded here. Depends only on config, so both
// main.js (links handed to the process) and routing.js (links clicked in a page) can use it.
const { cfg } = require('./config');

// "mailto=https://mail.google.com/mail/?extsrc=mailto&url=%s", comma-separated. %s receives
// the whole original URL, percent-encoded. Only an https template is accepted: the result is
// loaded straight into an account's session.
const HANDLERS = new Map(
  String(cfg.handlers || '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const i = s.indexOf('=');
    if (i <= 0) return null;
    const tpl = s.slice(i + 1).trim();
    if (!/^https:\/\//i.test(tpl) || !tpl.includes('%s')) return null;
    return [s.slice(0, i).trim().toLowerCase().replace(/:$/, '') + ':', tpl];
  }).filter(Boolean)
);

// The in-app URL a handled link should load, or null when this app does not handle it.
function handledUrl(url) {
  let scheme;
  try { scheme = new URL(url).protocol.toLowerCase(); } catch (e) { return null; }
  const tpl = HANDLERS.get(scheme);
  return tpl ? tpl.replace('%s', encodeURIComponent(url)) : null;
}

// The desktop launches a handler as `<exe> <url>` (Exec=... %U), both for a cold start and —
// through the single-instance lock — for an app that is already running.
function handledUrlFromArgv(argv) {
  for (const arg of argv || []) {
    const u = handledUrl(arg);
    if (u) return u;
  }
  return null;
}

// Windows are main.js's to create, so it registers how a handled link is opened; routing.js
// reaches it through here rather than requiring main.js back.
let opener = null;
function setOpener(fn) { opener = fn; }

// Open a link this app handles, in account slot `slot`. False when it is not ours to open.
function openHandled(url, slot) {
  const target = handledUrl(url);
  if (!target || !opener) return false;
  opener(slot || 1, target);
  return true;
}

module.exports = { handledUrl, handledUrlFromArgv, setOpener, openHandled };
