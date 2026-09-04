// Where a link opens: in-app, or handed to the user's real browser.
//
// Two separate gates, both required. setWindowOpenHandler covers window.open/target=_blank;
// will-navigate covers a top-frame navigation, which would otherwise replace the app with an
// outside site inside the stealth renderer -- spoofed fingerprint, granted permissions and all.
const path = require('path');
const fs = require('fs');
const { app, shell } = require('electron');
const { execFile, spawn } = require('child_process');
const { cfg, IS_MAC, APP_HOST } = require('./config');
const { hasSuffix, logRecovery } = require('./util');
const { slotOf, profileForSlot } = require('./accounts');
const { STEALTH_WEBPREFS } = require('./chromium');

// First-party Google hosts we keep IN-APP (anything else opens in the user's real browser).
const GOOGLE_HOST_SUFFIXES = [
  'google.com', 'gstatic.com', 'googleusercontent.com', 'googleapis.com',
];

// The app's OWN registrable domain, derived from its URL: listen.tidal.com -> tidal.com.
// Naive last-two-labels, which is wrong for public suffixes like .co.uk (it would yield
// "co.uk" and match far too much) -- so it is only ever used to keep an app's own pages
// in-app, never to grant trust. A too-broad match there costs a page opening in the app
// instead of the browser, not a security boundary.
const APP_DOMAIN = (() => {
  const parts = APP_HOST.split('.').filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join('.') : APP_HOST;
})();

// Extra first-party domains a service declares because its product spans more than one
// registrable domain. Messenger is the case that forced this: the app points at
// facebook.com, but Meta serves voice/video CALLS from messenger.com, so a call window opens
// on a domain that is not the app's own — and without this it would be treated as external
// and shoved to the browser, breaking the call entirely. Declared per service in
// services.conf (see the `related` field), carried in app-config.json, so generic code never
// hardcodes any vendor's second domain.
const APP_RELATED_HOSTS = String(cfg.related || '')
  .split(/[,\s]+/).map((s) => s.trim().toLowerCase().replace(/^\.+/, '')).filter(Boolean);

// URL path prefixes on the app's OWN registrable domain that stay in-app. Empty (the
// common case) means the entire domain stays in-app — Gmail on mail.google.com, Tidal on
// tidal.com, whatever. Non-empty is for a service tenanted inside a bigger site: Messenger
// lives on facebook.com but is only one narrow slice of it, so a click on a group post
// link inside a chat would otherwise navigate the app into the group page (same domain,
// treated as first-party) and leave the user stuck on Facebook proper inside "Messenger".
// With paths declared, only URLs whose pathname is under one of these prefixes ON THE
// APP'S REGISTRABLE DOMAIN count as first-party for its domain; everything else on that
// domain is handed to the real browser. RELATED hosts and SSO providers are matched by
// host and are unaffected by this scoping.
const APP_PATH_PREFIXES = String(cfg.paths || '')
  .split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);

// True if `pathname` sits under one of the declared in-app prefixes. Boundary-aware:
// `/login` matches `/login`, `/login/`, `/login.php`, `/login?next=...` but NOT
// `/logins-of-x`. `/` as a prefix would otherwise match every path — kept exact-only.
function pathInAppScope(pathname) {
  const p = (pathname || '/').toLowerCase();
  for (const prefix of APP_PATH_PREFIXES) {
    if (p === prefix) return true;
    if (prefix === '/') continue;
    if (p.startsWith(prefix + '/') || p.startsWith(prefix + '.') || p.startsWith(prefix + '?')) return true;
  }
  return false;
}

// Kept in-app rather than pushed out to the browser. Google's hosts are here because four
// of the bundled apps are Google's and their UI spans several of them; the app's own domain
// is here because every app needs its own pages, and a Tidal wrapper that opened
// tidal.com links in Firefox would be useless -- sign-in alone would never complete; the
// declared related hosts cover a product split across two domains (Messenger's calls); and
// the app's domain may be path-scoped (see APP_PATH_PREFIXES) when the app is only a
// tenant of a larger site.
function isFirstPartyUrl(u) {
  const host = u.hostname;
  if (hasSuffix(host, GOOGLE_HOST_SUFFIXES)) return true;
  if (APP_RELATED_HOSTS.length > 0 && hasSuffix(host, APP_RELATED_HOSTS)) return true;
  if (!!APP_DOMAIN && hasSuffix(host, [APP_DOMAIN])) {
    return APP_PATH_PREFIXES.length === 0 || pathInAppScope(u.pathname);
  }
  return false;
}

// Hostname-only variant, kept for callers that only have a host string. Loses the path
// scoping, so within routing.js prefer isFirstPartyUrl. Left in the module exports because
// removing it would be a silent breakage for anything outside that reaches for it.
function isFirstPartyHost(host) {
  return hasSuffix(host, GOOGLE_HOST_SUFFIXES)
    || (!!APP_DOMAIN && hasSuffix(host, [APP_DOMAIN]))
    || (APP_RELATED_HOSTS.length > 0 && hasSuffix(host, APP_RELATED_HOSTS));
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
// var (ELECTRON_APPS_AUTH_DOMAINS) and/or a JSON array at <userData>/auth-domains.json. Read
// once at startup.
//
// GOOGLE_APP_AUTH_DOMAINS is the pre-rename spelling, still honoured so an existing setup
// does not silently lose its suffixes the first time it runs a rebuilt app. Consulted only
// when the current name is unset; drop it once nobody is on a build older than this one.
function loadExtraAuthSuffixes() {
  const out = [];
  try {
    const env = process.env.ELECTRON_APPS_AUTH_DOMAINS || process.env.GOOGLE_APP_AUTH_DOMAINS;
    if (env) out.push(...env.split(/[,\s]+/));
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
// Resolved on first use, not at require time. In the single-file version this ran after
// app.setName(); as a module it would run before it, and app.getPath('userData') is only
// correct once the app has been named -- so the file would be looked for in the wrong
// directory, and finding nothing there looks exactly like the normal empty case.
// Still read once and cached, which is all the original promised.
let extraAuthSuffixes = null;
function getExtraAuthSuffixes() {
  if (extraAuthSuffixes === null) extraAuthSuffixes = loadExtraAuthSuffixes();
  return extraAuthSuffixes;
}

function isAuthHost(host) {
  return hasSuffix(host, IDP_HOST_SUFFIXES) || hasSuffix(host, getExtraAuthSuffixes());
}

// Open external links (e.g. links inside emails) in the user's Chrome browser, falling
// back to the system default browser if Chrome isn't installed.
//
// macOS resolves "Google Chrome" by bundle name via `open -a`; Linux has no such lookup,
// so we probe PATH for the usual Chrome/Chromium executables ourselves. Either way the
// last resort is shell.openExternal (LaunchServices / xdg-open), which honours whatever
// the user actually set as their default browser. ELECTRON_APPS_BROWSER overrides the probe
// with an explicit command for anyone who wants a different browser (or a flatpak wrapper);
// GOOGLE_APP_BROWSER is the pre-rename spelling and is still honoured as a fallback.
const LINUX_BROWSERS = [
  'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser',
  'brave-browser', 'microsoft-edge',
];

// Resolve the browser command ONCE, by looking for an executable on PATH — deliberately
// not by spawning and watching the exit code. A browser launched into a fresh instance
// doesn't exit until the user quits it, so an exit-code fallback would sit armed for
// hours and then re-open a long-forgotten link in a second browser.
function resolveBrowser() {
  const explicit = String(process.env.ELECTRON_APPS_BROWSER || process.env.GOOGLE_APP_BROWSER || '').trim();
  const names = explicit ? [explicit] : (IS_MAC ? [] : LINUX_BROWSERS);
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const name of names) {
    // An absolute/relative path in ELECTRON_APPS_BROWSER is used as given.
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

// --profile-directory is a Chromium switch. Handing it to a browser that doesn't understand
// it (Firefox, or anything set via ELECTRON_APPS_BROWSER) would at best be ignored and at worst
// be treated as a URL, so it is only ever passed to a browser known to take it.
const CHROMIUM_BROWSER_RE = /(^|[^a-z])(chrome|chromium|brave|msedge|microsoft-edge|vivaldi|opera)([^a-z]|$)/i;

function browserTakesProfileFlag() {
  return !!BROWSER_CMD && CHROMIUM_BROWSER_RE.test(path.basename(BROWSER_CMD));
}

// slot is the account window the link came from; its mapped Chrome profile decides where
// the URL lands. Without one, the URL is handed over bare and Chrome uses its focused
// window — the old behaviour, kept as the fallback rather than guessing.
function openInChrome(url, slot) {
  if (!/^https?:\/\//i.test(url || '')) { if (url) shell.openExternal(url); return; }
  const profile = slot ? profileForSlot(slot) : null;
  // macOS: resolve Chrome by bundle name, falling back to the default browser. `open`
  // exits as soon as it hands off, so its exit code is a safe success signal here.
  if (IS_MAC && !BROWSER_CMD) {
    // -n plus --args is the only way to get a switch through `open`; without a profile
    // there is nothing to pass, so the simpler form (which reuses a running Chrome) stands.
    const args = profile
      ? ['-na', 'Google Chrome', '--args', '--profile-directory=' + profile.dir, url]
      : ['-a', 'Google Chrome', url];
    execFile('open', args, (err) => {
      if (err) shell.openExternal(url);
    });
    return;
  }
  if (!BROWSER_CMD) { shell.openExternal(url); return; }
  const args = (profile && browserTakesProfileFlag())
    ? ['--profile-directory=' + profile.dir, url]
    : [url];
  // Detached + unref'd so a browser we cold-start isn't tied to this app's lifetime
  // (quitting the app must not take the user's browser window down with it).
  try {
    const child = spawn(BROWSER_CMD, args, { detached: true, stdio: 'ignore' });
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
// True if a URL may load IN-APP: the app's own first-party hosts (path-scoped when the
// service declared paths), and recognized SSO providers during sign-in. Everything else
// belongs in the user's real browser.
function mayLoadInApp(u) {
  return isFirstPartyUrl(u) || isAuthHost(u.hostname);
}

function attachExternalLinkRouting(wc) {
  // Allow a popup in-app, keeping it in the opener's account session/cookie jar.
  const allowInApp = () => {
    const part = wc.session && wc.session.__partition;
    const webPreferences = part
      ? Object.assign({ partition: part }, STEALTH_WEBPREFS)
      : STEALTH_WEBPREFS;
    return { action: 'allow', overrideBrowserWindowOptions: { webPreferences } };
  };

  wc.setWindowOpenHandler(({ url }) => {
    // Resolved per click, not captured once: the slot's Chrome profile can change from the
    // Accounts window while these handlers stay attached.
    const slot = slotOf(wc);
    try {
      const u = new URL(url);
      // A popup with no http(s) scheme — about:blank, blob:, data: — is the app opening a
      // child window it will DRIVE itself, not a navigation to somewhere. Messenger opens
      // voice/video CALL windows as about:blank and then navigates them to the real call URL;
      // shoving that to the browser (what shell.openExternal did with 'about:blank') opens a
      // dead blank tab and the call never fires. Keep it in-app; the follow-on navigation to
      // the real URL is gated by will-navigate below (messenger.com is first-party now, so it
      // stays). will-navigate already lets these schemes pass — this makes window.open agree.
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return allowInApp();
      // Gmail wraps links inside emails in a google.com/url?q=<target> redirector → Chrome.
      if (/(^|\.)google\.com$/.test(u.hostname) && u.pathname === '/url') {
        openInChrome(u.searchParams.get('q') || u.searchParams.get('url') || url, slot);
        return { action: 'deny' };
      }
      if (mayLoadInApp(u)) return allowInApp();
    } catch (e) { /* fall through to Chrome */ }
    logExternalRoute('popup', url);
    openInChrome(url, slot);
    return { action: 'deny' };
  });

  // setWindowOpenHandler only covers window.open / target=_blank. A TOP-FRAME navigation to
  // an outside site — a plain <a> with no target, a JS location= , a form post — would
  // otherwise replace the app with that site IN the stealth renderer, which still carries the
  // spoofed Chrome fingerprint and the granted permissions (clipboard-read, notifications).
  // So gate main-frame navigation the same way: first-party and SSO hosts load in-app,
  // anything else is denied here and handed to the real browser instead.
  wc.on('will-navigate', (event, url) => {
    let u;
    try { u = new URL(url); } catch (e) { return; } // unparseable — leave it to Electron
    // Only http(s) is ours to route. about:/blob:/data:/chrome-extension: and the like are
    // in-app machinery (the initial blank document, blob downloads) — never send them out.
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
    if (mayLoadInApp(u)) return; // first-party / SSO → allow the in-frame navigation
    event.preventDefault();
    logExternalRoute('navigate', url);
    openInChrome(url, slotOf(wc));
  });
}

// One line whenever a URL is sent OUT to the real browser — the routing decision that has
// twice been the culprit for Messenger calls (first a messenger.com popup, then an
// about:blank one), so it names exactly what it rejected. For http(s) it logs the SCHEME +
// HOST only, never the path/query, which can carry tokens. For schemeless/internal URLs
// (about:, blob:, data:) there is no token to leak, so the whole value is logged — that is
// precisely the case where the host is empty and only the scheme tells you what happened.
function logExternalRoute(kind, url) {
  let detail = '?';
  try {
    const u = new URL(url);
    detail = (u.protocol === 'http:' || u.protocol === 'https:') ? (u.protocol + '//' + u.host) : String(url).slice(0, 80);
  } catch (e) { detail = String(url).slice(0, 40); }
  logRecovery('routed ' + kind + ' to browser: ' + detail);
}

module.exports = { attachExternalLinkRouting, openInChrome, isFirstPartyUrl, isFirstPartyHost, isAuthHost };
