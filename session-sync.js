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
//     (libsecret via secret-tool on Linux), NOT in a file next to the ciphertext, and NOT
//     via Electron safeStorage, whose key is scoped per app name and so cannot be shared
//     across these separate apps (measured).
//   - Fail closed: if the keyring is unavailable the feature disables itself and nothing is
//     ever written in the clear.

const { session } = require('electron');
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
// drops the write fails that round-trip and is passed over. The re-read also settles the race
// where two apps start together — each adopts whatever value is canonical afterwards, so they
// converge rather than encrypting with divergent keys.
let keyPromise = null;
function getKey() {
  if (keyPromise) return keyPromise;
  keyPromise = (async () => {
    for (const be of KEYRING_BACKENDS) {
      const r = await be.lookup();
      if (r.missing) continue;
      const key = parseKey(r.stdout);
      if (key) { keyBackendName = be.name; return key; }
    }
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
  })().catch(() => null);
  return keyPromise;
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

// A stable fingerprint of the session cookies, so a process can tell whether a store already
// reflects what it holds — the guard that stops publish/adopt from ping-ponging between
// apps. Only the identifying session cookies count, so incidental churn does not thrash it.
function sessionHash(cookies) {
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
    const tmp = storeFile(email) + '.' + process.pid + '.tmp';
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

// Before a slot's window loads: if it is signed out and a session exists for the email that
// slot is meant to be, adopt it so the first paint is already authenticated. Returns true if
// it injected anything. Never disturbs a slot that is already signed in.
async function adoptBeforeLoad(slot) {
  if (!enabled) return false;
  const email = ctx.emailForSlot(slot);
  if (!email) return false;
  const ses = session.fromPartition('persist:account-' + slot);
  if (await hasSession(ses)) return false; // already signed in; leave it

  const data = await readStored(email);
  if (!data) return false;
  const hash = sessionHash(data.cookies);
  const ok = await injectInto(ses, data.cookies);
  if (ok) { syncedHash.set(email, hash); log('adopted session for ' + email + ' into slot ' + slot + ' (' + ok + ' cookies)'); }
  return ok > 0;
}

// A sibling app just published (the store changed). For each running window whose slot is
// signed out and sitting on a Google login screen, adopt and reload — so a login in one app
// lights up the others that are open. A window already showing app content is left alone; we
// do not yank a session change under someone mid-task.
let watchTimer = null;
function onStoreChanged() {
  if (watchTimer) return;                  // coalesce the burst of events a write produces
  watchTimer = setTimeout(async () => {
    watchTimer = null;
    if (!enabled) return;
    for (const slot of activeSlots()) {
      const email = ctx.emailForSlot(slot);
      if (!email) continue;
      const ses = session.fromPartition('persist:account-' + slot);
      if (await hasSession(ses)) continue;             // already signed in
      const data = await readStored(email);
      if (!data) continue;
      const hash = sessionHash(data.cookies);
      if (syncedHash.get(email) === hash) continue;    // already have this one
      const wins = ctx.windowsForSlot(slot).filter((w) => w && !w.isDestroyed());
      if (!wins.length) continue;
      const injected = await injectInto(ses, data.cookies);
      if (!injected) continue;
      syncedHash.set(email, hash);
      for (const w of wins) {
        const url = w.webContents.getURL();
        // Only reload a window that is actually sitting at a Google sign-in screen; do not
        // reload one already showing the app.
        if (/accounts\.google\.com|ServiceLogin|\/signin/i.test(url)) w.webContents.reload();
      }
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
}

module.exports = { init, attachSlot, adoptBeforeLoad, publish };
