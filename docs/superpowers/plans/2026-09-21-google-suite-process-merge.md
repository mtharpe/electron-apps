# Google Suite Process Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge Gmail, Calendar, Tasks, Keep, and Messages into one Electron process ("Google
Suite") so they share one Chromium process tree instead of five, while Tidal and Messenger
stay standalone.

**Architecture:** Generalize the single-service config (`app-config.json` with one `url`)
into a `services` array, thread a `SERVICES` list through every module that currently assumes
one app, and re-key the window registry from `slot` to `(serviceSlug, slot)`. Extract the
Electron-free parts of that logic (`lib/services.js`, `lib/service-rules.js`) into pure,
directly-testable modules. Extend `services.conf` / the build scripts with a "suite" grouping
that packages several existing service rows as one binary.

**Tech Stack:** Node.js (bundled with castlabs Electron v42.8.0+wvcus), bash 3.2-compatible
shell scripts, Python 3 (already used by the build scripts for JSON/icon work). No new
runtime or dev dependencies.

**Spec:** `docs/superpowers/specs/2026-09-21-google-suite-process-merge-design.md`

## Global Constraints

- Bash scripts stay bash 3.2 compatible: no associative arrays, no `mapfile`, no bare
  expansion of a possibly-empty array under `set -u` (use `${arr[@]+"${arr[@]}"}`).
- No new npm dependencies. Tests are plain Node scripts using the built-in `assert` module.
- No backwards-compatibility shims: `lib/config.js` stops exporting `APP_URL`/`APP_HOST`/
  `APP_SLUG` once every consumer moves to `SERVICES` in the same task — don't leave both.
- Tidal and Messenger are never suite members. A suite member must not set `drm=1` in
  `services.conf` — the build script must refuse to build a suite that includes one.
- Slot N means one person, shared across every service in a suite via one cookie partition —
  this is intentional per the spec's "shared jar" decision, not a bug to guard against.
- `require('electron')` cannot be resolved by plain `node` outside an Electron process, so
  any module under test must not call Electron APIs at module-load time. That's why the
  pure logic lives in `lib/services.js` and `lib/service-rules.js`, separate from
  `lib/config.js` and `lib/routing.js`, which do touch Electron.

---

## File Structure

| File | Change |
|---|---|
| `lib/services.js` | **New.** Pure: turns an `app-config.json`-shaped object into a `SERVICES` array (one entry per service, host/domain/relatedHosts/pathPrefixes pre-computed). No Electron dependency. |
| `lib/config.js` | Modified: calls `resolveServices(cfg)` from `lib/services.js`, exports `SERVICES`. Drops `APP_URL`, `APP_HOST`, `APP_SLUG`. |
| `lib/service-rules.js` | **New.** Pure: `isFirstPartyUrl`/`isFirstPartyHost`/`findServiceForHost` over a `SERVICES`-shaped array. No Electron dependency. |
| `lib/routing.js` | Modified: derives first-party checks from `service-rules.js` + `SERVICES` instead of single-app constants. |
| `lib/page-tweaks.js` | Modified: picks shipped CSS per service by host before injecting. |
| `lib/recovery.js` | Modified: post-wake reachability probe tries every service's URL, not one global `APP_URL`. |
| `lib/window-registry.js` | Modified: `windows` keyed by `"<serviceSlug>:<slot>"`; adds `windowKey`/`parseWindowKey`/`getLastFocusedSlot`/`setLastFocusedSlot`. |
| `lib/accounts.js` | Modified: `refreshAccountPresentation` iterates composite keys. |
| `lib/menu.js` | Modified: accelerator items open a whole slot; adds a "Services" submenu for suites. |
| `main.js` | Modified: `openServiceWindow(service, slot)` + `openAccountSlot(slot)` replace `openAccountWindow(slot)`; per-slot focus tracking; session-sync wiring aggregates windows across services. |
| `services.conf` | Modified: adds a `SUITES` array declaring the Google Suite grouping. |
| `select-services.sh` | Modified: suite-aware selection (`SELECTED_KIND`), `_service_row_by_key`, `build_suite_config`. |
| `build-linux.sh`, `build.sh` | Modified: suite-aware packaging branch. |
| `icons/google-suite.png` (+ `.icns` for macOS) | **New.** Placeholder art for the suite's own identity. |
| `test/services.test.js`, `test/service-rules.test.js`, `test/window-registry.test.js` | **New.** Plain-Node `assert` tests for the three pure modules. |
| `test/select-services.test.sh` | **New.** Shell test for suite-aware selection. |
| `package.json` | Modified: adds a `test` script running the above. |

---

### Task 1: Pure service-config module

**Files:**
- Create: `lib/services.js`
- Create: `test/services.test.js`
- Modify: `lib/config.js`
- Modify: `package.json`

**Interfaces:**
- Produces: `resolveServices(cfg)` → `Array<{ slug, name, url, host, domain, relatedHosts, pathPrefixes }>`, from `lib/services.js`. Every later task that needs "the list of services this build wraps" imports `SERVICES` from `lib/config.js`, which is exactly this array.

- [ ] **Step 1: Write the failing test**

```js
// test/services.test.js
const assert = require('assert');
const { resolveServices } = require('../lib/services');

// Single-service build (today's shape: Tidal, Messenger, or any standalone app).
{
  const cfg = { name: 'Messenger', url: 'https://www.facebook.com/messages/t/', slug: 'messenger',
    related: 'messenger.com', paths: '/messages,/login' };
  const services = resolveServices(cfg);
  assert.strictEqual(services.length, 1);
  const s = services[0];
  assert.strictEqual(s.slug, 'messenger');
  assert.strictEqual(s.name, 'Messenger');
  assert.strictEqual(s.host, 'www.facebook.com');
  assert.strictEqual(s.domain, 'facebook.com');
  assert.deepStrictEqual(s.relatedHosts, ['messenger.com']);
  assert.deepStrictEqual(s.pathPrefixes, ['/messages', '/login']);
}

// Suite build (multiple services, no top-level url).
{
  const cfg = {
    name: 'Google Suite',
    services: [
      { slug: 'gmail', name: 'Gmail', url: 'https://mail.google.com/', related: '', paths: '' },
      { slug: 'google-calendar', name: 'Google Calendar', url: 'https://calendar.google.com/', related: '', paths: '' },
    ],
  };
  const services = resolveServices(cfg);
  assert.strictEqual(services.length, 2);
  assert.strictEqual(services[0].slug, 'gmail');
  assert.strictEqual(services[0].host, 'mail.google.com');
  assert.strictEqual(services[1].slug, 'google-calendar');
  assert.strictEqual(services[1].domain, 'google.com');
}

// A malformed url must not throw — host/domain fall back to empty strings.
{
  const services = resolveServices({ name: 'Broken', url: 'not-a-url', slug: 'broken' });
  assert.strictEqual(services[0].host, '');
  assert.strictEqual(services[0].domain, '');
}

console.log('services.test.js: all assertions passed');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/services.test.js`
Expected: FAIL with `Cannot find module '../lib/services'`

- [ ] **Step 3: Write minimal implementation**

```js
// lib/services.js
// Pure derivation of the SERVICES array from a parsed app-config.json. No Electron
// dependency, so this is directly testable with plain `node`, unlike lib/config.js (which
// touches app.getPath at module-load time).
//
// Two config shapes come in: a suite build's `{ name, services: [...] }`, and a
// single-service build's flat `{ name, url, slug, related, paths }` (today's shape, used by
// Tidal, Messenger, and any future standalone app). Both resolve to the same SERVICES array
// shape, so routing.js/page-tweaks.js never special-case "the one app" — a standalone build
// is just the one-entry case of the general one.

function deriveServiceHostInfo(s) {
  const url = typeof s.url === 'string' ? s.url : '';
  const host = (() => { try { return new URL(url).hostname.toLowerCase(); } catch (e) { return ''; } })();
  const domain = (() => {
    const parts = host.split('.').filter(Boolean);
    return parts.length >= 2 ? parts.slice(-2).join('.') : host;
  })();
  const relatedHosts = String(s.related || '')
    .split(/[,\s]+/).map((x) => x.trim().toLowerCase().replace(/^\.+/, '')).filter(Boolean);
  const pathPrefixes = String(s.paths || '')
    .split(/[,\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
  return {
    slug: typeof s.slug === 'string' ? s.slug : '',
    name: typeof s.name === 'string' ? s.name : '',
    url,
    host,
    domain,
    relatedHosts,
    pathPrefixes,
  };
}

function resolveServices(cfg) {
  if (Array.isArray(cfg.services)) {
    return cfg.services.map(deriveServiceHostInfo);
  }
  return [deriveServiceHostInfo({
    slug: cfg.slug, name: cfg.name, url: cfg.url, related: cfg.related, paths: cfg.paths,
  })];
}

module.exports = { resolveServices, deriveServiceHostInfo };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/services.test.js`
Expected: `services.test.js: all assertions passed`

- [ ] **Step 5: Wire it into `lib/config.js`**

Replace the single-service derivation in `lib/config.js` (the `APP_URL`/`APP_SLUG`/`APP_HOST`
block) with:

```js
const { resolveServices } = require('./services');
...
const APP_NAME = cfg.name;
const SERVICES = resolveServices(cfg);
```

and change the final export to:

```js
module.exports = {
  ROOT, cfg, APP_NAME, IS_MAC, APP_ICON, SERVICES, ACCOUNTS_DIR,
};
```

Remove the now-unused `APP_URL`, `APP_SLUG`, `APP_HOST` declarations entirely — every
consumer moves to `SERVICES` in later tasks of this plan, so there is no interim period
where both need to exist.

- [ ] **Step 6: Add the `test` script**

```json
"scripts": {
  "test": "for f in test/*.test.js; do node \"$f\" || exit 1; done"
}
```
(Add this key to `package.json`, after `"license": "MIT",`.)

- [ ] **Step 7: Run the full test script**

Run: `npm test`
Expected: `services.test.js: all assertions passed`

- [ ] **Step 8: Commit**

```bash
git add lib/services.js lib/config.js test/services.test.js package.json
git commit -m "feat(config): derive a SERVICES array instead of one app's url/host/slug"
```

---

### Task 2: Composite window keys and focus tracking

**Files:**
- Modify: `lib/window-registry.js`
- Create: `test/window-registry.test.js`

**Interfaces:**
- Consumes: nothing (leaf module, as today).
- Produces: `windowKey(serviceSlug, slot)` → `string`; `parseWindowKey(key)` →
  `{ serviceSlug, slot }`; `getLastFocusedSlot()` / `setLastFocusedSlot(n)`. `windows` stays a
  `Map`, now keyed by the string `windowKey` returns instead of a bare slot number. Every
  later task that touches `windows` uses these two functions instead of raw string
  concatenation, so the key format only exists in one place.

- [ ] **Step 1: Write the failing test**

```js
// test/window-registry.test.js
const assert = require('assert');
const { windowKey, parseWindowKey } = require('../lib/window-registry');

assert.strictEqual(windowKey('gmail', 1), 'gmail:1');
assert.strictEqual(windowKey('google-calendar', 12), 'google-calendar:12');
assert.deepStrictEqual(parseWindowKey('gmail:1'), { serviceSlug: 'gmail', slot: 1 });
assert.deepStrictEqual(parseWindowKey('google-calendar:12'), { serviceSlug: 'google-calendar', slot: 12 });
// Round-trip for every slug/slot pair a later task might construct.
assert.strictEqual(parseWindowKey(windowKey('messenger', 3)).slot, 3);

console.log('window-registry.test.js: all assertions passed');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/window-registry.test.js`
Expected: FAIL — `windowKey is not a function`

- [ ] **Step 3: Write minimal implementation**

Replace the contents of `lib/window-registry.js` with:

```js
// Who owns which window.
//
// Extracted so that theme, accounts and recovery can all reach the app's windows without
// requiring each other -- they only ever need "the window for (service, slot)" or "every
// window", and routing those questions through one another is what would make the module
// graph cyclic. This module deliberately depends on nothing.
//
// Keyed by "<serviceSlug>:<slot>" rather than by slot alone: a standalone build (Tidal,
// Messenger) has exactly one service, so its keys are all "<its own slug>:N"; a suite build
// has one key per (service, slot) pair, since opening a slot now means one window per
// service for that person, not one window total.

// "<serviceSlug>:<slot>" -> BrowserWindow
const windows = new Map();

function windowKey(serviceSlug, slot) {
  return serviceSlug + ':' + slot;
}

function parseWindowKey(key) {
  const i = key.lastIndexOf(':');
  return { serviceSlug: key.slice(0, i), slot: Number(key.slice(i + 1)) };
}

function focusWindow(win) {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

let accountsWindow = null;

// accountsWindow is a `let`, so it cannot be shared by binding across a module boundary --
// a require() copies the value, not the slot. Hence the accessor pair.
function getAccountsWindow() { return accountsWindow; }
function setAccountsWindow(win) { accountsWindow = win; }

// The slot last brought to the foreground, so a "reopen this one service" menu action (see
// lib/menu.js) has a slot to target even though a suite has no single "the current window."
// Same accessor-pair reasoning as accountsWindow: a bare export of a `let` freezes at its
// initial value across a require() boundary.
let lastFocusedSlot = null;
function getLastFocusedSlot() { return lastFocusedSlot; }
function setLastFocusedSlot(n) { lastFocusedSlot = n; }

module.exports = {
  windows, windowKey, parseWindowKey, focusWindow,
  getAccountsWindow, setAccountsWindow, getLastFocusedSlot, setLastFocusedSlot,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/window-registry.test.js`
Expected: `window-registry.test.js: all assertions passed`

- [ ] **Step 5: Run the full test script**

Run: `npm test`
Expected: both `services.test.js` and `window-registry.test.js` report all assertions passed.

- [ ] **Step 6: Commit**

```bash
git add lib/window-registry.js test/window-registry.test.js
git commit -m "feat(window-registry): key windows by (service, slot), track last-focused slot"
```

---

### Task 3: Pure service-rules module and routing update

**Files:**
- Create: `lib/service-rules.js`
- Create: `test/service-rules.test.js`
- Modify: `lib/routing.js`

**Interfaces:**
- Consumes: the `SERVICES` shape from Task 1 (`{ slug, name, url, host, domain, relatedHosts, pathPrefixes }`).
- Produces: `isFirstPartyUrl(services, u)`, `isFirstPartyHost(services, host)`,
  `findServiceForHost(services, host)` — the last one also consumed by Task 4.

- [ ] **Step 1: Write the failing test**

```js
// test/service-rules.test.js
const assert = require('assert');
const { isFirstPartyUrl, isFirstPartyHost, findServiceForHost } = require('../lib/service-rules');
const { resolveServices } = require('../lib/services');

const services = resolveServices({
  name: 'Google Suite',
  services: [
    { slug: 'gmail', name: 'Gmail', url: 'https://mail.google.com/' },
    { slug: 'google-tasks', name: 'Google Tasks', url: 'https://tasks.google.com/tasks/' },
  ],
});

// Own host of any member: first-party.
assert.strictEqual(isFirstPartyUrl(services, new URL('https://mail.google.com/mail/u/0/')), true);
assert.strictEqual(isFirstPartyUrl(services, new URL('https://tasks.google.com/tasks/')), true);
// Unrelated host: not first-party via this list (GOOGLE_HOST_SUFFIXES in routing.js covers
// Google generally; service-rules.js only knows about the services it was given).
assert.strictEqual(isFirstPartyUrl(services, new URL('https://example.com/')), false);
assert.strictEqual(isFirstPartyHost(services, 'tasks.google.com'), true);
assert.strictEqual(isFirstPartyHost(services, 'example.com'), false);

// Path-scoped member (Messenger's shape): only declared prefixes count as in-app.
const messenger = resolveServices({
  name: 'Messenger', url: 'https://www.facebook.com/messages/t/', slug: 'messenger',
  paths: '/messages,/login',
});
assert.strictEqual(isFirstPartyUrl(messenger, new URL('https://www.facebook.com/messages/t/123')), true);
assert.strictEqual(isFirstPartyUrl(messenger, new URL('https://www.facebook.com/groups/456')), false);

// Related hosts (Messenger's calls domain) count regardless of path scoping.
assert.strictEqual(isFirstPartyUrl(
  resolveServices({ name: 'Messenger', url: 'https://www.facebook.com/messages/t/', slug: 'messenger', related: 'messenger.com' }),
  new URL('https://voip.messenger.com/call/abc'),
), true);

assert.strictEqual(findServiceForHost(services, 'mail.google.com').slug, 'gmail');
assert.strictEqual(findServiceForHost(services, 'tasks.google.com').slug, 'google-tasks');
assert.strictEqual(findServiceForHost(services, 'accounts.google.com'), null);

console.log('service-rules.test.js: all assertions passed');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/service-rules.test.js`
Expected: FAIL — `Cannot find module '../lib/service-rules'`

- [ ] **Step 3: Write minimal implementation**

```js
// lib/service-rules.js
// Pure host/path matching over a SERVICES array (see lib/services.js). No Electron
// dependency. routing.js and page-tweaks.js both need "does this URL/host belong to one of
// my services", so the matching logic lives once here instead of twice.

function hasSuffix(host, suffixes) {
  const h = String(host || '').toLowerCase();
  return suffixes.some((s) => h === s || h.endsWith('.' + s));
}

// True if `pathname` sits under one of `prefixes`. Boundary-aware: "/login" matches
// "/login", "/login/", "/login.php", "/login?x" but not "/logins-of-x". Mirrors the
// path-scoping rule documented in services.conf for tenanted services like Messenger.
function pathInAppScope(pathname, prefixes) {
  const p = (pathname || '/').toLowerCase();
  for (const prefix of prefixes) {
    if (p === prefix) return true;
    if (prefix === '/') continue;
    if (p.startsWith(prefix + '/') || p.startsWith(prefix + '.') || p.startsWith(prefix + '?')) return true;
  }
  return false;
}

function serviceOwnsUrl(service, u) {
  if (!service.domain || !hasSuffix(u.hostname, [service.domain])) return false;
  return service.pathPrefixes.length === 0 || pathInAppScope(u.pathname, service.pathPrefixes);
}

function isFirstPartyUrl(services, u) {
  for (const service of services) {
    if (serviceOwnsUrl(service, u)) return true;
    if (service.relatedHosts.length > 0 && hasSuffix(u.hostname, service.relatedHosts)) return true;
  }
  return false;
}

// Hostname-only variant (no path scoping) for callers that only have a host string.
function isFirstPartyHost(services, host) {
  for (const service of services) {
    if (service.domain && hasSuffix(host, [service.domain])) return true;
    if (service.relatedHosts.length > 0 && hasSuffix(host, service.relatedHosts)) return true;
  }
  return false;
}

// The service whose OWN host (not related hosts) matches, or null. Used to pick which
// shipped stylesheet applies to a page (page-tweaks.js) — a related host like Messenger's
// call domain never owns a stylesheet, only a service's primary host does.
function findServiceForHost(services, host) {
  return services.find((s) => s.host && hasSuffix(host, [s.host])) || null;
}

module.exports = { isFirstPartyUrl, isFirstPartyHost, pathInAppScope, serviceOwnsUrl, findServiceForHost };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/service-rules.test.js`
Expected: `service-rules.test.js: all assertions passed`

- [ ] **Step 5: Wire it into `lib/routing.js`**

Replace the per-app derivation block (`APP_DOMAIN`, `APP_RELATED_HOSTS`, `APP_PATH_PREFIXES`,
`pathInAppScope`, `isFirstPartyUrl`, `isFirstPartyHost`) with:

```js
const { cfg, IS_MAC, SERVICES } = require('./config');
const {
  isFirstPartyUrl: servicesFirstPartyUrl,
  isFirstPartyHost: servicesFirstPartyHost,
} = require('./service-rules');
...
function isFirstPartyUrl(u) {
  return hasSuffix(u.hostname, GOOGLE_HOST_SUFFIXES) || servicesFirstPartyUrl(SERVICES, u);
}

function isFirstPartyHost(host) {
  return hasSuffix(host, GOOGLE_HOST_SUFFIXES) || servicesFirstPartyHost(SERVICES, host);
}
```

Delete the old `APP_DOMAIN`/`APP_RELATED_HOSTS`/`APP_PATH_PREFIXES`/`pathInAppScope`
declarations and the old bodies of `isFirstPartyUrl`/`isFirstPartyHost` — nothing else in the
file reads them. `GOOGLE_HOST_SUFFIXES`, the SSO/IdP list, `openInChrome`, and everything
else in `routing.js` is untouched.

- [ ] **Step 6: Run the full test script**

Run: `npm test`
Expected: all three test files report all assertions passed.

- [ ] **Step 7: Commit**

```bash
git add lib/service-rules.js lib/routing.js test/service-rules.test.js
git commit -m "feat(routing): match first-party hosts against every service, not one app"
```

---

### Task 4: Per-service CSS selection

**Files:**
- Modify: `lib/page-tweaks.js`

**Interfaces:**
- Consumes: `SERVICES` (Task 1), `findServiceForHost` (Task 3).
- Produces: no new exports; `applyCustomStyles(wc)` keeps its existing signature.

- [ ] **Step 1: Update the CSS-loading and injection code**

Replace `loadCustomCss`/`applyCustomStyles` and the `CUSTOM_CSS` state in `lib/page-tweaks.js`
with:

```js
const { ROOT, SERVICES } = require('./config');
const { findServiceForHost } = require('./service-rules');
...
// slug -> shipped CSS text, for every service that ships one (styles/<slug>.css).
let SHIPPED_CSS_BY_SLUG = {};
// <userData>/custom.css — one shared file. For a suite this now applies on any of the
// suite's own hosts rather than just one app's, which is a deliberate, documented widening
// (see the spec's "Page styling" section) since the file is user-authored either way.
let CUSTOM_CSS = '';

function loadCustomCss() {
  SHIPPED_CSS_BY_SLUG = {};
  for (const service of SERVICES) {
    if (!service.slug) continue;
    try {
      SHIPPED_CSS_BY_SLUG[service.slug] = fs.readFileSync(path.join(ROOT, 'styles', service.slug + '.css'), 'utf8');
    } catch (e) { /* no shipped stylesheet for this service — the normal case */ }
  }
  try {
    CUSTOM_CSS = fs.readFileSync(path.join(app.getPath('userData'), 'custom.css'), 'utf8');
  } catch (e) {
    CUSTOM_CSS = '';
  }
}

// CSS for `host`, or '' if host doesn't belong to any of this build's services — a Gmail
// rule (or the user's custom.css) has no business running on accounts.google.com during
// sign-in, or on an SSO provider's page.
function cssForHost(host) {
  const service = findServiceForHost(SERVICES, host);
  if (!service) return '';
  const shipped = SHIPPED_CSS_BY_SLUG[service.slug] || '';
  return [shipped, CUSTOM_CSS].filter(Boolean).join('\n');
}

function applyCustomStyles(wc) {
  wc.on('dom-ready', () => {
    let css;
    try { css = cssForHost(new URL(wc.getURL()).hostname); } catch (e) { return; }
    if (css) wc.insertCSS(css);
  });
}
```

Remove the old `APP_SLUG`/`APP_HOST` import and the old single-blob `CUSTOM_CSS` loading
code they replace. `manageWindowTitle` and `attachContextMenu` in the same file are
unchanged — they don't reference per-app config at all.

- [ ] **Step 2: Manual verification (no Electron unit test — this touches `wc.insertCSS`)**

This can't be exercised with plain `node` (it needs a live `webContents`), so verification
happens in Task 12's end-to-end pass using the CDP "--probe" technique already documented in
this repo's CLAUDE.md ("Verifying injection" under "Per-app CSS"): temporarily add
`:root { --probe: yes; }` to `styles/gmail.css`, load the Gmail window, and confirm
`getComputedStyle(document.documentElement).getPropertyValue('--probe')` reads `yes` there
but not in the Calendar window. Record this as a checklist item for Task 12 rather than
re-deriving it now.

- [ ] **Step 3: Commit**

```bash
git add lib/page-tweaks.js
git commit -m "feat(page-tweaks): pick shipped CSS per service host instead of one app-wide blob"
```

---

### Task 5: Per-service reachability probe

**Files:**
- Modify: `lib/recovery.js`

**Interfaces:**
- Consumes: `SERVICES` (Task 1).
- Produces: no signature change to `attachLoadRecovery`/`recoverAfterResume`.

- [ ] **Step 1: Update the reachability probe**

`attachLoadRecovery`'s per-navigation retry already uses `validatedURL` (the URL that
actually failed), which is per-window and needs no change. Only the post-wake reachability
check reads the old single `APP_URL`. Replace it:

```js
const { SERVICES } = require('./config');
...
function probeOrigin(url) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      if (timer) { clearTimeout(timer); timer = null; }
      resolve(ok);
    };
    let req;
    try {
      req = net.request({ method: 'HEAD', url });
      req.on('response', () => finish(true));
      req.on('error', () => finish(false));
      req.end();
    } catch (e) {
      finish(false);
      return;
    }
    timer = setTimeout(() => { try { req.abort(); } catch (e) {} finish(false); }, REACHABILITY_TIMEOUT_MS);
  });
}

// True as soon as ANY of this build's services answers — for a suite, all members are
// Google properties behind the same general connectivity, so one reachable origin is a
// reliable enough signal that the network (not just one server) is back.
async function probeAnyOrigin() {
  for (const service of SERVICES) {
    if (service.url && await probeOrigin(service.url)) return true;
  }
  return false;
}
```

In `recoverAfterResume`, replace `await probeOrigin()` with `await probeAnyOrigin()`, and
replace the log line `logRecovery(trigger + ': waiting for ' + APP_URL + ' to answer');` with:

```js
logRecovery(trigger + ': waiting for ' + SERVICES.map((s) => s.url).join(', ') + ' to answer');
```

Remove the old `const { APP_URL } = require('./config');` import.

- [ ] **Step 2: Manual verification**

No unit test — this needs a live `net.request` and window set. Verified in Task 12 by
confirming the existing single-app wake-recovery behavior is unchanged for Tidal/Messenger
(one-element `SERVICES`, so `probeAnyOrigin` probes exactly the one URL it always did).

- [ ] **Step 3: Commit**

```bash
git add lib/recovery.js
git commit -m "feat(recovery): probe every service's origin on wake, not one global APP_URL"
```

---

### Task 6: Multi-window account presentation

**Files:**
- Modify: `lib/accounts.js`

**Interfaces:**
- Consumes: `windows` (now composite-keyed, Task 2), `parseWindowKey` (Task 2).
- Produces: no signature change to any exported function.

- [ ] **Step 1: Update `refreshAccountPresentation`**

The only place `lib/accounts.js` iterates `windows` is `refreshAccountPresentation`. Update
it to extract the slot from each composite key:

```js
const { windows, parseWindowKey } = require('./window-registry');
...
function refreshAccountPresentation() {
  for (const [key, win] of windows) {
    if (!win || win.isDestroyed()) continue;
    const { slot } = parseWindowKey(key);
    const label = accountLabel(slot);
    if (label) {
      win.setTitle(label);
    } else if (win.webContents && !win.webContents.isDestroyed()) {
      win.webContents.executeJavaScript(ACCOUNT_TITLE_JS, true)
        .then((l) => { if (!win.isDestroyed() && l) win.setTitle(l); })
        .catch(() => { /* ignore */ });
    }
  }
  changedCb();
}
```

Nothing else in `lib/accounts.js` changes: `slotOf(wc)` reads the session partition name
directly and has no dependency on how `windows` is keyed; `accounts.json`, `chromeProfiles`,
`profileForSlot`, and the rest stay exactly as they are, per the spec's "slot is still the
only identity they deal with."

- [ ] **Step 2: Manual verification**

No unit test — this needs live `BrowserWindow`s. Verified in Task 12: rename an account in
the Accounts window and confirm every open window for that slot (across every service in a
suite build) retitles, and only that slot's windows.

- [ ] **Step 3: Commit**

```bash
git add lib/accounts.js
git commit -m "feat(accounts): retitle windows by composite (service, slot) key"
```

---

### Task 7: Menu actions for services and slots

**Files:**
- Modify: `lib/menu.js`

**Interfaces:**
- Consumes: `SERVICES` (Task 1), `getLastFocusedSlot` (Task 2). New action-object shape from
  `main.js` (Task 8): `{ openAccountSlot(slot), openServiceWindow(service, slot), nextFreeSlot(), openAccountsWindow() }` — `openAccountWindow` is renamed to `openAccountSlot` everywhere.
- Produces: no change to `init(actions)` / `buildMenu()` call signatures.

- [ ] **Step 1: Update the default actions stub and imports**

```js
const { IS_MAC, APP_NAME, SERVICES } = require('./config');
const { getLastFocusedSlot } = require('./window-registry');
...
let actions = {
  openAccountSlot: () => {}, openServiceWindow: () => {}, nextFreeSlot: () => 1, openAccountsWindow: () => {},
};
```

- [ ] **Step 2: Update the Accounts menu's click targets**

In `buildMenu()`, change:

```js
accountItems.push({
  label: accountMenuLabel(i),
  accelerator: 'CmdOrCtrl+' + i,
  click: () => actions.openAccountSlot(i),
});
```

and:

```js
{
  label: 'New Account Window',
  accelerator: 'CmdOrCtrl+N',
  click: () => actions.openAccountSlot(actions.nextFreeSlot()),
},
```

(both were `actions.openAccountWindow(...)` before).

- [ ] **Step 3: Add the Services submenu**

Only meaningful when there's more than one service to choose from — a standalone build
(Tidal, Messenger) would show a one-item, always-redundant menu otherwise. Insert this into
the `template` array in `buildMenu()`, right after the `Accounts` entry:

```js
...(SERVICES.length > 1 ? [{
  label: 'Services',
  submenu: SERVICES.map((service) => ({
    label: service.name,
    click: () => actions.openServiceWindow(service, getLastFocusedSlot() || 1),
  })),
}] : []),
```

- [ ] **Step 4: Manual verification**

No unit test — `Menu.buildFromTemplate` needs a live Electron app. Verified in Task 12: in
the Suite build, close one service's window for a slot, use the Services menu to reopen it,
and confirm it reopens for the last-focused slot (or slot 1 if nothing was ever focused).

- [ ] **Step 5: Commit**

```bash
git add lib/menu.js
git commit -m "feat(menu): open a whole account slot per click; add a Services submenu for suites"
```

---

### Task 8: Main process wiring

**Files:**
- Modify: `main.js`

**Interfaces:**
- Consumes: everything from Tasks 1–7 (`SERVICES`, `windowKey`, `setLastFocusedSlot`,
  the renamed menu actions).
- Produces: `openServiceWindow(service, slot)`, `openAccountSlot(slot)`, updated
  `nextFreeSlot()` — these are the actions passed to `menu.init(...)` and used by the app
  lifecycle handlers below.

- [ ] **Step 1: Update imports**

```js
const { APP_NAME, APP_ICON, IS_MAC, ACCOUNTS_DIR, SERVICES } = require('./lib/config');
const { windows, windowKey, focusWindow, getAccountsWindow, setAccountsWindow, setLastFocusedSlot } = require('./lib/window-registry');
```

(`APP_URL` is gone — removed in Task 1 — and `focusWindow`/`getAccountsWindow`/
`setAccountsWindow` were already imported; add `windowKey`/`setLastFocusedSlot`.)

- [ ] **Step 2: Replace `openAccountWindow` with `openServiceWindow`**

```js
function openServiceWindow(service, n) {
  const key = windowKey(service.slug, n);
  const existing = windows.get(key);
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    return existing;
  }

  const partition = 'persist:account-' + n; // shared across every service for this slot
  const sess = session.fromPartition(partition);
  spoofSession(sess);
  sess.__partition = partition;
  sessionSync.attachSlot(n);

  const win = new BrowserWindow(Object.assign({
    width: 1280,
    height: 860,
    show: false,
    title: accountLabel(n) || service.name + ' — Account ' + n,
    backgroundColor: windowBackground(),
    webPreferences: Object.assign({ partition }, STEALTH_WEBPREFS),
  }, APP_ICON ? { icon: APP_ICON } : {}));

  win.webContents.setUserAgent(CHROME_UA);
  win.on('focus', () => setLastFocusedSlot(n));

  let revealTimer = null;
  const reveal = () => {
    if (revealTimer) { clearTimeout(revealTimer); revealTimer = null; }
    if (win.isDestroyed() || win.isVisible()) return;
    if (!win.isMaximized()) win.maximize();
    win.show();
  };
  revealTimer = setTimeout(reveal, REVEAL_DEADLINE_MS);
  win.once('ready-to-show', reveal);

  win.maximize();
  windows.set(key, win);
  win.webContents.on('did-finish-load', () => sessionSync.publish(n));
  sessionSync.watchAuthNavigation(n, win.webContents);
  win.loadURL(service.url, { userAgent: CHROME_UA });
  win.on('closed', () => {
    if (revealTimer) { clearTimeout(revealTimer); revealTimer = null; }
    windows.delete(key);
  });
  return win;
}

// A slot means one person: opening it opens every service's window for that person at once.
// Closing one service's window doesn't close the others — the Services menu (lib/menu.js)
// reopens a single closed one without recreating the whole slot.
function openAccountSlot(n) {
  let first = null;
  for (const service of SERVICES) {
    const win = openServiceWindow(service, n);
    if (!first) first = win;
  }
  return first;
}
```

- [ ] **Step 3: Update `nextFreeSlot`**

A slot counts as occupied if ANY of its services has an open window — "New Account Window"
should only ever land on a slot nothing has touched yet:

```js
function nextFreeSlot() {
  for (let i = 1; i <= ACCOUNT_SLOTS; i++) {
    const inUse = SERVICES.some((service) => windows.get(windowKey(service.slug, i)));
    if (!inUse) return i;
  }
  return 1;
}
```

- [ ] **Step 4: Update the session-sync `windowsForSlot` callback**

```js
sessionSync.init({
  storeDir: path.join(ACCOUNTS_DIR, 'sessions'),
  emailForSlot: (n) => accountConfig(n).email,
  windowsForSlot: (n) => {
    const out = [];
    for (const service of SERVICES) {
      const w = windows.get(windowKey(service.slug, n));
      if (w) out.push(w);
    }
    return out;
  },
  log: logRecovery,
});
```

- [ ] **Step 5: Update every call site of the old `openAccountWindow`**

- `menu.init({ openAccountWindow, nextFreeSlot, openAccountsWindow })` →
  `menu.init({ openAccountSlot, openServiceWindow, nextFreeSlot, openAccountsWindow })`
- `app.on('second-instance', ...)`: `openAccountWindow(nextFreeSlot())` → `openAccountSlot(nextFreeSlot())`
- `app.whenReady().then(...)`: `openAccountWindow(1);` → `openAccountSlot(1);`
- `app.on('activate', ...)`: `openAccountWindow(1)` → `openAccountSlot(1)`

- [ ] **Step 6: Manual verification**

No unit test — this is the Electron entry point. Verified in Task 12's end-to-end pass:
launching a suite build opens one window per service for slot 1; `Cmd+2` opens all of them
again for slot 2; closing one and using the Services menu (Task 7) reopens just that one.

- [ ] **Step 7: Commit**

```bash
git add main.js
git commit -m "feat(main): open a window per service per slot instead of one window per slot"
```

---

### Task 9: Suite grouping in `services.conf` and `select-services.sh`

**Files:**
- Modify: `services.conf`
- Modify: `select-services.sh`
- Create: `test/select-services.test.sh`

**Interfaces:**
- Produces: `SELECTED_KIND` (parallel array to `SELECTED`, one `"service"`/`"suite"` entry per
  selected row), `_service_row_by_key(key)`, `build_suite_config(suiteName, memberRow...)`.
  Consumed by `build-linux.sh`/`build.sh` in Task 10.

- [ ] **Step 1: Declare the suite in `services.conf`**

Add, after the closing `)` of the existing `SERVICES=(...)` array:

```bash
# Suites: named groups of the SERVICES entries above, packaged as ONE binary that shares ONE
# Electron process across every member's windows, instead of one process per member. See
# docs/superpowers/specs/2026-09-21-google-suite-process-merge-design.md for why.
#
# Format:  name|icon|bundle-id|categories|members
#   name        display name; becomes the .app/.desktop name for the WHOLE group
#   icon        basename in icons/ for the suite's OWN icon — distinct from any member's
#   bundle-id   macOS bundle identifier for the group (ignored on Linux)
#   categories  Linux app-menu categories, ';'-terminated
#   members     space-separated short keys (the `icon` column above) of SERVICES rows to
#               bundle into this one process. A member must not set drm=1 — every window in
#               the shared process would otherwise pay its Widevine CDM wait.
SUITES=(
  "Google Suite|google-suite|com.miketharpe.googlesuiteapp|Office;Network;|gmail calendar tasks keep messages"
)
```

- [ ] **Step 2: Write the failing shell test**

```bash
#!/usr/bin/env bash
# test/select-services.test.sh — run from the repo root: bash test/select-services.test.sh
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"
. ./services.conf
. ./select-services.sh

fail() { echo "FAIL: $1" >&2; exit 1; }

# A suite is selectable by its icon key, slug, or display name, same as a service.
resolve_services google-suite
[ "${#SELECTED[@]}" -eq 1 ] || fail "expected exactly one selected entry for 'google-suite'"
[ "${SELECTED_KIND[0]}" = "suite" ] || fail "expected SELECTED_KIND[0]=suite, got ${SELECTED_KIND[0]}"

resolve_services "Google Suite"
[ "${SELECTED_KIND[0]}" = "suite" ] || fail "full-name lookup did not resolve to a suite"

# A plain service still resolves as 'service', unaffected by suites existing.
resolve_services gmail
[ "${SELECTED_KIND[0]}" = "service" ] || fail "expected SELECTED_KIND[0]=service for gmail"

# _service_row_by_key finds a SERVICES row by its short key.
row="$(_service_row_by_key calendar)"
echo "$row" | grep -q '^Google Calendar|' || fail "_service_row_by_key calendar did not return the Calendar row"

# build_suite_config writes the multi-service app-config.json shape.
tmpdir="$(mktemp -d)"
( cd "$tmpdir" && \
  PYTHON_BIN="${PYTHON_BIN:-python3}" \
  bash -c ". '$DIR/select-services.sh'; build_suite_config 'Google Suite' 'gmail|Gmail|https://mail.google.com/||' 'google-calendar|Google Calendar|https://calendar.google.com/||'" )
python3 - "$tmpdir/app-config.json" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1]))
assert cfg['name'] == 'Google Suite', cfg
assert len(cfg['services']) == 2, cfg
assert cfg['services'][0] == {'name': 'Gmail', 'url': 'https://mail.google.com/', 'slug': 'gmail', 'related': '', 'paths': ''}, cfg['services'][0]
assert cfg['services'][1]['slug'] == 'google-calendar', cfg['services'][1]
print("select-services.test.sh: all assertions passed")
PY
rm -rf "$tmpdir"
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bash test/select-services.test.sh`
Expected: FAIL — `google-suite`/`Google Suite` don't resolve yet (`Unknown app: google-suite`),
since `select-services.sh` doesn't know about `SUITES` yet.

- [ ] **Step 4: Implement suite-aware selection in `select-services.sh`**

Change `list_services()` to also print suites:

```bash
list_services() {
  local entry name icon url
  echo "Available apps:"
  echo
  for entry in "${SERVICES[@]}"; do
    IFS='|' read -r name icon url _ _ <<< "$entry"
    printf '  %-10s %-18s %s\n' "$icon" "$(slugify "$name")" "$url"
  done
  if [ "${#SUITES[@]}" -gt 0 ]; then
    echo
    echo "Available suites (several apps sharing one process):"
    echo
    for entry in "${SUITES[@]}"; do
      IFS='|' read -r name icon _ _ members <<< "$entry"
      printf '  %-10s %-18s %s\n' "$icon" "$(slugify "$name")" "$members"
    done
  fi
  echo
  echo 'Name any of them by short key, slug, or full name — e.g. "keep", "google-keep", "Google Keep".'
}
```

Replace `_select_one` so it searches both arrays and records which one matched:

```bash
_select_one() {
  local want="$1" entry chosen kind=""
  for entry in "${SERVICES[@]}"; do
    if _entry_matches "$entry" "$want"; then kind="service"; break; fi
  done
  if [ -z "$kind" ]; then
    for entry in ${SUITES[@]+"${SUITES[@]}"}; do
      if _entry_matches "$entry" "$want"; then kind="suite"; break; fi
    done
  fi
  if [ -z "$kind" ]; then
    echo "Unknown app: $want" >&2
    echo "Run with --list to see the available names." >&2
    return 1
  fi
  for chosen in ${SELECTED[@]+"${SELECTED[@]}"}; do
    [ "$chosen" = "$entry" ] && return 0
  done
  SELECTED[${#SELECTED[@]}]="$entry"
  SELECTED_KIND[${#SELECTED_KIND[@]}]="$kind"
  return 0
}
```

Update `resolve_services` to initialize and fill `SELECTED_KIND` alongside `SELECTED`:

```bash
resolve_services() {
  SELECTED=()
  SELECTED_KIND=()
  if [ "$#" -eq 0 ]; then
    if [ -t 0 ]; then
      _interactive_select || exit 1
    else
      SELECTED=("${SERVICES[@]}")
      local i
      for i in "${!SELECTED[@]}"; do SELECTED_KIND[$i]="service"; done
    fi
  else
    local want
    for want in "$@"; do
      _select_one "$want" || exit 1
    done
  fi

  if [ "${#SELECTED[@]}" -eq 0 ]; then
    echo "No apps selected — nothing to do." >&2
    exit 1
  fi
}
```

And the "Enter/all" branch inside `_interactive_select` (interactive menu selection stays
SERVICES-only by design — a suite must be named explicitly, not picked from the numbered
list, to keep the menu from growing a second, differently-shaped set of rows):

```bash
case "$(_lower "$reply")" in
  ''|all)
    SELECTED=("${SERVICES[@]}")
    SELECTED_KIND=()
    local i
    for i in "${!SELECTED[@]}"; do SELECTED_KIND[$i]="service"; done
    return 0 ;;
esac
```

Add the two new shared helpers, near the bottom of the "choosing which services to act on"
section:

```bash
# The full SERVICES row whose short key/slug/name matches `want`, for resolving a suite's
# member list back to member urls/related/paths. Fails loudly — a typo'd member in
# services.conf is a config bug, not something to build partially.
_service_row_by_key() {
  local want="$1" entry
  for entry in "${SERVICES[@]}"; do
    if _entry_matches "$entry" "$want"; then echo "$entry"; return 0; fi
  done
  echo "Suite member not found in SERVICES: $want" >&2
  return 1
}

# Write app-config.json for a suite build: {"name": <suite display name>, "services": [...]}.
# Each member row is "slug|name|url|related|paths" (already resolved to that member's own
# slug, not its short key — see build-linux.sh/build.sh). Shared by both platforms so the
# JSON shape can't drift between them. PYTHON_BIN lets a caller pick a specific interpreter
# (build.sh uses /usr/bin/python3 for the rest of its JSON work); defaults to `python3`.
build_suite_config() {
  local suite_name="$1"; shift
  "${PYTHON_BIN:-python3}" -c "
import json, sys
suite_name = sys.argv[1]
services = []
for row in sys.argv[2:]:
    slug, name, url, related, paths = row.split('|')
    services.append({'name': name, 'url': url, 'slug': slug, 'related': related, 'paths': paths})
json.dump({'name': suite_name, 'services': services}, open('app-config.json', 'w'))
" "$suite_name" "$@"
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bash test/select-services.test.sh`
Expected: `select-services.test.sh: all assertions passed`

- [ ] **Step 6: Sanity-check `--list` and the existing build scripts still parse**

Run: `bash -c '. ./services.conf; . ./select-services.sh; list_services'`
Expected: prints the existing services, then a new "Available suites" section listing
`google-suite`.

- [ ] **Step 7: Commit**

```bash
git add services.conf select-services.sh test/select-services.test.sh
git commit -m "feat(build): add a SUITES grouping and suite-aware app selection"
```

---

### Task 10: Suite-aware packaging in `build-linux.sh` and `build.sh`

**Files:**
- Modify: `build-linux.sh`
- Modify: `build.sh`

**Interfaces:**
- Consumes: `SELECTED`/`SELECTED_KIND` (Task 9), `_service_row_by_key`/`build_suite_config`
  (Task 9).

- [ ] **Step 1: Update `build-linux.sh`'s per-entry loop**

Replace the loop header `for entry in "${SELECTED[@]}"; do` and the field-reading /
app-config.json-writing part of its body with:

```bash
for i in "${!SELECTED[@]}"; do
  entry="${SELECTED[$i]}"
  kind="${SELECTED_KIND[$i]}"

  if [ "$kind" = "suite" ]; then
    IFS='|' read -r name icon bid categories members <<< "$entry"
  else
    IFS='|' read -r name icon url bid categories related drm paths <<< "$entry"
  fi
  slug="$(slugify "$name")"
  echo "==> Building $name"

  png="$DIR/icons/png/$icon.png"
  if [ ! -f "$png" ]; then
    [ -f "$DIR/icons/$icon.icns" ] || { echo "    missing icons/$icon.icns and icons/png/$icon.png"; exit 1; }
    echo "    extracting icons/png/$icon.png from $icon.icns"
    extract_icns_png "$DIR/icons/$icon.icns" "$png"
  fi

  if [ "$kind" = "suite" ]; then
    member_args=()
    for member in $(echo "$members" | tr ',' ' '); do
      row="$(_service_row_by_key "$member")" || exit 1
      IFS='|' read -r mname _ murl _ _ mrelated mdrm mpaths <<< "$row"
      if [ "${mdrm:-}" = "1" ]; then
        echo "    $mname needs Widevine DRM and cannot be a suite member (every window in the shared process would pay its CDM wait)" >&2
        exit 1
      fi
      mslug="$(slugify "$mname")"
      member_args[${#member_args[@]}]="$mslug|$mname|$murl|${mrelated:-}|${mpaths:-}"
    done
    build_suite_config "$name" "${member_args[@]}"
  else
    # slug travels into the app so main.js can find styles/<slug>.css without re-deriving it.
    # drm is a plain boolean the runtime reads to decide whether to wait on Widevine.
    # paths is a comma/space-separated URL-path allowlist for services tenanted inside a
    # larger site (see services.conf); empty for the common case where the app owns its
    # whole domain.
    python3 -c "import json,sys; json.dump({'name':sys.argv[1],'url':sys.argv[2],'slug':sys.argv[3],'related':sys.argv[4],'drm':sys.argv[5]=='1','paths':sys.argv[6]}, open('app-config.json','w'))" "$name" "$url" "$slug" "${related:-}" "${drm:-}" "${paths:-}"
  fi
  # Becomes this app's WM_CLASS (see above); StartupWMClass in the .desktop file matches it.
  set_product_name "$slug"

  # --executable-name pins the binary name (and with it the WM_CLASS the .desktop file
  # below matches on); without it the binary would be "Google Calendar", spaces and all.
  npx electron-packager . "$name" --platform=linux --arch="$ARCH" \
    --executable-name="$slug" --app-version=1.0.0 \
    --electron-zip-dir="$ELECTRON_ZIP_DIR" \
    "${IGNORE_FLAGS[@]}" \
    --out="$DIR/build" --overwrite >/dev/null

  staged="$DIR/build/$name-linux-$ARCH"
  uninstall_one "$slug"
  install_icons "$png" "$slug"

  themed="" themed_theme=""
  if [ "$ICON_THEME" != "hicolor" ]; then
    found="$(resolve_themed_icon "$slug" "$ICON_THEME")"
    if [ -n "$found" ]; then
      themed_theme="${found%%|*}"
      themed="${found#*|}"
    fi
  fi
  if [ -n "$themed" ] && render_icon "$themed" "$staged/resources/app-icon.png" 256; then
    echo "    icon: $themed_theme (${themed##*/})"
  elif [ -f "$ICONS_DIR/256x256/apps/$slug.png" ]; then
    [ -n "$themed" ] && echo "    note: found $themed but could not render it — using the bundled icon"
    cp "$ICONS_DIR/256x256/apps/$slug.png" "$staged/resources/app-icon.png"
  else
    cp "$png" "$staged/resources/app-icon.png"
  fi

  mkdir -p "$PREFIX/lib/$slug"
  cp -R "$staged/." "$PREFIX/lib/$slug/"
  ln -sfn "$PREFIX/lib/$slug/$slug" "$PREFIX/bin/$slug"

  cat > "$APPS_DIR/$slug.desktop" <<EOF
[Desktop Entry]
Type=Application
Version=1.1
Name=$name
Comment=$name as a standalone app
Exec=$PREFIX/lib/$slug/$slug %U
Icon=$slug
Terminal=false
Categories=$categories
StartupNotify=true
StartupWMClass=$slug
EOF
  chmod 644 "$APPS_DIR/$slug.desktop"
  echo "    installed: $PREFIX/lib/$slug  (launch: $slug)"
done
```

(This is everything from the existing loop, unchanged below the `if/else` branch — only the
field-reading and config-writing at the top of the loop body change.)

Also update `--all` to keep meaning "every SERVICES row" only (unchanged:
`WANTED=("${SERVICES[@]%%|*}")` stays as-is) — a suite is never auto-included by `--all`,
it must be requested by name, so building "everything" never silently duplicates work across
a suite and its members.

- [ ] **Step 2: Apply the same change to `build.sh`**

```bash
rm -rf build && mkdir -p build
PYTHON_BIN=/usr/bin/python3
for i in "${!SELECTED[@]}"; do
  entry="${SELECTED[$i]}"
  kind="${SELECTED_KIND[$i]}"
  if [ "$kind" = "suite" ]; then
    IFS='|' read -r name icon bid categories members <<< "$entry"
  else
    IFS='|' read -r name icon url bid categories related drm paths <<< "$entry"
  fi
  echo "==> Building $name"
  slug="$(slugify "$name")"

  if [ "$kind" = "suite" ]; then
    member_args=()
    for member in $(echo "$members" | tr ',' ' '); do
      row="$(_service_row_by_key "$member")" || exit 1
      IFS='|' read -r mname _ murl _ _ mrelated mdrm mpaths <<< "$row"
      if [ "${mdrm:-}" = "1" ]; then
        echo "    $mname needs Widevine DRM and cannot be a suite member (every window in the shared process would pay its CDM wait)" >&2
        exit 1
      fi
      mslug="$(slugify "$mname")"
      member_args[${#member_args[@]}]="$mslug|$mname|$murl|${mrelated:-}|${mpaths:-}"
    done
    build_suite_config "$name" "${member_args[@]}"
  else
    # slug travels into the app so main.js can find styles/<slug>.css without re-deriving it.
    # drm is a plain boolean the runtime reads to decide whether to wait on Widevine.
    # paths is a comma/space-separated URL-path allowlist for services tenanted inside a
    # larger site (see services.conf); empty for the common case where the app owns its
    # whole domain.
    /usr/bin/python3 -c "import json,sys; json.dump({'name':sys.argv[1],'url':sys.argv[2],'slug':sys.argv[3],'related':sys.argv[4],'drm':sys.argv[5]=='1','paths':sys.argv[6]}, open('app-config.json','w'))" "$name" "$url" "$slug" "${related:-}" "${drm:-}" "${paths:-}"
  fi

  npx electron-packager . "$name" --platform=darwin --arch="$ARCH" \
    --icon="$DIR/icons/$icon.icns" --app-bundle-id="$bid" --app-version=1.0.0 \
    --electron-zip-dir="$ELECTRON_ZIP_DIR" \
    "${IGNORE_FLAGS[@]}" \
    --out="$DIR/build" --overwrite >/dev/null
  rm -rf "$HOME/Applications/$name.app"
  cp -R "$DIR/build/$name-darwin-$ARCH/$name.app" "$HOME/Applications/"
  xattr -dr com.apple.quarantine "$HOME/Applications/$name.app" 2>/dev/null || true
  codesign --force --deep --sign - "$HOME/Applications/$name.app" >/dev/null 2>&1
  echo "    installed + signed: ~/Applications/$name.app"
done
```

- [ ] **Step 3: Re-run the Task 9 shell test plus a dry syntax check**

Run: `bash -n build-linux.sh && bash -n build.sh && bash test/select-services.test.sh`
Expected: no syntax errors, and the Task 9 test still passes (this task doesn't change
`select-services.sh`, just its callers).

- [ ] **Step 4: Commit**

```bash
git add build-linux.sh build.sh
git commit -m "feat(build): package a suite entry as one multi-service binary"
```

---

### Task 11: Suite icon placeholder

**Files:**
- Create: `icons/png/google-suite.png`
- Create: `icons/google-suite.icns` (macOS)

**Interfaces:** none — build-time asset only.

- [ ] **Step 1: Generate a placeholder icon**

There's no single canonical "Google Suite" web app manifest to pull from (unlike Tidal's,
per CLAUDE.md's icon-sourcing note), so generate a plain placeholder good enough to build
and test with, clearly a stand-in pending real art:

```bash
python3 - <<'PY'
from PIL import Image, ImageDraw, ImageFont
img = Image.new('RGBA', (1024, 1024), (66, 133, 244, 255))  # Google blue
d = ImageDraw.Draw(img)
text = "GS"
try:
    font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 420)
except Exception:
    font = ImageFont.load_default()
bbox = d.textbbox((0, 0), text, font=font)
w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
d.text(((1024 - w) / 2 - bbox[0], (1024 - h) / 2 - bbox[1]), text, fill="white", font=font)
img.save("icons/png/google-suite.png")
PY
```

Expected: `icons/png/google-suite.png` exists, 1024×1024, blue square with "GS".

- [ ] **Step 2: Produce a macOS `.icns` from it**

```bash
mkdir -p /tmp/google-suite.iconset
for size in 16 32 64 128 256 512 1024; do
  sips -z "$size" "$size" icons/png/google-suite.png --out "/tmp/google-suite.iconset/icon_${size}x${size}.png" >/dev/null
done
iconutil -c icns /tmp/google-suite.iconset -o icons/google-suite.icns
rm -rf /tmp/google-suite.iconset
```

(`sips`/`iconutil` are macOS-only, which matches this repo's own dev machine; the Linux
build path only needs `icons/png/google-suite.png`, per `build-linux.sh`'s existing
extract-PNG-from-icns fallback.)

- [ ] **Step 3: Commit**

```bash
git add icons/png/google-suite.png icons/google-suite.icns
git commit -m "chore(icons): add a placeholder Google Suite icon pending real art"
```

---

### Task 12: End-to-end build, verification, and rollout

**Files:** none (verification only — no code changes expected; fix forward into the
relevant task's files if something doesn't hold).

**Interfaces:** none.

- [ ] **Step 1: Build the Suite alongside the existing standalone apps**

```bash
./build-linux.sh google-suite   # or ./build.sh google-suite on macOS
```

Expected: builds and installs `google-suite` without touching the previously-installed
Gmail/Calendar/Tasks/Keep/Messages/Tidal/Messenger binaries.

- [ ] **Step 2: Launch with a debugging port**

```bash
~/.local/lib/google-suite/google-suite --remote-debugging-port=9222 &   # Linux
# or: ~/Applications/Google\ Suite.app/Contents/MacOS/Google\ Suite --remote-debugging-port=9222 &
curl -s http://127.0.0.1:9222/json/list | python3 -m json.tool
```

Expected: exactly 5 `page` targets, one per service, each at its real URL (`mail.google.com`,
`calendar.google.com`, `tasks.google.com/tasks/`, `keep.google.com`, `messages.google.com/web/`)
— not a redirected/embedded variant.

- [ ] **Step 3: Screenshot each window (per CLAUDE.md's `cdp.mjs` recipe)**

For each target in the list, connect over its `webSocketDebuggerUrl` and call
`Page.captureScreenshot`, then look at the image: confirm each shows its own real chrome
(sidebar, account UI), not a blank or half-rendered page.

- [ ] **Step 4: Confirm the shared partition**

Sign into slot 1 in one service window (say, Gmail). Reload the other four slot-1 windows and
confirm they come up authenticated with no separate sign-in — this proves the five services
share one `persist:account-1` cookie jar now that they're one process.

- [ ] **Step 5: Confirm migration from the existing standalone apps**

Before this step, one of the five currently-installed standalone apps should already have a
signed-in session for some account. Open the Suite's corresponding service window for an
unused slot, and confirm it reaches Google sign-in, then (per `session-sync`'s existing
adopt-on-auth behavior) gets signed in automatically without a manual login. If it does not,
the likely cause is the macOS Keychain round-trip in `session-sync.js`'s `getKey()` failing —
check the log line it emits (`no working keyring backend...` vs `ready (keyring: keychain)`)
before assuming the merge itself is broken.

- [ ] **Step 6: Confirm the CSS probe (Task 4)**

Temporarily add `:root { --probe: yes; }` to `styles/gmail.css`, rebuild, and confirm
`getComputedStyle(document.documentElement).getPropertyValue('--probe')` reads `yes` in the
Gmail window but empty in the Calendar window. Revert the temporary CSS afterward.

- [ ] **Step 7: Confirm notification identity**

Trigger a test notification from the Help menu in one service window and confirm its title
names the originating service (per Task 4's mitigation for the shared-sender regression).

- [ ] **Step 8: Confirm the process-count win**

```bash
ps aux | grep -c "[g]oogle-suite"        # Linux
# or: ps aux | grep -c "[G]oogle Suite"  # macOS
```

Expected: one shared set of helper processes for all 5 windows, where 5 separate standalone
launches would show 5 independent sets. Compare against the same count for one of the
already-installed standalone apps (e.g. `ps aux | grep -c "[k]eep"`) to see the per-app
baseline this replaces.

- [ ] **Step 9: Confirm Tidal and Messenger are unaffected**

Launch each and confirm unchanged behavior — this plan makes no code change that a
single-service `SERVICES` array (Task 1's fallback path) doesn't already cover, but this
step is the actual proof, not an assumption.

- [ ] **Step 10: Close the debug-port instance and relaunch normally**

Per CLAUDE.md: always close the `--remote-debugging-port` instance and relaunch without it
when done, since it leaves an open localhost debugging socket otherwise.

- [ ] **Step 11: Retire the standalone installs (only after all of the above hold)**

```bash
./build-linux.sh --uninstall gmail calendar tasks keep messages
```

`--uninstall` leaves signed-in sessions in `~/.config/<App Name>/` alone, so this is
non-destructive even if the Suite needs to be rolled back later.

---

## Self-Review Notes

- **Spec coverage:** every section of the spec (grouping, shared jar, config model, window
  model, routing, CSS, notifications, migration, build side, rollout/verification) maps to a
  task above; the spec's two explicitly-deferred "open items" (suite-group syntax, per-service
  reopen menu) are resolved concretely in Tasks 7 and 9 rather than left open.
- **Placeholder scan:** no TBD/TODO; every code step is complete, runnable code; Task 11's
  icon is explicitly a placeholder graphic, not a placeholder instruction.
- **Type/name consistency:** `windowKey`/`parseWindowKey` (Task 2) are the only place the
  composite key format is constructed, and Tasks 6 and 8 both import them rather than
  reimplementing `slug + ':' + slot`. `openAccountWindow` is renamed to `openAccountSlot`
  consistently across Tasks 7 and 8 (menu.js's actions object and main.js's definition and
  every call site). `SERVICES`, `findServiceForHost`, and `isFirstPartyUrl`/`isFirstPartyHost`
  keep the same signatures everywhere they're consumed (Tasks 3, 4, 5, 7, 8).
