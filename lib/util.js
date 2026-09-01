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

// True if `host` equals or is a subdomain of any suffix in the list. Suffix-matched rather
// than regex'd, so lookalikes like "google.com.evil.com" / "google.evil.com" don't match.
function hasSuffix(host, suffixes) {
  host = String(host || '').toLowerCase();
  return suffixes.some((s) => host === s || host.endsWith('.' + s));
}

module.exports = { wait, logRecovery, hasSuffix };
