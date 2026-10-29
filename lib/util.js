// Helpers with no dependencies of their own, used across most of the other modules.
// Kept together here rather than duplicated: hasSuffix in particular is a security-relevant
// comparison (see below) and must behave identically everywhere it is asked.

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Logged, not silent. The failure this exists for is invisible from inside the app -- a
// window holding a dead connection looks identical to an idle one -- so the journal is the
// only place the behaviour can be confirmed after the fact. `journalctl --user -t <slug>`,
// or grep the launcher's output for "[recovery]".
function logRecovery(msg) {
  try { console.log('[recovery] ' + msg); } catch (e) { /* never worth taking the app down */ }
}

// The try/catch above cannot see a failed write: Node reports it later, as an 'error' event
// on the stream, and an unhandled one is an uncaught exception — Electron's "A JavaScript
// error occurred in the main process" dialog. That happens whenever stdout outlives whatever
// it was attached to: measured, an app launched from a terminal that then went away hit
// EIO on its next log line, mid-sign-in. Losing a log line is fine; losing the app is not.
for (const stream of [process.stdout, process.stderr]) {
  try { if (stream) stream.on('error', () => { /* see above */ }); } catch (e) { /* ignore */ }
}

// True if `host` equals or is a subdomain of any suffix in the list. Suffix-matched rather
// than regex'd, so lookalikes like "google.com.evil.com" / "google.evil.com" don't match.
function hasSuffix(host, suffixes) {
  host = String(host || '').toLowerCase();
  return suffixes.some((s) => host === s || host.endsWith('.' + s));
}

// True if `pathname` sits under one of `prefixes`. Boundary-aware: `/login` matches
// `/login`, `/login/`, `/login.php`, `/login?next=...` but NOT `/logins-of-x`. `/` as a prefix
// would otherwise match every path — kept exact-only.
function pathUnder(pathname, prefixes) {
  const p = (pathname || '/').toLowerCase();
  for (const prefix of prefixes) {
    if (p === prefix) return true;
    if (prefix === '/') continue;
    if (p.startsWith(prefix + '/') || p.startsWith(prefix + '.') || p.startsWith(prefix + '?')) return true;
  }
  return false;
}

module.exports = { wait, logRecovery, hasSuffix, pathUnder };
