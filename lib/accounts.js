// Account slots: the name, the Chrome profile and the detected address behind each one.
// This is the data layer -- it owns accounts.json and Chrome's profile list, and knows
// nothing about how windows or menus present any of it.
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');
const { cfg, IS_MAC, ACCOUNTS_DIR } = require('./config');
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
// How many of those this app may open windows for. ACCOUNT_SLOTS stays the bound on the
// SHARED file — Messages showing one slot must not stop Gmail's six from being saved.
const WINDOW_SLOTS = cfg.single ? 1 : ACCOUNT_SLOTS;

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

// Only the canonical spelling is accepted: without this `Number(k)` also takes "01", "1e0"
// and " 1", all of which map to slot 1 and would let one slot appear under several keys.
// Deliberately NOT bounded above — see writeSlots: an out-of-range slot written by an older
// build stays readable rather than being silently dropped.
const SLOT_KEY = /^[1-9][0-9]*$/;
// Matches the cap accounts:save applies, so a name read back from disk can never be longer
// than one the UI could have written.
const NAME_MAX = 64;

function parseAccounts(text) {
  const out = new Map();
  const raw = JSON.parse(text);
  for (const [k, v] of Object.entries(raw)) {
    if (!SLOT_KEY.test(k)) continue;
    const n = Number(k);
    // A canonical key can still be longer than a safe integer; such a key has no meaning
    // here and would only produce a Map entry nothing can address.
    if (!Number.isSafeInteger(n)) continue;
    if (!v || typeof v !== 'object') continue;
    out.set(n, {
      name: typeof v.name === 'string' ? v.name.trim().slice(0, NAME_MAX) : '',
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

// Fold older locations into the current shared file exactly once. Deliberately a merge
// rather than a "shared file missing? adopt mine": the apps start in any order, and the
// first of them to detect an address creates the shared file — so a plain existence check
// would let whichever app happened to start first discard names set in another.
//
// One-shot via a marker file. This used to run on every read, including the watcher's
// reload, which meant a name the user had cleared came straight back the next time the
// shared file changed, and a legacy slot that normalises to empty was re-added and dropped
// forever.
function legacyMigrationMarker() {
  return path.join(ACCOUNTS_DIR, '.legacy-accounts-migrated');
}

function migrateLegacyAccounts() {
  try { if (fs.existsSync(legacyMigrationMarker())) return; } catch { /* assume not migrated */ }
  // Newest scheme first, so a gap is filled from the most recent source that has a value.
  // The old SHARED file is never renamed away. Apps are installed individually, so
  // rebuilding just one of them must not strand the others — anything still running the old
  // build keeps reading that file. The marker is what stops it being consulted again.
  const sharedDone = mergeAccountsFrom(legacySharedAccountsFile(), false);
  // This app's pre-sharing copy, which only it can own — safe to retire once merged.
  const ownDone = mergeAccountsFrom(legacyAccountsFile(), true);
  // Only claim completion if both sources were actually folded into the shared file. A
  // skipped write (lock contention) must not mark the migration done and lose them.
  if (!sharedDone || !ownDone) return;
  try {
    fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });
    fs.writeFileSync(legacyMigrationMarker(), new Date().toISOString() + '\n');
  } catch {
    // Retry on the next launch: the merge only adds slots that are entirely absent, so
    // running it twice cannot resurrect anything the user has since cleared.
  }
}

// Add legacy slots that are completely absent; the current file always wins. When `retire`
// is set the source is renamed rather than deleted, both so it runs once and so the old
// values are still there if the merge ever gets it wrong.
function mergeAccountsFrom(file, retire) {
  let legacy;
  try {
    legacy = parseAccounts(fs.readFileSync(file, 'utf8'));
  } catch {
    return true; // not present (the normal case from here on) — nothing to fold in
  }
  const touched = [];
  for (const [n, old] of legacy) {
    // Never fill fields on a slot that already exists. Gap-filling was what resurrected
    // values the user had deliberately cleared: the current file is newer, by definition,
    // than a file this app has finished retiring.
    if (accounts.has(n)) continue;
    // writeSlots() drops a record carrying no information on purpose, so adding one here
    // would only make it disappear again on the next read. Skipping is the lower-risk fix:
    // preserving empty records would put junk in the shared file every app reads.
    if (!old.name && !old.email && (!old.chromeProfile || old.chromeProfile === PROFILE_AUTO)) continue;
    accounts.set(n, old);
    touched.push(n);
  }
  const persisted = touched.length ? persistSlots(touched) : true;
  // Retiring the source when the write was skipped would strand the only copy of those
  // values in this process's memory. Leave it for the next launch instead.
  if (retire && persisted) {
    try { fs.renameSync(file, file + '.migrated'); } catch (e) { /* leave it; the merge is idempotent */ }
  }
  return persisted;
}

// Write only the slots that actually changed, merging into whatever is on disk right now.
// With several apps sharing one file, serializing this process's whole in-memory copy would
// let a long-running app quietly revert a change another app made after it started.
// Returns whether the write actually landed. Callers that discard a source file (the legacy
// migration) must not do so on a skipped write.
function persistSlots(slotNumbers) {
  return withAccountsLock(() => writeSlots(slotNumbers));
}

// The whole read-merge-write runs under the lock: re-reading narrows the window in which a
// sibling's write can be lost, but only exclusion closes it, and every installed app is a
// separate process writing this one file.
function writeSlots(slotNumbers) {
  let onDisk;
  try {
    onDisk = JSON.parse(fs.readFileSync(accountsFile(), 'utf8'));
    if (!onDisk || typeof onDisk !== 'object' || Array.isArray(onDisk)) throw new Error('not an object');
  } catch (e) {
    // Distinguish "the file is broken" from "the file is unavailable right now". Only a
    // parse or shape error is corruption worth recovering from. EACCES/EBUSY/EPERM and
    // friends mean the file may be perfectly good: quarantining it or writing over it for a
    // transient condition could erase every other slot, for every app, so skip entirely.
    if (e.code && e.code !== 'ENOENT') return false;
    // Missing is the first run. Unreadable must NOT be treated the same way: merging the
    // touched slots into {} and writing that back would erase every other slot, for every
    // app. The in-memory map is the last good read, so rebuild from it, and keep the bad
    // file aside rather than destroying the evidence.
    onDisk = {};
    if (e.code !== 'ENOENT') {
      try { fs.renameSync(accountsFile(), accountsFile() + '.corrupt-' + Date.now()); } catch { /* gone already */ }
      for (const [n, cfg] of accounts) onDisk[n] = cfg;
    }
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
  // Temp file + rename, as session-sync does: a crash mid-write, or a sibling reading while
  // this one writes, must never see a truncated file — that is what the branch above has
  // to recover from.
  const tmp = accountsFile() + '.' + process.pid + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(onDisk, null, 2) + '\n');
    fs.renameSync(tmp, accountsFile());
  } catch (e) {
    // Same tradeoff as the appearance file: losing the write costs the setting, not the app.
    try { fs.unlinkSync(tmp); } catch { /* never created */ }
    return false;
  }
  return true;
}

// A lock file created with O_EXCL. Held for a single synchronous read-merge-write, so a
// wait longer than that means its owner died holding it: break it rather than leave every
// app unable to save. The wait is deliberately short because this runs on the main thread:
// past it the write is SKIPPED, not taken unlocked. The value is already in the in-memory
// map, so it goes out with the next save; blocking the UI for longer to win the lock is the
// worse trade.
const LOCK_WAIT_MS = 50;
const LOCK_STALE_MS = 5000;

// Break a lock only if the same inode is still there immediately before the break. The
// stat->unlink race is real: between seeing a stale lock and unlinking it, the owner can
// release it and a sibling can take a fresh one — unlinking that would let two processes
// write at once. Re-stat and abort if inode or ctime changed. Renaming (rather than
// unlinking) makes the break atomic: of two processes breaking at once, one rename wins.
function breakStaleLock(lock) {
  let first;
  try { first = fs.statSync(lock); } catch (e) { return e.code === 'ENOENT'; }
  if (Date.now() - first.mtimeMs <= LOCK_STALE_MS) return false;
  let again;
  try { again = fs.statSync(lock); } catch { return false; }
  if (again.ino !== first.ino || again.ctimeMs !== first.ctimeMs) return false;
  const parked = lock + '.stale-' + process.pid;
  try { fs.renameSync(lock, parked); } catch { return false; }
  try { fs.unlinkSync(parked); } catch { /* left behind only if this process died here */ }
  return true;
}

function withAccountsLock(fn) {
  const lock = accountsFile() + '.lock';
  try { fs.mkdirSync(ACCOUNTS_DIR, { recursive: true }); } catch { /* the write reports it */ }
  const deadline = Date.now() + LOCK_WAIT_MS;
  let fd = null;
  for (;;) {
    try {
      fd = fs.openSync(lock, 'wx');
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') break; // can't lock here at all; skip the write below
      if (breakStaleLock(lock)) continue;
      if (Date.now() >= deadline) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  if (fd === null) {
    // Another process holds the lock past the short wait, or the lock path is unwritable.
    // Never write unlocked: that is the race the lock exists to prevent. The caller's value
    // stays in `accounts` and a later save carries it.
    return false;
  }
  try {
    return fn();
  } finally {
    try { fs.closeSync(fd); } catch { /* nothing to do */ }
    try { fs.unlinkSync(lock); } catch { /* nothing to do */ }
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
        // Local State is not ours to trust for shape: a non-string would flow into the
        // Accounts menu and the window title, so coerce instead of passing it through.
        name: info && typeof info.name === 'string' && info.name ? info.name : dir,
        email: info && typeof info.user_name === 'string' ? info.user_name : '',
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
  ACCOUNT_SLOTS, WINDOW_SLOTS, PROFILE_AUTO, PROFILE_NONE, ACCOUNT_TITLE_JS,
  loadAccounts, watchAccountsFile, accountConfig, persistSlots, accounts,
  chromeProfiles, profileForSlot, accountLabel, accountMenuLabel, slotOf,
  rememberAccountEmail, refreshAccountPresentation, onChanged,
};
