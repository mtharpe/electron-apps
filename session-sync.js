// Sign in once per Google account, not once per app.
//
// Every app here keeps its own isolated cookie jar per account slot, which is what makes
// multi-account work — but it also means a fresh app, or a fresh slot, starts signed out
// even though the same person is already signed into that exact Google account in a sibling
// app. With five Google apps and three accounts that is fifteen logins, each with 2FA.
//
// This shares ONE thing between the apps: an established Google web session. When a slot is
// signed in, its Google session cookies are published to a small encrypted store keyed by
// the signed-in email; when a slot opens signed out, it adopts the session for the email
// that slot is meant to be. Sign in once, and the other apps for that account come up
// already authenticated.
//
// What it is NOT: it does not create sessions, bypass 2FA, or read anything outside these
// apps. It moves an already-authenticated session between the user's own apps on the user's
// own machine, and only the Google auth cookies, nothing else.
//
// Security model:
//   - Keyed by account IDENTITY (sha256 of the email), never by slot number, so a slot
//     accidentally signed into the wrong account cannot log a matching slot elsewhere out
//     of the right one — an adopt only ever applies a session for the email it belongs to.
//   - Encrypted at rest with AES-256-GCM. The key is 32 random bytes kept in the OS keyring
//     (libsecret on Linux, via secret-tool or its Python bindings; KWallet; macOS Keychain),
//     NOT in a file next to the ciphertext, and NOT via Electron safeStorage, whose key is
//     scoped per app name and so cannot be shared across these separate apps (measured).
//   - Fail closed: if the keyring is unavailable the feature disables itself and nothing is
//     ever written in the clear.

const { app, session } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');

// --- keyring ---------------------------------------------------------------------------

// One fixed identity for the shared key, so every app looks up the same secret whatever
// backend holds it.
const KEY_ATTRS = ['application', 'electron-apps', 'key', 'session-sync']; // libsecret
const KEY_LABEL = 'electron-apps session sync key';
const KW_FOLDER = 'electron-apps';           // kwallet
const KW_ENTRY = 'session-sync';
const KC_SERVICE = 'electron-apps';          // macOS keychain
const KC_ACCOUNT = 'session-sync';

// Run a keyring CLI. Reports `missing` (the binary is not installed) distinctly from a plain
// non-zero exit (present, but the key is absent or the store is locked), because the first
// means "try the next backend" and the second can mean "this backend just has no key yet".
function runTool(cmd, args, input) {
  return new Promise((resolve) => {
    let child;
    try {
      child = execFile(cmd, args, { encoding: 'utf8' }, (err, stdout) => {
        resolve({ missing: !!(err && err.code === 'ENOENT'), failed: !!err, stdout: stdout || '' });
      });
    } catch (e) {
      resolve({ missing: true, failed: true, stdout: '' });
      return;
    }
    if (input != null) { try { child.stdin.end(input); } catch (e) {} }
  });
}

// secret-tool's lookup/store, in Python over libsecret's GObject bindings. Exit 1 on "no such
// item", like secret-tool; a missing gi or typelib fails the same way, and getKey's round-trip
// then passes this backend over. The secret goes in on stdin, never argv, so it is not in `ps`.
const LIBSECRET_PY = [
  'import sys',
  'import gi',
  "gi.require_version('Secret', '1')",
  'from gi.repository import Secret',
  'mode, label, rest = sys.argv[1], sys.argv[2], sys.argv[3:]',
  'attrs = dict(zip(rest[0::2], rest[1::2]))',
  "schema = Secret.Schema.new('org.freedesktop.Secret.Generic', Secret.SchemaFlags.DONT_MATCH_NAME,",
  '                           {k: Secret.SchemaAttributeType.STRING for k in attrs})',
  "if mode == 'lookup':",
  '    value = Secret.password_lookup_sync(schema, attrs, None)',
  '    if value is None:',
  '        sys.exit(1)',
  '    sys.stdout.write(value)',
  'elif not Secret.password_store_sync(schema, attrs, Secret.COLLECTION_DEFAULT, label, sys.stdin.read(), None):',
  '    sys.exit(1)',
].join('\n');

// The keyring backends we know how to talk to, in preference order. Each is just a lookup
// and a store over a CLI that ships with its platform; we never assume one is present or
// working — init() proves it with a real round-trip before enabling anything.
const KEYRING_BACKENDS = [
  {
    name: 'libsecret',
    lookup: () => runTool('secret-tool', ['lookup', ...KEY_ATTRS]),
    store: (b64) => runTool('secret-tool', ['store', '--label=' + KEY_LABEL, ...KEY_ATTRS], b64),
  },
  {
    // The same libsecret, reached through its Python bindings rather than secret-tool. An
    // immutable host can have the keyring daemon and the library but not the CLI: measured on
    // Vanilla OS (GNOME), gnome-keyring was running and python3 could load gi's Secret, but
    // secret-tool was absent — so single sign-on was off on a machine fully able to do it.
    // Same attributes, and DONT_MATCH_NAME so either path finds the item the other wrote.
    name: 'libsecret-python',
    lookup: () => runTool('python3', ['-I', '-c', LIBSECRET_PY, 'lookup', KEY_LABEL, ...KEY_ATTRS]),
    store: (b64) => runTool('python3', ['-I', '-c', LIBSECRET_PY, 'store', KEY_LABEL, ...KEY_ATTRS], b64),
  },
  {
    name: 'kwallet',
    lookup: () => runTool('kwallet-query', ['-f', KW_FOLDER, '-r', KW_ENTRY, 'kdewallet']),
    store: (b64) => runTool('kwallet-query', ['-f', KW_FOLDER, '-w', KW_ENTRY, 'kdewallet'], b64),
  },
  {
    name: 'keychain', // macOS
    lookup: () => runTool('security', ['find-generic-password', '-s', KC_SERVICE, '-a', KC_ACCOUNT, '-w']),
    store: (b64) => runTool('security', ['add-generic-password', '-U', '-s', KC_SERVICE, '-a', KC_ACCOUNT, '-w', b64]),
  },
];

const parseKey = (s) => {
  try { const k = Buffer.from(String(s || '').trim(), 'base64'); return k.length === 32 ? k : null; }
  catch (e) { return null; }
};

// Which backend ended up holding the key, for the startup log.
let keyBackendName = null;

// The shared key, or null if no backend on THIS machine can hold one — in which case the
// feature stays off. We do not decide by platform or by probing for a binary; we find out by
// using it. First, adopt a key any backend already holds. Otherwise create one and confirm
// it reads back: a backend whose binary is absent, whose store is locked, or that silently
// drops the write fails that round-trip and is passed over.
//
// Creation is serialised across the apps by a lock file. The read-back alone was meant to
// settle two apps creating a key at once, and does not: each stores its own key and reads
// back the keyring BEFORE the other's store lands, so each keeps a different key and the
// keyring keeps only the last. Measured with six apps started together on a machine with
// no key yet: all six logged "ready", and the published session file then failed to
// decrypt with the keyring's key — every app was encrypting for itself alone.
async function adoptExistingKey() {
  for (const be of KEYRING_BACKENDS) {
    const r = await be.lookup();
    if (r.missing) continue;
    const key = parseKey(r.stdout);
    if (key) { keyBackendName = be.name; return key; }
  }
  return null;
}

const KEY_LOCK_WAIT_MS = 20000;
// Store plus read-back takes well under a second. A lock older than this was left by an app
// that died holding it, and waiting on it would only delay the next one for nothing.
const KEY_LOCK_STALE_MS = 30000;

// Resolves to a release function. If the lock cannot be had in time, proceed without it:
// a rare race beats a feature that never starts.
async function takeKeyLock() {
  if (!ctx) return () => {};
  const lock = path.join(ctx.storeDir, '.key-create.lock');
  try { fs.mkdirSync(ctx.storeDir, { recursive: true, mode: 0o700 }); } catch (e) { /* surfaces below */ }
  const deadline = Date.now() + KEY_LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      fs.closeSync(fs.openSync(lock, 'wx')); // atomic: exactly one creator wins
      return () => { try { fs.unlinkSync(lock); } catch (e) { /* already gone */ } };
    } catch (e) {
      if (e.code !== 'EEXIST') return () => {};
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > KEY_LOCK_STALE_MS) fs.unlinkSync(lock);
      } catch (e2) { /* released between the two calls — just retry */ }
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  return () => {};
}

let keyPromise = null;
function getKey() {
  if (keyPromise) return keyPromise;
  keyPromise = (async () => {
    const existing = await adoptExistingKey();
    if (existing) return existing;
    const release = await takeKeyLock();
    try {
      // Whoever held the lock before us may have just created it.
      const created = await adoptExistingKey();
      if (created) return created;
      return await createKey();
    } finally {
      release();
    }
  })().catch(() => null);
  return keyPromise;
}

async function createKey() {
  for (const be of KEYRING_BACKENDS) {
    const probe = await be.lookup();
    if (probe.missing) continue; // backend binary not installed
    const fresh = crypto.randomBytes(32).toString('base64');
    const stored = await be.store(fresh);
    if (stored.missing || stored.failed) continue;
    const back = await be.lookup();
    const key = parseKey(back.stdout); // any valid 32-byte value proves the backend works
    if (key) { keyBackendName = be.name; return key; }
  }
  return null;
}

// --- crypto ----------------------------------------------------------------------------

// [ iv(12) | authTag(16) | ciphertext ], AES-256-GCM. The auth tag makes a tampered or
// truncated file fail to decrypt rather than yield garbage cookies.
function encrypt(key, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

function decrypt(key, blob) {
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const ct = blob.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

// --- cookie scope ----------------------------------------------------------------------

// Only an established Google web session is shared. These are the cookies that carry it;
// everything else in the jar (per-app preferences, non-Google hosts) stays put.
const AUTH_SUFFIX = 'google.com';
const isAuthCookieHost = (d) => {
  const h = String(d || '').replace(/^\./, '').toLowerCase();
  return h === AUTH_SUFFIX || h.endsWith('.' + AUTH_SUFFIX);
};

// The cookies whose presence means "signed in" — used both to decide there is a session
// worth publishing and to hash one session so we can tell two apart.
const SESSION_NAMES = new Set([
  'SID', 'SSID', 'HSID', 'APISID', 'SAPISID', 'LSID',
  '__Secure-1PSID', '__Secure-3PSID', '__Secure-1PAPISID', '__Secure-3PAPISID',
  '__Host-1PLSID', '__Host-3PLSID', '__Host-GAPS',
]);

function cookieUrl(c) {
  const host = String(c.domain || '').replace(/^\./, '');
  return (c.secure ? 'https://' : 'http://') + host + (c.path || '/');
}

// Which of those mean an account is actually signed in. The rest can exist without one:
// accounts.google.com sets __Host-GAPS on a visitor who has not signed in yet. Counting it as
// a session made a signed-out window look signed in, so it never adopted the real session —
// and then published its lone GAPS cookie over the real one. Measured: Tasks published a new
// account (25 cookies), and 7s later Gmail's fresh window for the same account replaced it
// with a 1-cookie "session", __Host-GAPS@accounts.google.com, so single sign-on never
// happened. Every real session in the store carries SID and __Secure-1PSID.
const SIGNED_IN_NAMES = new Set(['SID', '__Secure-1PSID', '__Secure-3PSID']);

// A stable fingerprint of the session cookies, so a process can tell whether a store already
// reflects what it holds — the guard that stops publish/adopt from ping-ponging between
// apps. Only the identifying session cookies count, so incidental churn does not thrash it.
// null when the cookies are not a signed-in session — which is what keeps a signed-out jar
// from being published, from counting as "already has a session", and from being adopted.
function sessionHash(cookies) {
  if (!cookies.some((c) => SIGNED_IN_NAMES.has(c.name))) return null;
  const parts = cookies
    .filter((c) => SESSION_NAMES.has(c.name))
    .map((c) => c.name + '=' + c.value)
    .sort();
  if (!parts.length) return null;
  return crypto.createHash('sha256').update(parts.join('\n')).digest('hex');
}

// --- store -----------------------------------------------------------------------------

let ctx = null;         // { storeDir, emailForSlot, windowsForSlot, log }
let enabled = false;
const emailHashHex = (email) => crypto.createHash('sha256').update(email.toLowerCase()).digest('hex');
const storeFile = (email) => path.join(ctx.storeDir, emailHashHex(email) + '.enc');

// email -> hash of the session this process last wrote or adopted. Breaks the loop: a
// process never republishes, nor re-adopts, a session it already reflects.
const syncedHash = new Map();

function log(msg) { try { ctx.log('[session-sync] ' + msg); } catch (e) {} }

// All auth cookies in a jar. Deliberately get({}) then filter, NOT get({domain}): the domain
// query returns only cookies scoped to google.com itself and misses the host-only auth
// cookies set on subdomains (accounts./mail.google.com) — which are exactly the ones a
// session needs. Measured: the domain query yields 17 where the full sweep yields 43, and a
// 17-cookie graft does NOT produce a signed-in session.
async function authCookies(ses) {
  return (await ses.cookies.get({})).filter((c) => isAuthCookieHost(c.domain));
}

async function hasSession(ses) {
  return !!sessionHash(await authCookies(ses));
}

// Publish the slot's current Google session, if it has one and it differs from what the
// store already holds. Never publishes an empty session — a signed-out app must not wipe the
// shared login for everyone else.
async function publish(slot) {
  if (!enabled) return;
  const email = ctx.emailForSlot(slot);
  if (!email) return; // identity unknown → nothing to key on yet
  const ses = session.fromPartition('persist:account-' + slot);

  const cookies = await authCookies(ses);
  const hash = sessionHash(cookies);
  if (!hash) return;                       // signed out; leave the store alone
  if (syncedHash.get(email) === hash) return;

  const key = await getKey();
  if (!key) return;

  // Skip a redundant write if another app already published this exact session.
  try {
    const existing = fs.readFileSync(storeFile(email));
    const prior = JSON.parse(decrypt(key, existing));
    if (sessionHash(prior.cookies || []) === hash) { syncedHash.set(email, hash); return; }
  } catch (e) { /* no readable prior file; fall through and write */ }

  const payload = JSON.stringify({
    v: 1,
    email,
    updatedAt: Date.now(),
    cookies: cookies.map((c) => ({
      name: c.name, value: c.value, domain: c.domain, path: c.path,
      secure: c.secure, httpOnly: c.httpOnly,
      expirationDate: c.expirationDate, sameSite: c.sameSite,
    })),
  });

  try {
    fs.mkdirSync(ctx.storeDir, { recursive: true, mode: 0o700 });
    // Unique per write (pid + random), so two publishes for the same email — even
    // concurrently in one process — never share a temp path and clobber each other's bytes
    // before the atomic rename.
    const tmp = storeFile(email) + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
    fs.writeFileSync(tmp, encrypt(key, payload), { mode: 0o600 });
    fs.renameSync(tmp, storeFile(email)); // atomic: a reader never sees a half-written file
    syncedHash.set(email, hash);
    log('published session for ' + email + ' (' + cookies.length + ' cookies)');
  } catch (e) {
    log('publish failed: ' + (e && e.message));
  }
}

// Read the stored session for `email`, if any and decryptable. A file that fails to decrypt
// (wrong key after a keyring reset, tampering, truncation) is treated as absent, never fatal.
async function readStored(email) {
  const key = await getKey();
  if (!key) return null;
  let blob;
  try { blob = fs.readFileSync(storeFile(email)); } catch (e) { return null; }
  try {
    const data = JSON.parse(decrypt(key, blob));
    if (!data || data.email !== email || !Array.isArray(data.cookies)) return null;
    // A file an older build wrote from a signed-out window (see SIGNED_IN_NAMES) is not a
    // session; treat it as absent so the next real publish replaces it.
    if (!sessionHash(data.cookies)) return null;
    return data;
  } catch (e) {
    log('stored session for ' + email + ' could not be decrypted — ignoring');
    return null;
  }
}

// Inject a stored session's cookies into a slot's jar. Honours the __Host-/__Secure- prefix
// rules: a host-only cookie (its stored domain has no leading dot) must be set from the url
// with no domain attribute, or Chromium rejects it.
async function injectInto(ses, cookies) {
  let ok = 0;
  for (const c of cookies) {
    const hostOnly = !String(c.domain || '').startsWith('.');
    const args = {
      url: cookieUrl(c), name: c.name, value: c.value, path: c.path,
      secure: c.secure, httpOnly: c.httpOnly,
      expirationDate: c.expirationDate, sameSite: c.sameSite,
    };
    if (!hostOnly) args.domain = c.domain;
    try { await ses.cookies.set(args); ok++; } catch (e) { /* skip the odd unsettable one */ }
  }
  return ok;
}

// The Google sign-in host. An app only ever adopts a shared Google session when it actually
// navigates here — which scopes the whole thing to apps that use Google to log in, and
// nothing else. The Google apps land here when signed out; Tidal lands here during its
// "continue with Google" OAuth; Messenger (Meta auth) and any future non-Google app never
// do, so a copy of the Google session is never injected into a jar that can't use it.
const AUTH_LOGIN_HOST = 'accounts.google.com';
function isGoogleAuthUrl(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === AUTH_LOGIN_HOST || h.endsWith('.' + AUTH_LOGIN_HOST);
  } catch (e) { return false; }
}

// slot -> hash of the session we last injected for it, so a stale/expired session that keeps
// bouncing back to the login page is tried once, not in a reload loop.
const attemptedHash = new Map();

// The window for `slot` has navigated to the Google sign-in page. If the slot is signed out
// and a session exists for the email it is meant to be, inject it and reload the CURRENT
// page. Reloading accounts.google.com itself (not the app URL) is deliberate and works for
// both shapes: a plain login redirects onward to its `continue=` target, and an OAuth
// authorize request auto-approves and redirects to its `redirect_uri` — so Gmail lands in the
// inbox and Tidal's Google OAuth completes, with the same code and no app-specific handling.
// Slots with an adoption in progress. One sign-in is now seen twice — the navigation's start
// and its redirect — and attemptedHash is only set after two awaits, so without this both
// could pass the checks and inject.
const adopting = new Set();

async function adoptForAuth(slot, wc) {
  if (!enabled || wc.isDestroyed() || adopting.has(slot)) return;
  adopting.add(slot);
  try {
    const email = ctx.emailForSlot(slot);
    if (!email) return;
    const ses = session.fromPartition('persist:account-' + slot);
    if (await hasSession(ses)) return; // already have a Google session; nothing to do

    const data = await readStored(email);
    if (!data) return;
    const hash = sessionHash(data.cookies);
    if (attemptedHash.get(slot) === hash) return; // already tried this exact session — no loop
    attemptedHash.set(slot, hash);

    const ok = await injectInto(ses, data.cookies);
    if (ok && !wc.isDestroyed()) {
      syncedHash.set(email, hash);
      log('adopted session for ' + email + ' into slot ' + slot + ' (' + ok + ' cookies) at Google sign-in');
      wc.reload();
    }
  } finally {
    adopting.delete(slot);
  }
}

// Watch a slot's window: adopt when, and only when, its main frame reaches Google sign-in.
//
// The redirect has to be watched as well as the start. A signed-out Gmail starts its navigation
// at mail.google.com and the SERVER redirects it to accounts.google.com within that same
// navigation — measured: one history entry, at the sign-in URL, recorded as the original
// load. A redirect fires did-redirect-navigation, never did-start-navigation, so watching only
// the start meant a signed-out Gmail never adopted, with a valid session sitting in the store.
function watchAuthNavigation(slot, wc) {
  const check = (url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace && isGoogleAuthUrl(url)) adoptForAuth(slot, wc);
  };
  wc.on('did-start-navigation', (e, url, isInPlace, isMainFrame) => check(url, isInPlace, isMainFrame));
  wc.on('did-redirect-navigation', (e, url, isInPlace, isMainFrame) => check(url, isInPlace, isMainFrame));
}

// A sibling app just published (the store changed). Only windows that are themselves sitting
// at Google sign-in are touched — same scoping as adoptForAuth: the injection happens for a
// window that is actively trying to Google-authenticate, never pre-emptively into a jar that
// is on its own app or on a non-Google login. A window already showing app content is left
// alone; we do not yank a session change out from under someone mid-task.
let watchTimer = null;
function onStoreChanged() {
  if (watchTimer) return;                  // coalesce the burst of events a write produces
  watchTimer = setTimeout(async () => {
    watchTimer = null;
    if (!enabled) return;
    for (const slot of activeSlots()) {
      const email = ctx.emailForSlot(slot);
      if (!email) continue;
      const wins = ctx.windowsForSlot(slot)
        .filter((w) => w && !w.isDestroyed() && isGoogleAuthUrl(w.webContents.getURL()));
      if (!wins.length) continue;                      // no window here is at Google sign-in
      const ses = session.fromPartition('persist:account-' + slot);
      if (await hasSession(ses)) continue;             // already signed in
      const data = await readStored(email);
      if (!data) continue;
      const hash = sessionHash(data.cookies);
      if (syncedHash.get(email) === hash) continue;    // already have this one
      const injected = await injectInto(ses, data.cookies);
      if (!injected) continue;
      syncedHash.set(email, hash);
      attemptedHash.set(slot, hash);
      for (const w of wins) w.webContents.reload();
      log('propagated session for ' + email + ' to slot ' + slot);
    }
  }, 800);
}

function activeSlots() {
  const slots = [];
  for (let n = 1; n <= 50; n++) if (ctx.windowsForSlot(n).some((w) => w && !w.isDestroyed())) slots.push(n);
  return slots;
}

// --- wiring ----------------------------------------------------------------------------

// Attach once per slot session: publish whenever its Google cookies change (an interactive
// login, or Google rotating the session), debounced so a burst of cookie writes is one
// publish. Idempotent per session object.
const attached = new WeakSet();
function attachSlot(slot) {
  const ses = session.fromPartition('persist:account-' + slot);
  if (attached.has(ses)) return;
  attached.add(ses);
  let t = null;
  ses.cookies.on('changed', (_e, cookie) => {
    if (!enabled || !isAuthCookieHost(cookie.domain) || !SESSION_NAMES.has(cookie.name)) return;
    if (t) clearTimeout(t);
    t = setTimeout(() => { t = null; publish(slot); }, 4000);
  });
}

// storeDir is watched (not individual files) so newly-created identity files are seen too.
function startWatching() {
  try {
    fs.mkdirSync(ctx.storeDir, { recursive: true, mode: 0o700 });
    fs.watch(ctx.storeDir, () => onStoreChanged());
  } catch (e) {
    log('cannot watch store dir: ' + (e && e.message));
  }
}

// Called from main once, after app.setName (so appData/userData paths are settled). The
// keyring probe decides whether the feature runs at all.
async function init(context) {
  ctx = context;
  const key = await getKey();
  enabled = !!key;
  if (!enabled) {
    // No working keyring on this machine — the honest outcome of "we can't know the
    // capabilities": the feature turns itself off rather than storing a session in the clear.
    log('no working keyring backend (tried ' + KEYRING_BACKENDS.map((b) => b.name).join(', ') +
      ') — single sign-on across apps is off; each app signs in on its own');
    return;
  }
  startWatching();
  log('ready (keyring: ' + keyBackendName + ')');
  app.whenReady().then(publishKnownSlots).catch(() => {});
}

// Publish every account this app holds a session for, at startup, whether or not its window
// is open. Publishing used to happen only when a slot's window loaded or its cookies changed,
// so a session reached the other apps only while that app had the account's window open —
// and the apps reopen only Account 1 at launch. Measured: Account 3 was signed in in Tasks
// (SID present in its jar), but after a restart Tasks never opened that window, never
// published, and Gmail's Account 3 sat at sign-in with nothing to adopt. Only slots with a
// known email are touched: those are the ones that have been signed into, so this never
// conjures a partition for an unused slot.
async function publishKnownSlots() {
  for (let n = 1; n <= 50; n++) {
    if (!ctx.emailForSlot(n)) continue;
    attachSlot(n); // and keep publishing it as Google rotates the session
    await publish(n);
  }
}

module.exports = { init, attachSlot, watchAuthNavigation, publish };
