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
// The slot bounds live in the account model: a single-account app owns only slot 1, and
// scanning past that would touch partitions the app can never open.
const { WINDOW_SLOTS, ACCOUNT_SLOTS } = require('./lib/accounts');

// --- keyring ---------------------------------------------------------------------------

// One fixed identity for the shared key, so every app looks up the same secret whatever
// backend holds it.
const KEY_ATTRS = ['application', 'electron-apps', 'key', 'session-sync']; // libsecret
const KEY_LABEL = 'electron-apps session sync key';
const KW_FOLDER = 'electron-apps';           // kwallet
const KW_ENTRY = 'session-sync';
const KC_SERVICE = 'electron-apps';          // macOS keychain
const KC_ACCOUNT = 'session-sync';

// A keyring CLI that never returns would hang the probe forever, so a timed-out call is
// treated as a failed backend and getKey moves on to the next one.
const KEYRING_TIMEOUT_MS = 10000;

// Run a keyring CLI. Reports `missing` (the binary is not installed) distinctly from a plain
// non-zero exit (present, but the key is absent or the store is locked), because the first
// means "try the next backend" and the second can mean "this backend just has no key yet".
function runTool(cmd, args, input) {
  return new Promise((resolve) => {
    let child;
    try {
      child = execFile(cmd, args, { encoding: 'utf8', timeout: KEYRING_TIMEOUT_MS }, (err, stdout) => {
        resolve({ missing: !!(err && err.code === 'ENOENT'), failed: !!err, stdout: stdout || '' });
      });
    } catch (e) {
      resolve({ missing: true, failed: true, stdout: '' });
      return;
    }
    if (input != null) {
      // The child can exit (or be killed on timeout) before it reads stdin. Without a
      // listener that EPIPE is an unhandled 'error' event on the stream and kills the app.
      child.stdin.on('error', () => {});
      try { child.stdin.end(input); } catch (e) { /* reported through the callback */ }
    }
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

// Store plus read-back takes well under a second, so a lock older than this was left by an
// app that died holding it. The waiter's deadline must outlast the stale window comfortably:
// with wait < stale it can never reach the point where it is allowed to break a dead lock,
// and it just gives up while the stale file still sits there.
const KEY_LOCK_STALE_MS = 15000;
const KEY_LOCK_WAIT_MS = 45000;

// Resolves to a release function, or null if the lock could not be had in time. On timeout
// the caller re-checks for a key instead of creating one unlocked: two creators writing
// different keys is exactly the race this lock exists to prevent.
async function takeKeyLock() {
  if (!ctx) return null;
  const lock = path.join(ctx.storeDir, '.key-create.lock');
  try { fs.mkdirSync(ctx.storeDir, { recursive: true, mode: 0o700 }); } catch (e) { /* surfaces below */ }
  // The owner token goes into the file itself, so release only removes OUR lock. If this
  // process stalls past the stale window, another app may have broken the lock and created
  // its own; unlinking that on the way out would let a third creator in.
  const token = process.pid + ':' + crypto.randomBytes(8).toString('hex');
  const deadline = Date.now() + KEY_LOCK_WAIT_MS;
  let held = false;
  while (Date.now() < deadline) {
    try {
      fs.writeFileSync(lock, token, { flag: 'wx', mode: 0o600 }); // atomic: exactly one creator wins
      held = true;
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') break; // cannot lock here at all; the caller handles null
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > KEY_LOCK_STALE_MS) fs.unlinkSync(lock);
      } catch (e2) { /* released between the two calls — just retry */ }
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  if (!held) return null;
  return () => {
    try {
      if (fs.readFileSync(lock, 'utf8') === token) fs.unlinkSync(lock);
    } catch (e) { /* already gone */ }
  };
}

let keyPromise = null;
function getKey() {
  if (keyPromise) return keyPromise;
  keyPromise = (async () => {
    const existing = await adoptExistingKey();
    if (existing) return existing;
    const release = await takeKeyLock();
    if (!release) {
      // Someone else is creating the key, or left a lock that could not be cleared in time.
      // Re-check for their key rather than creating one unlocked — a second key written
      // beside the first is what makes the published files undecryptable by everyone else.
      return await adoptExistingKey();
    }
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

// The cookies that make up the session fingerprint (and, when one changes, prompt a
// publish). __Host-GAPS is deliberately NOT here: accounts.google.com sets it on a visitor
// who has not signed in, and folding its value into the hash made the publish/adopt guard
// churn on a cookie that carries no identity. It is still carried in the stored payload —
// that copies every google.com cookie — just not fingerprinted.
const SESSION_NAMES = new Set([
  'SID', 'SSID', 'HSID', 'APISID', 'SAPISID', 'LSID',
  '__Secure-1PSID', '__Secure-3PSID', '__Secure-1PAPISID', '__Secure-3PAPISID',
  '__Host-1PLSID', '__Host-3PLSID',
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
// Set once the keyring probe has finished, whatever it decided. Before that, `enabled` being
// false means "not known yet", not "off", so an auth navigation must be buffered — see init().
let initSettled = false;

const emailHashHex = (email) => crypto.createHash('sha256').update(email.toLowerCase()).digest('hex');
// Addresses are compared case-insensitively throughout. accounts.json records whatever a
// page rendered, and two apps can disagree about the casing of the same Google account.
const emailKey = (email) => String(email || '').trim().toLowerCase();
const sameEmail = (a, b) => emailKey(a) !== '' && emailKey(a) === emailKey(b);
const storeFile = (email) => path.join(ctx.storeDir, emailHashHex(email) + '.enc');
// Logs are shared in bug reports, so an address is never written in the clear.
const emailTag = (email) => emailHashHex(String(email || '')).slice(0, 12);

// email -> hash of the session this process last wrote or adopted, keyed by emailKey() so a
// casing change cannot make one identity look like two. Breaks the loop: a process never
// republishes, nor re-adopts, a session it already reflects.
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

// Ask an open slot window who it is actually signed in as. accounts.json holds what was
// detected at some past load; the window's jar can be signed into a different account by now.
const LIVE_IDENTITY_JS = `(function(){
  var a=document.querySelector('[aria-label*="Google Account" i]');
  var s=a?(a.getAttribute('aria-label')||''):(document.title||'');
  var m=s.match(/[\\w.+-]+@[\\w.-]+\\.[A-Za-z]{2,}/);
  return m?m[0]:'';
})()`;

async function liveIdentityForSlot(slot) {
  const wins = ctx.windowsForSlot(slot)
    .filter((w) => w && !w.isDestroyed() && w.webContents && !w.webContents.isDestroyed());
  if (!wins.length) return { open: false, email: '' };
  for (const w of wins) {
    try {
      const got = await w.webContents.executeJavaScript(LIVE_IDENTITY_JS, true);
      const email = typeof got === 'string' ? got.trim() : '';
      if (email) return { open: true, email };
    } catch (e) { /* navigating or gone — nothing to compare against */ }
  }
  return { open: true, email: '' };
}

// Publish the slot's current Google session, if it has one and it differs from what the
// store already holds. Never publishes an empty session — a signed-out app must not wipe the
// shared login for everyone else.
//
// The address it files under comes from accounts.json, which is a memory rather than a live
// fact: a slot whose window has since been switched to another account still reports the old
// address until the page is re-scraped. Filing B's cookies under A would make every app's A
// slot adopt B, so the address is re-read around the snapshot and, when a window is open,
// checked against the live page. Never rejects: main.js calls this fire-and-forget.
async function publish(slot) {
  try {
    await publishSlot(slot);
  } catch (e) {
    log('publish failed: ' + (e && e.message));
  }
}

async function publishSlot(slot) {
  if (!enabled) return;
  const email = ctx.emailForSlot(slot);
  if (!email) return; // identity unknown → nothing to key on yet
  const ses = session.fromPartition('persist:account-' + slot);

  // accounts.js can rewrite the address at any moment (a detected sign-in change). Read it
  // immediately before and after the cookie sweep: if it moved, the snapshot belongs to
  // neither identity cleanly, so leave the store alone until the next event.
  const before = ctx.emailForSlot(slot);
  const cookies = await authCookies(ses);
  const after = ctx.emailForSlot(slot);
  if (!sameEmail(email, before) || !sameEmail(email, after)) {
    log('publish skipped for slot ' + slot + ': account address changed while reading cookies');
    return;
  }

  const hash = sessionHash(cookies);
  if (!hash) return;                       // signed out; leave the store alone
  if (syncedHash.get(emailKey(after)) === hash) return;

  // With a window open, the live page outranks the remembered address. With no window (a
  // slot signed in earlier and never reopened — publishKnownSlots), the remembered address
  // is all there is, and publishing it is how that session reaches the other apps.
  const live = await liveIdentityForSlot(slot);
  if (live.open && live.email && !sameEmail(live.email, after)) {
    log('publish skipped for slot ' + slot + ': window is signed in as ' + emailTag(live.email) +
      ', not the remembered ' + emailTag(after));
    return;
  }

  const key = await getKey();
  if (!key) return;

  // Skip a redundant write if another app already published this exact session.
  try {
    const existing = fs.readFileSync(storeFile(after));
    const prior = JSON.parse(decrypt(key, existing));
    if (sessionHash(prior.cookies || []) === hash) { syncedHash.set(emailKey(after), hash); return; }
  } catch (e) { /* no readable prior file; fall through and write */ }

  // The address may have been rewritten during the awaits above (the live page's own
  // detection lands on dom-ready). Those cookies were snapshotted under the old identity.
  if (!sameEmail(after, ctx.emailForSlot(slot))) {
    log('publish skipped for slot ' + slot + ': account address changed before write');
    return;
  }

  const payload = JSON.stringify({
    v: 1,
    email: after,
    updatedAt: Date.now(),
    cookies: cookies.map((c) => ({
      name: c.name, value: c.value, domain: c.domain, path: c.path,
      secure: c.secure, httpOnly: c.httpOnly,
      expirationDate: c.expirationDate, sameSite: c.sameSite,
    })),
  });

  const dst = storeFile(after);
  // Unique per write (pid + random), so two publishes for the same email — even
  // concurrently in one process — never share a temp path and clobber each other's bytes
  // before the atomic rename.
  const tmp = dst + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  try {
    fs.mkdirSync(ctx.storeDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, encrypt(key, payload), { mode: 0o600 });
    fs.renameSync(tmp, dst); // atomic: a reader never sees a half-written file
    syncedHash.set(emailKey(after), hash);
    log('published session for ' + emailTag(after) + ' (' + cookies.length + ' cookies)');
  } catch (e) {
    // A failed rename (or write) would otherwise strand ciphertext in a temp file nothing
    // ever reads. Best effort here; the startup sweep catches whatever this misses.
    try { fs.unlinkSync(tmp); } catch (e2) { /* never created, or already renamed */ }
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
    // Case-insensitive: the publishing app may have recorded the same address in a different
    // casing than this one reads from accounts.json.
    if (!data || !Array.isArray(data.cookies) || !sameEmail(data.email, email)) return null;
    // A file an older build wrote from a signed-out window (see SIGNED_IN_NAMES) is not a
    // session; treat it as absent so the next real publish replaces it.
    if (!sessionHash(data.cookies)) return null;
    return data;
  } catch (e) {
    log('stored session ' + emailTag(email) + ' could not be decrypted — ignoring');
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

// Auth navigations that arrived before the keyring probe resolved. `enabled` is false until
// then, and dropping them would strand a slot that signed in during startup even though a
// session is available the moment the probe says yes. Bounded: a pathological loop must not
// grow it without limit.
const pendingAuth = [];
function notePendingAuth(slot, wc) {
  if (pendingAuth.some((p) => p.slot === slot && p.wc === wc)) return;
  if (pendingAuth.length >= 16) pendingAuth.shift();
  pendingAuth.push({ slot, wc });
}
function drainPendingAuth() {
  while (pendingAuth.length) {
    const p = pendingAuth.shift();
    adoptForAuth(p.slot, p.wc).catch(() => {});
  }
}

async function adoptForAuth(slot, wc) {
  if (!ctx || !wc || wc.isDestroyed() || adopting.has(slot)) return;
  if (!enabled) {
    if (!initSettled) notePendingAuth(slot, wc); // replayed from init() once the probe ends
    return;
  }
  adopting.add(slot);
  try {
    const email = ctx.emailForSlot(slot);
    if (!email) return;
    const ses = session.fromPartition('persist:account-' + slot);
    if (await hasSession(ses)) return; // already have a Google session; nothing to do

    const data = await readStored(email);
    if (!data) return;
    // The address can be rewritten while the reads above are in flight. Never graft a
    // session onto a slot that has since been relabelled — that would sign in the wrong one.
    if (!sameEmail(email, ctx.emailForSlot(slot))) {
      log('adopt skipped for slot ' + slot + ': account address changed during adopt');
      return;
    }
    const hash = sessionHash(data.cookies);
    if (attemptedHash.get(slot) === hash) return; // already tried this exact session — no loop
    attemptedHash.set(slot, hash);

    const ok = await injectInto(ses, data.cookies);
    if (ok && !wc.isDestroyed()) {
      syncedHash.set(emailKey(email), hash);
      log('adopted session for ' + emailTag(email) + ' into slot ' + slot + ' (' + ok + ' cookies) at Google sign-in');
      wc.reload();
    }
  } catch (e) {
    log('adopt failed for slot ' + slot + ': ' + (e && e.message));
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
    // setTimeout does not catch a rejected callback, so every await below lives under one
    // guard: a transient read failure must not become an unhandled rejection.
    try {
      for (const slot of activeSlots()) {
        const email = ctx.emailForSlot(slot);
        if (!email) continue;
        const wins = ctx.windowsForSlot(slot)
          .filter((w) => w && !w.isDestroyed() && w.webContents && !w.webContents.isDestroyed() &&
            isGoogleAuthUrl(w.webContents.getURL()));
        if (!wins.length) continue;                      // no window here is at Google sign-in
        const ses = session.fromPartition('persist:account-' + slot);
        if (await hasSession(ses)) continue;             // already signed in
        const data = await readStored(email);
        if (!data) continue;
        // Same identity guard as publish/adopt: the slot may have been relabelled while the
        // session was being read.
        if (!sameEmail(email, ctx.emailForSlot(slot))) continue;
        const hash = sessionHash(data.cookies);
        if (syncedHash.get(emailKey(email)) === hash) continue;    // already have this one
        const injected = await injectInto(ses, data.cookies);
        if (!injected) continue;
        syncedHash.set(emailKey(email), hash);
        attemptedHash.set(slot, hash);
        for (const w of wins) w.webContents.reload();
        log('propagated session for ' + emailTag(email) + ' to slot ' + slot);
      }
    } catch (e) {
      log('store-change handling failed: ' + (e && e.message));
    }
  }, 800);
}

function activeSlots() {
  const slots = [];
  for (let n = 1; n <= WINDOW_SLOTS; n++) {
    if (ctx.windowsForSlot(n).some((w) => w && !w.isDestroyed())) slots.push(n);
  }
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

let storeWatcher = null;
let storeWatchRetry = null;
let storeWatchFailures = 0;

function scheduleWatchRetry() {
  if (storeWatchRetry || storeWatchFailures++ >= 5) return;
  storeWatchRetry = setTimeout(() => { storeWatchRetry = null; startWatching(); }, 5000);
}

// storeDir is watched (not individual files) so newly-created identity files are seen too.
function startWatching() {
  if (storeWatcher) return;
  try {
    fs.mkdirSync(ctx.storeDir, { recursive: true, mode: 0o700 });
    storeWatcher = fs.watch(ctx.storeDir, () => onStoreChanged());
    // An unhandled 'error' on a watcher is fatal to the process, and a watcher that errored
    // is dead. Close it and retry a few times: without this, one transient inotify failure
    // silently stopped cross-app propagation until the next restart.
    storeWatcher.on('error', (e) => {
      log('store watcher error: ' + (e && e.message));
      try { storeWatcher.close(); } catch (e2) { /* already dead */ }
      storeWatcher = null;
      scheduleWatchRetry();
    });
    storeWatchFailures = 0;
  } catch (e) {
    log('cannot watch store dir: ' + (e && e.message));
    scheduleWatchRetry();
  }
}

// A temp file is left only when a publish died between write and rename. It is ciphertext
// nothing will ever read, so clear old ones at startup instead of letting them accumulate.
function sweepStaleTemps() {
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(ctx.storeDir)) {
      if (!f.endsWith('.tmp')) continue;
      const p = path.join(ctx.storeDir, f);
      try { if (now - fs.statSync(p).mtimeMs > 60 * 60 * 1000) fs.unlinkSync(p); } catch (e) { /* gone */ }
    }
  } catch (e) { /* store dir not created yet — nothing to sweep */ }
}

// Drop stored sessions for addresses no slot claims any more. Bounded by ACCOUNT_SLOTS, not
// WINDOW_SLOTS: the store and accounts.json are shared, so a single-account app must not
// prune the sessions belonging to its siblings' slots. Only files older than a month are
// touched, because accounts.json is a cache that can lag a sign-in in another app, and the
// live cookie jars are never modified — the worst case is one app re-signing in.
const PRUNE_AGE_MS = 30 * 24 * 60 * 60 * 1000;
function pruneOrphanedSessions() {
  const known = new Set();
  for (let n = 1; n <= ACCOUNT_SLOTS; n++) {
    const email = ctx.emailForSlot(n);
    if (email) known.add(emailHashHex(email));
  }
  let pruned = 0;
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(ctx.storeDir)) {
      if (!f.endsWith('.enc')) continue;
      if (known.has(f.slice(0, -4))) continue;
      const p = path.join(ctx.storeDir, f);
      try {
        if (now - fs.statSync(p).mtimeMs > PRUNE_AGE_MS) { fs.unlinkSync(p); pruned++; }
      } catch (e) { /* gone */ }
    }
  } catch (e) { /* no store dir */ }
  if (pruned) log('pruned ' + pruned + ' orphaned session store(s)');
}

// Called from main once, after app.setName (so appData/userData paths are settled). The
// keyring probe decides whether the feature runs at all.
async function init(context) {
  ctx = context;
  sweepStaleTemps();
  const key = await getKey();
  enabled = !!key;
  initSettled = true;
  if (!enabled) {
    // No working keyring on this machine — the honest outcome of "we can't know the
    // capabilities": the feature turns itself off rather than storing a session in the clear.
    pendingAuth.length = 0; // nothing will ever replay these
    log('no working keyring backend (tried ' + KEYRING_BACKENDS.map((b) => b.name).join(', ') +
      ') — single sign-on across apps is off; each app signs in on its own');
    return;
  }
  pruneOrphanedSessions();
  startWatching();
  log('ready (keyring: ' + keyBackendName + ')');
  // Sign-ins that reached Google while the keyring probe was still running.
  drainPendingAuth();
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
  for (let n = 1; n <= WINDOW_SLOTS; n++) {
    if (!ctx.emailForSlot(n)) continue;
    attachSlot(n); // and keep publishing it as Google rotates the session
    await publish(n);
  }
}

module.exports = { init, attachSlot, watchAuthNavigation, publish };
