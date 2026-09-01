// Account slots: the name, the Chrome profile and the detected address behind each one.
// This is the data layer -- it owns accounts.json and Chrome's profile list, and knows
// nothing about how windows or menus present any of it.
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');
const { IS_MAC, ACCOUNTS_DIR } = require('./config');
const { windows } = require('./window-registry');

// Same reason as theme.js: the Accounts menu lists these names, so calling buildMenu() from
// here would make accounts.js and menu.js require each other. main.js wires this up.
let changedCb = () => {};
function onChanged(cb) { changedCb = cb; }

// Window title = JUST the account/org name (e.g. "Acme Corp", "Gmail") so each account's
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

// Accounts: a display name and a Chrome profile per account slot.
//
// Clicking a link used to hand the URL to `google-chrome <url>`, which drops it into
// whichever profile window Chrome happens to have in focus — so a link from the work
// account could land in the personal profile (or a profile that can't even see it).
// Chrome takes --profile-directory=<dir> to pick the target explicitly, so each slot can
// be pinned to one.
//
// The mapping is keyed by slot number rather than by email: the slot is what actually owns
// the cookie jar (persist:account-N), it exists before any page has loaded, and it survives
// the user signing a window into a different account.
const ACCOUNT_SLOTS = 6;

// chromeProfile is 'auto' (match the signed-in address to a Chrome profile), 'none' (hand
// the URL over with no profile flag — Chrome's focused-window behaviour), or a profile
// directory name such as 'Default' / 'Profile 2'.
const PROFILE_AUTO = 'auto';
const PROFILE_NONE = 'none';

const accounts = new Map(); // slot -> { name, chromeProfile, email }

function accountsFile() {
  return path.join(ACCOUNTS_DIR, 'accounts.json');
}

// Where this app's own copy used to live, before the file was shared.
function legacyAccountsFile() {
  return path.join(app.getPath('userData'), 'accounts.json');
}

// Where the shared file lived while every app in the set was a Google app.
function legacySharedAccountsFile() {
  return path.join(app.getPath('appData'), 'google-standalone-apps', 'accounts.json');
}

function parseAccounts(text) {
  const out = new Map();
  const raw = JSON.parse(text);
  for (const [k, v] of Object.entries(raw)) {
    const n = Number(k);
    if (!Number.isInteger(n) || n < 1 || !v || typeof v !== 'object') continue;
    out.set(n, {
      name: typeof v.name === 'string' ? v.name.trim() : '',
      chromeProfile: typeof v.chromeProfile === 'string' ? v.chromeProfile : PROFILE_AUTO,
      email: typeof v.email === 'string' ? v.email : '',
    });
  }
  return out;
}

function loadAccounts() {
  try {
    const parsed = parseAccounts(fs.readFileSync(accountsFile(), 'utf8'));
    accounts.clear();
    for (const [n, cfg] of parsed) accounts.set(n, cfg);
  } catch {
    // Missing or corrupt: missing is the first run, corrupt should not wipe the mapping.
  }
  migrateLegacyAccounts();
}

// Fold older locations into the current shared file. Deliberately a merge rather than a
// "shared file missing? adopt mine": the apps start in any order, and the first of them to
// detect an address creates the shared file — so a plain existence check would let whichever
// app happened to start first discard names set in another.
//
// Newest scheme first, so a gap is filled from the most recent source that has a value.
function migrateLegacyAccounts() {
  // The old SHARED file is never renamed away. Apps are installed individually now, so
  // rebuilding just one of them must not strand the others — anything still running the old
  // build keeps reading that file, and leaving it costs nothing because the merge only ever
  // fills gaps. It stops being consulted once every app has been rebuilt.
  mergeAccountsFrom(legacySharedAccountsFile(), false);
  // This app's pre-sharing copy, which only it can own — safe to retire once merged.
  mergeAccountsFrom(legacyAccountsFile(), true);
}

// Only gaps are filled; anything already in the shared file was set later and wins. When
// `retire` is set the source is renamed rather than deleted, both so it runs once and so the
// old values are still there if the merge ever gets it wrong.
function mergeAccountsFrom(file, retire) {
  let legacy;
  try {
    legacy = parseAccounts(fs.readFileSync(file, 'utf8'));
  } catch {
    return; // not present (the normal case from here on)
  }
  const touched = [];
  for (const [n, old] of legacy) {
    const current = accounts.get(n);
    if (!current) {
      accounts.set(n, old);
      touched.push(n);
      continue;
    }
    const merged = Object.assign({}, current);
    let changed = false;
    if (!merged.name && old.name) { merged.name = old.name; changed = true; }
    if (!merged.email && old.email) { merged.email = old.email; changed = true; }
    if ((!merged.chromeProfile || merged.chromeProfile === PROFILE_AUTO)
        && old.chromeProfile && old.chromeProfile !== PROFILE_AUTO) {
      merged.chromeProfile = old.chromeProfile;
      changed = true;
    }
    if (changed) { accounts.set(n, merged); touched.push(n); }
  }
  if (touched.length) persistSlots(touched);
  if (retire) {
    try { fs.renameSync(file, file + '.migrated'); } catch (e) { /* leave it; the merge is idempotent */ }
  }
}

// Write only the slots that actually changed, merging into whatever is on disk right now.
// With several apps sharing one file, serializing this process's whole in-memory copy would
// let a long-running app quietly revert a change another app made after it started.
function persistSlots(slotNumbers) {
  let onDisk = {};
  try {
    onDisk = JSON.parse(fs.readFileSync(accountsFile(), 'utf8')) || {};
  } catch {
    onDisk = {};
  }
  for (const n of slotNumbers) {
    // Belt and braces against the disagreement nextFreeSlot() used to create: a slot the
    // Accounts window cannot render must never reach the shared file, whatever called this.
    // Reading is deliberately NOT bounded (see parseAccounts) — an out-of-range slot already
    // on disk from an older build stays readable rather than being silently destroyed here.
    if (!Number.isInteger(n) || n < 1 || n > ACCOUNT_SLOTS) continue;
    const cfg = accountConfig(n);
    // A slot carrying no information is dropped rather than written as an empty record.
    if (!cfg.name && !cfg.email && (!cfg.chromeProfile || cfg.chromeProfile === PROFILE_AUTO)) {
      delete onDisk[n];
    } else {
      onDisk[n] = {
        name: cfg.name || '',
        chromeProfile: cfg.chromeProfile || PROFILE_AUTO,
        email: cfg.email || '',
      };
    }
  }
  try {
    fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });
    fs.writeFileSync(accountsFile(), JSON.stringify(onDisk, null, 2) + '\n');
  } catch (e) {
    // Same tradeoff as the appearance file: losing the write costs the setting, not the app.
  }
}

// Pick up changes made in one of the other three apps while this one is running, so a name
// set in Gmail shows up in Calendar's Accounts menu without restarting it. Watching the
// directory rather than the file survives the write replacing the inode.
let accountsWatcher = null;
let accountsReloadTimer = null;
function watchAccountsFile() {
  if (accountsWatcher) return;
  try {
    fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });
    accountsWatcher = fs.watch(ACCOUNTS_DIR, (eventType, filename) => {
      if (filename && filename !== 'accounts.json') return;
      // Debounced: a single save can emit several events, and our own writes land here too.
      clearTimeout(accountsReloadTimer);
      accountsReloadTimer = setTimeout(() => {
        loadAccounts();
        refreshAccountPresentation();
      }, 150);
    });
  } catch (e) {
    accountsWatcher = null; // no inotify (or no directory) — changes land at next launch
  }
}

function accountConfig(n) {
  return accounts.get(n) || { name: '', chromeProfile: PROFILE_AUTO, email: '' };
}

// Chrome records every profile — its directory, its display name and the address it is
// signed into — in Local State. That is the whole reason auto-detection can work without
// the user mapping anything by hand. Cached on mtime: it is re-read when Chrome actually
// changes it (profile added/renamed), not on every link click.
const CHROME_STATE_FILES = IS_MAC
  ? [path.join(app.getPath('home'), 'Library/Application Support/Google/Chrome/Local State')]
  : [
    path.join(app.getPath('home'), '.config/google-chrome/Local State'),
    path.join(app.getPath('home'), '.var/app/com.google.Chrome/config/google-chrome/Local State'),
    path.join(app.getPath('home'), '.config/chromium/Local State'),
  ];

let profileCache = { key: null, list: [] };

function chromeProfiles() {
  for (const file of CHROME_STATE_FILES) {
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    const key = file + ':' + stat.mtimeMs;
    if (profileCache.key === key) return profileCache.list;
    try {
      const cache = JSON.parse(fs.readFileSync(file, 'utf8')).profile.info_cache || {};
      const list = Object.entries(cache).map(([dir, info]) => ({
        dir,
        name: (info && info.name) || dir,
        email: (info && info.user_name) || '',
      }));
      // 'Default' is Chrome's first profile and has no number to sort by; keep it first.
      list.sort((a, b) => (a.dir === 'Default' ? -1 : b.dir === 'Default' ? 1 : a.name.localeCompare(b.name)));
      profileCache = { key, list };
      return list;
    } catch {
      continue; // unreadable or unexpected shape — try the next candidate
    }
  }
  return [];
}

function profileByDir(dir) {
  return dir ? chromeProfiles().find((p) => p.dir === dir) || null : null;
}

// The Chrome profile a slot's links should open in, or null for "let Chrome decide".
function profileForSlot(n) {
  const cfg = accountConfig(n);
  if (cfg.chromeProfile === PROFILE_NONE) return null;
  if (cfg.chromeProfile && cfg.chromeProfile !== PROFILE_AUTO) {
    // An explicitly chosen profile that Chrome no longer has would silently send links to a
    // profile Chrome then invents. Fall back to auto rather than routing somewhere wrong.
    const pinned = profileByDir(cfg.chromeProfile);
    if (pinned) return pinned;
  }
  if (!cfg.email) return null;
  const want = cfg.email.toLowerCase();
  return chromeProfiles().find((p) => p.email && p.email.toLowerCase() === want) || null;
}

// Slot label: an explicit name wins, then the mapped Chrome profile's name (which is the
// point of the mapping — the two stay consistent without typing anything), then null,
// meaning "leave the page-derived title alone".
function accountLabel(n) {
  const cfg = accountConfig(n);
  if (cfg.name) return cfg.name;
  const profile = profileForSlot(n);
  return profile ? profile.name : null;
}

function accountMenuLabel(n) {
  return accountLabel(n) || 'Account ' + n;
}

// Which slot a webContents belongs to. The partition is the reliable link: it is set on the
// session before the window exists, and child windows opened from the account switcher
// inherit it, so links clicked in those route to the same Chrome profile as their parent.
function slotOf(wc) {
  try {
    const m = /^persist:account-(\d+)$/.exec((wc.session && wc.session.__partition) || '');
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

// Read the signed-in address out of the account button Google renders on every one of these
// apps. This is what makes auto-detection work, and it is cached in accounts.json so the
// mapping is already known at the next launch, before any page has painted.
const ACCOUNT_EMAIL_JS = `(function(){
  var a=document.querySelector('[aria-label*="Google Account" i]');
  var s=a?(a.getAttribute('aria-label')||''):(document.title||'');
  var m=s.match(/[\\w.+-]+@[\\w.-]+\\.[A-Za-z]{2,}/);
  return m?m[0]:'';
})()`;

function rememberAccountEmail(wc) {
  const n = slotOf(wc);
  if (!n) return;
  wc.executeJavaScript(ACCOUNT_EMAIL_JS, true).then((email) => {
    if (!email || accountConfig(n).email === email) return;
    accounts.set(n, Object.assign(accountConfig(n), { email }));
    persistSlots([n]);
    // A newly detected address can change both the routing and the window title.
    refreshAccountPresentation();
  }).catch(() => { /* page not ready or no account button — try again on the next load */ });
}

// Re-apply names everywhere they show after anything that can change them: the settings
// window saving, or an address being detected for the first time.
function refreshAccountPresentation() {
  for (const [n, win] of windows) {
    if (!win || win.isDestroyed()) continue;
    const label = accountLabel(n);
    if (label) {
      win.setTitle(label);
    } else if (win.webContents && !win.webContents.isDestroyed()) {
      // A name that was cleared hands the title back to the page.
      win.webContents.executeJavaScript(ACCOUNT_TITLE_JS, true)
        .then((l) => { if (!win.isDestroyed() && l) win.setTitle(l); })
        .catch(() => { /* ignore */ });
    }
  }
  changedCb(); // the Accounts menu lists the same names
}

module.exports = {
  ACCOUNT_SLOTS, PROFILE_AUTO, PROFILE_NONE, ACCOUNT_TITLE_JS,
  loadAccounts, watchAccountsFile, accountConfig, persistSlots, accounts,
  chromeProfiles, profileForSlot, accountLabel, accountMenuLabel, slotOf,
  rememberAccountEmail, refreshAccountPresentation, onChanged,
};
