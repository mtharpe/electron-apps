# Google Suite process merge

## Problem

Every installed app here is one Electron binary, and every Electron binary is a full,
independent Chromium multi-process tree: main process, GPU process, network service,
crashpad handler, a zygote helper on Linux, and one renderer per open account-slot window.
With `services.conf` currently listing 7 services, running them all side by side means 7
independent copies of that overhead, none of it shared.

Five of those services — Gmail, Calendar, Tasks, Keep, Messages — are the same shape: same
Google-account multi-login model, no DRM, no path-scoped routing, no related-domain quirks.
They are the source of most of the duplication and the best candidates to consolidate.
Tidal (DRM, pays a Widevine CDM wait) and Messenger (path-scoped routing tied to its own
Facebook-hosted domain) are outliers and stay separate.

## Goal

Merge Gmail, Calendar, Tasks, Keep, and Messages into one Electron process — one installed
binary, one dock/taskbar icon, called "Google Suite" — cutting process trees for these five
from 5 down to 1. Combined with Tidal and Messenger remaining standalone, total process
trees go from 7 to 3.

## Non-goals

- Merging Tidal or Messenger into the shared process. Tidal's DRM wait would otherwise be
  paid by every window in the shared process; Messenger's path-scoped routing is bespoke
  enough to keep isolated.
- Preserving separate OS-level identity (WM_CLASS / dock icon / notification sender) for the
  five merged services. This is not achievable regardless of implementation effort — see
  "Why this can't be done without merging identity" below.
- Rewriting the account-slot model. A slot still means one person; it does not become
  per-service.

## Why this can't be done without merging identity

On Linux, taskbar grouping (`WM_CLASS`) and the desktop-entry notification identity are
derived from `productName` / `app.setName()`, which is process-wide — Electron has no
per-window override. On macOS, the Dock icon and app-switcher entry belong to the running
process/bundle, not to individual windows. Both platforms tie "separate icon" to "separate
process" at the OS level; no Electron API or Chromium flag changes that. Accepting one dock
icon per merged group is the necessary cost of sharing a process, not an implementation gap.

## Design

### Grouping and the free win

Merging these five into one process means they share one `userData` directory. Today,
`persist:account-N` partitions are only isolated *between* apps because each app has its own
`userData` — `session-sync.js` exists specifically to copy Google auth cookies between those
separate jars for what is supposed to be "the same account in slot N everywhere." Once the
five services share a process, `persist:account-N` becomes **one real, shared cookie jar**
across all five automatically — true single sign-on for this group, with no code required to
produce it. This also makes literal an assumption `session-sync.js` already documents but
never enforced: "slot N in two apps is supposed to be the same account."

`session-sync.js` keeps two jobs after the merge:
- Sharing a Google session out to Tidal's "Continue with Google" button (Tidal stays a
  separate process).
- Migrating in whatever session already exists from the currently-installed separate apps
  the first time a Suite window hits Google sign-in (see Migration below).

### Config model

`app-config.json` for a suite build carries `services: [{slug, name, url, icon, related,
paths}, ...]` instead of one `url`/`slug` pair. `lib/config.js` exposes a `SERVICES` array in
both cases: for a suite build it comes straight from `cfg.services`; for a single-service
build (Tidal, Messenger, or any future standalone) it is synthesized as a one-entry array
from today's fields. Downstream modules stop special-casing "the one app" and instead loop
over `SERVICES`, so the same code path serves both build shapes — a single-service build is
just the `SERVICES.length === 1` case of the general one.

### Window model

`lib/window-registry.js`'s `windows` map changes key from `slot` (a number) to
`"<serviceSlug>:<slot>"` (a string). Every consumer moves from taking a bare slot to taking a
`(serviceSlug, slot)` pair:

- `main.js`'s `openAccountWindow` becomes service-aware; opening slot N opens all five
  service windows for that person at once — a slot is still one person, now presented across
  five windows instead of one. Closing one service's window for that slot doesn't affect the
  others; a lightweight per-service reopen action (e.g. under a new "Services" menu) recovers
  a closed one without recreating the whole slot.
- `accounts.js`'s `refreshAccountPresentation` iterates the composite keys, extracting the
  slot to resolve each window's title the same way it does today.
- `session-sync.js`'s `windowsForSlot(n)` returns every open window across all five services
  for that slot, so publish/adopt keeps working exactly as designed, just aggregating more
  windows per slot than before.

`accounts.json`, `chromeProfiles()`, `slotOf()`, and the Accounts window (`accounts.html` /
`accounts-preload.js`) need **no changes** — slot remains the only identity they deal with.

### Routing

`routing.js`'s per-app constants (`APP_HOST`, `APP_DOMAIN`, `APP_RELATED_HOSTS`,
`APP_PATH_PREFIXES`) are computed per entry in `SERVICES` rather than once globally.
`isFirstPartyUrl` / `isFirstPartyHost` loop across all services: a URL is first-party if it
matches *any* service's own domain (honoring that service's own path-scoping) or *any*
service's related-hosts list. `GOOGLE_HOST_SUFFIXES` and the SSO/IdP suffix list stay global,
as they already apply repo-wide rather than per-app.

None of the five grouped services currently declare `related` or `paths`, so this is a
straightforward generalization with no behavior change for them today — it only starts
mattering if one of them (or a future addition to the group) needs those fields later.

### Page styling and window titles

`page-tweaks.js`'s CSS injection matches the page's current host against each service's own
host before applying that service's shipped stylesheet (`styles/<slug>.css`), so
`styles/gmail.css` still only fires on `mail.google.com`. `<userData>/custom.css` remains one
shared file, but its scope widens from "this one app's host" to "any of the Suite's own
hosts" — a real, minor, and accepted behavior change since the file is user-authored.

`manageWindowTitle` needs no change: `ACCOUNT_TITLE_JS` already branches per-hostname
(`mail.google.com` vs `calendar.google.com`), so per-service window titles keep working
without modification.

### Notifications

Accepted regression: today each app has its own entry in the OS notification settings
(separate desktop-entry / sender identity); after the merge all five show up under one
"Google Suite" sender, since notification identity is exactly as process-bound as
`WM_CLASS`. Mitigation: put the originating service's name in the notification title itself
(e.g. "Gmail: 2 new messages") so context isn't lost even though the OS-level sender is
generic. There is no way to recover distinct per-service OS notification identity without
separate processes.

### Migration

`ACCOUNTS_DIR` (`accounts.json` and the session-sync store) already lives under
`app.getPath('appData')`, not per-app `userData` — meaning it is already shared across the
five currently-installed separate apps today. Consequences for rollout:

- Account names and Chrome-profile mappings in `accounts.json` carry over to the Suite with
  no migration step.
- The first time a Suite window for slot N navigates to Google sign-in,
  `session-sync.adoptForAuth` will find and inject whatever session one of the existing
  separate apps already published for that slot's email — the same mechanism that syncs
  between the separate apps today, now also priming the Suite.
- **Unverified dependency to check during rollout:** the macOS Keychain backend for
  session-sync's encryption key is, per this repo's own documentation, "written to spec and
  made safe by the round-trip" but not measured on real macOS hardware. Since this repo runs
  on macOS, confirm the keyring round-trip actually succeeds here before relying on it for a
  smooth migration — if it doesn't, every slot in the Suite starts signed out and each
  service needs a fresh interactive login.
- The five existing standalone apps' `userData` directories and sessions are left untouched
  by building the Suite. `build-linux.sh --uninstall` already leaves signed-in sessions
  alone, so retiring the standalone installs later is non-destructive.

### Build side

`services.conf` needs a new concept: a named group that references several existing service
rows by slug and produces one binary — its own display name, bundle id, and icon — whose
`app-config.json` carries a `services` array assembled from those rows' existing fields
(`slug`, `url`, `icon`, `related`, `paths`) rather than one top-level `url`. The five existing
Gmail/Calendar/Tasks/Keep/Messages rows are left in place unchanged (so any one of them can
still be built standalone, e.g. for isolated debugging with `--user-data-dir=/tmp/scratch`);
they additionally become members of the new "Google Suite" group.

Both `build-linux.sh` (package, install, `.desktop` + icon ladder, icon-theme resolution) and
`build.sh` (macOS package + ad-hoc codesign) need a suite-aware path that writes the
multi-service `app-config.json` and packages one binary/icon for the group instead of one row
at a time. The exact bash mechanics — staying bash 3.2 compatible, no associative arrays, no
`mapfile` — are left to the implementation plan rather than fixed here.

A new icon (`icons/google-suite.icns` or `icons/png/google-suite.png`) needs to be authored
or sourced for the merged app's own identity, distinct from any one of its five member
services' icons.

## Rollout and verification

Build "Google Suite" alongside the five existing standalone apps first — do not uninstall
anything until it's verified. Using this repo's CDP-based verification recipe
(`docs/superpowers` conventions / CLAUDE.md's "Verifying an app" section):

1. Screenshot each of the five windows and confirm each loaded its real host (not a stale or
   wrong page) and its own chrome (sidebar, account UI).
2. Sign into slot 1 in one service window; confirm the other four windows for slot 1 come up
   already authenticated without a manual reload, proving the shared partition works.
3. Confirm a signed-in session already established in one of the five standalone apps is
   picked up automatically the first time the corresponding Suite window hits Google
   sign-in (the migration path above).
4. Trigger a notification from one service and confirm its title identifies which service it
   came from.
5. Confirm Tidal and Messenger are unaffected — unchanged process count, unchanged behavior.
6. Confirm the Suite is a single process tree in `ps`/Activity Monitor for all five windows,
   where today five separate trees would appear.

Only after all of the above hold would the five standalone installs be retired.

## Open items for the implementation plan

- Exact `services.conf` / build-script syntax for declaring a suite group.
- Exact menu structure for opening/reopening individual service windows within a slot
  (beyond the baseline "opening a slot opens all five").
- Icon sourcing for the new "Google Suite" identity.
