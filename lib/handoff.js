// A link that belongs to another of these apps opens in that app, not in the browser: a
// messenger.com link in a Google Messages text, a facebook.com/messages/t/ link in an email.
// Before this, every app knew only its own scope, so anything outside it went to Chrome even
// when the app it belonged to was installed alongside.
//
// Each app publishes what it claims to a shared directory when it starts; an app about to
// send a link to the browser asks that directory first. Only links already headed OUT are
// offered -- what an app keeps in-app (Calendar's pop-ups inside Gmail) is never redirected.
// The receiving app re-checks the link against its own scope before loading it, so an entry
// here can only ever route a link to an app that would have loaded it anyway.
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { app } = require('electron');
const { cfg, APP_SLUG, APP_HOST, ACCOUNTS_DIR } = require('./config');
const { hasSuffix, pathUnder, logRecovery } = require('./util');

const REGISTRY_DIR = path.join(ACCOUNTS_DIR, 'apps');

const list = (s) => String(s || '').split(/[,\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);

// Narrower than what the app keeps in-app. An app's in-app scope is its registrable domain,
// which for Gmail is all of google.com; claiming that would pull Calendar's links into Gmail.
// So the claim is the app's exact host -- or, for a path-scoped app, its domain under those
// paths, since the host alone (www.facebook.com) would miss facebook.com/messages/t/ --
// plus its declared related hosts.
function ownClaim() {
  const paths = list(cfg.paths);
  const parts = APP_HOST.split('.').filter(Boolean);
  return {
    slug: APP_SLUG,
    exe: process.execPath,
    host: paths.length ? parts.slice(-2).join('.') : APP_HOST,
    paths,
    related: list(cfg.related).map((s) => s.replace(/^\.+/, '')),
  };
}

function claims(entry, u) {
  if (entry.related.length && hasSuffix(u.hostname, entry.related)) return true;
  if (!entry.host || !hasSuffix(u.hostname, [entry.host])) return false;
  return entry.paths.length === 0 || pathUnder(u.pathname, entry.paths);
}

// Unpackaged, execPath is the bare Electron binary, which cannot be handed a link.
function register() {
  if (!app.isPackaged || !APP_SLUG) return;
  try {
    fs.mkdirSync(REGISTRY_DIR, { recursive: true });
    const file = path.join(REGISTRY_DIR, APP_SLUG + '.json');
    const next = JSON.stringify(ownClaim());
    let prev = null;
    try { prev = fs.readFileSync(file, 'utf8'); } catch (e) { /* first run */ }
    if (prev !== next) fs.writeFileSync(file, next);
  } catch (e) { logRecovery('handoff: could not register: ' + e.message); }
}

// Read per call rather than cached: this runs only when a link is leaving for the browser,
// and an app installed since this one started should still be found.
function claimantFor(u) {
  let names = [];
  try { names = fs.readdirSync(REGISTRY_DIR).filter((f) => f.endsWith('.json')); } catch (e) { return null; }
  for (const name of names) {
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(REGISTRY_DIR, name), 'utf8'));
      if (!entry || entry.slug === APP_SLUG) continue;
      entry.paths = entry.paths || [];
      entry.related = entry.related || [];
      // An uninstalled app leaves its entry behind; the missing binary is the tell.
      if (!entry.exe || !fs.existsSync(entry.exe)) continue;
      if (claims(entry, u)) return entry;
    } catch (e) { /* a malformed entry is skipped, never fatal */ }
  }
  return null;
}

// True if the link was handed to another app. The app's single-instance lock turns this
// launch into a second-instance event when it is already running.
function handOff(url, fallback) {
  let u;
  try { u = new URL(url); } catch (e) { return false; }
  const entry = claimantFor(u);
  if (!entry) return false;
  logRecovery('handed link to ' + entry.slug + ': ' + u.protocol + '//' + u.host);
  try {
    const child = spawn(entry.exe, [url], { detached: true, stdio: 'ignore' });
    child.on('error', () => fallback(url));
    child.unref();
  } catch (e) {
    fallback(url);
  }
  return true;
}

// A link another app handed to this one, from a launch's argv. Only one this app would load
// in-app anyway (`accept`); anything else on the command line is ignored.
function linkFromArgv(argv, accept) {
  for (const arg of argv || []) {
    if (!/^https?:\/\//i.test(arg)) continue;
    try { if (accept(new URL(arg))) return arg; } catch (e) { /* not a URL */ }
  }
  return null;
}

module.exports = { register, handOff, linkFromArgv };
