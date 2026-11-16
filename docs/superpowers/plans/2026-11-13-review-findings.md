# Review Findings Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. Each agent owns a disjoint file set — do not edit files outside your workstream.

**Goal:** Resolve the consolidated findings from the 10-slice code review (bugs, security, performance, functionality) without regressing documented, load-bearing behaviour.

**Architecture:** Nine file-disjoint workstreams (A–I) executed in parallel, then integrated, checked (`node --check`, `bash -n`, `node --test`), and committed in logical batches by the orchestrator.

**Tech Stack:** Electron 42 (castlabs fork), plain Node CJS under `main.js`/`lib`/`preload.js`, bash 3.2-compatible installers, an empty `test/` (to gain `node --test`).

**Spec:** the consolidated review in this session (High/Medium/Low lists + performance/functionality tables).

## Global Constraints

- Never edit a file outside your workstream (exclusive ownership — concurrent editors would clobber each other).
- Do **not** run any `git` command (no add/commit/branch/push) or start a build (`./build-linux.sh`, `./build.sh`). The orchestrator commits.
- No network access; never run `npm install`.
- Preserve the deliberate designs documented in `CLAUDE.md` (acyclic module graph via injection, `contextIsolation:false`+`sandbox:true`, castlabs pin, slug↔productName, bash 3.2).
- Bash scripts stay bash 3.2 compatible: no `declare -A`, no `mapfile`, no bare empty-array expansion under `set -u`.
- Comments explain *why*, not mechanics; do not add narration.
- Verify each edited JS file with `node --check <file>`; each shell script with `bash -n <file>`; run `node --test` if tests exist.
- **Do not delete any file** (the archive migration rules forbid deletion without the user asking).
- Where a fix needs a file you do not own, implement your side and record the needed cross-file change in your report instead of editing it.

## Workstream ownership (disjoint)

| WS | Files (exclusive) | Focus |
|----|-------------------|-------|
| A | `lib/routing.js`, `lib/util.js`, `lib/chromium.js`, `lib/handoff.js`, `lib/handlers.js` | Trust/permission boundary, redirect gating, UA arch |
| B | `session-sync.js` | SSO identity, key lock, EPIPE, races |
| C | `main.js`, `lib/recovery.js`, `lib/window-registry.js`, `lib/window-restore.js`, `lib/config.js` | Lifecycle, Widevine gate, crash recovery, geometry |
| D | `lib/accounts.js`, `accounts.html`, `accounts-preload.js` | Migration, locking, parsing, a11y |
| E | `lib/theme.js`, `lib/page-tweaks.js`, `lib/menu.js` | Theme latency/loops, path-scoped injection |
| F | `preload.js`, `lib/notifications.js` | Focus proxy, scrub, notification IPC |
| G | `build-linux.sh`, `build.sh`, `select-services.sh`, `prereqs.sh`, `services.conf`, `package.json` | Packaging, zip integrity, quoting, tests |
| H | `scripts/gmail.js`, `scripts/messenger.js` | Delete scope, poll cost |
| I | `CLAUDE.md` | Doc drift |

## Review Focus (most likely to bite a user)

1. Web content on a user-content host (`*.googleapis.com`, `*.googleusercontent.com`) reaching camera/mic/clipboard — must be denied.
2. A server redirect escaping the in-app gate into the stealth renderer — must be routed out.
3. Signing a different account into a slot being filed under the old email — must refuse to publish unverified identity.
4. A DRM renderer created before the CDM exists — must never happen.
5. Clearing an account name silently reverting — must persist.

## Tasks

### Task A — Security boundary (routing/util/chromium/handoff/handlers)
- Drop `googleapis.com`/`googleusercontent.com` from first-party **permission** trust; keep `google.com`/`gstatic.com`/own-host/related. Do not use naive `APP_DOMAIN` for permission grants.
- Gate `will-redirect`: allow same-origin/allowlisted viewer/auth, send cross-origin escapes to the browser; preserve messenger rewrite and Facebook sign-in.
- Move `shimTarget` before the in-app early-return in `will-navigate`.
- Switch the three nav events to the `details` object (fail *closed* if URL missing).
- Treat `%2f`/`%5c`/`%00` in pathname as out-of-scope for path-scoped apps.
- Replace `leadsBackToApp` substring test with parsed-host comparison; guard empty `APP_DOMAIN`.
- Reuse/dedupe viewer windows (bounded), guard `new URL` in the log line.
- Fix `APP_DOMAIN` comment; add `parseHostList` to `util.js`; remove dead `prefix+'?'`; keep `hasSuffix` semantics stable.
- `chromium.js`: derive UA CPU token from `process.arch`; restrict non-first-party permissions (`pointerLock`, `fullscreen`, `storage-access`, …) to first-party.
- `handoff.js`: temp+rename atomic write, dir `0700`, validate slug `^[a-z0-9][a-z0-9-]*$`.
- `handlers.js`: replace all `%s`, not just the first; document comma limitation.

### Task B — SSO (session-sync.js)
- Publish only under live-verified identity: snapshot email before/after, scrape the slot window when open, skip+log on mismatch; compare emails case-insensitively.
- `child.stdin.on('error')` before `end()`.
- Key lock: owner token verified on release; wait > stale; re-adopt on timeout instead of unlocked create.
- Retry adoption when `enabled` flips true (buffer pending auth navs).
- Remove `__Host-GAPS` from the session hash; case-insensitive payload check.
- Rejection guards on fire-and-forget async; `fs.watch` `'error'`; temp cleanup + init sweep; `execFile` timeout; hash emails in logs; bound slot loops by `WINDOW_SLOTS`.

### Task C — Lifecycle (main/recovery/registry/restore/config)
- Gate `second-instance` on startup completion (Widevine wait).
- `.catch(logRecovery)` on every `loadURL`/`loadFile`.
- Move single-instance lock to just after `app.setName`; move heavy side effects after it.
- `activate` uses `getLaunchSlots()` else `[1]`; second-instance fallback prefers slot registry; `focusWindow` restores minimized windows.
- Sender check on `accounts:*`; skip unchanged rows in `accounts:save`; re-read accounts when opening the window; preserve a pinned profile when `chromeProfiles()` is empty.
- Remove the redundant `buildMenu()` after `refreshAccountPresentation()`.
- Add `render-process-gone`/`unresponsive` recovery (reuse `scheduleReload`, bounded).
- Recovery: cancel a pending retry when a different main-frame navigation starts; cap attempts + jitter.
- Resume reloads only account windows (slot map), not pop-outs/Accounts.
- `window-restore`: macOS last-close clears slots; persist `{maximized,bounds,zoom}` per slot and apply after reveal; coalesce writes.
- `config.js`: clear error if `app-config.json` missing; validate `name`/https `url`.

### Task D — Accounts data/UI (accounts.js/accounts.html/accounts-preload.js)
- Legacy migration one-shot (marker); never fill fields on an existing slot (only absent slots).
- Avoid empty-record persist↔reload loop.
- Stale-lock break via rename + inode/ctime verification.
- Quarantine a file only on parse/shape error; on I/O error skip the write.
- Canonical slot keys `^[1-9][0-9]*$`; cap `name` at 64.
- Coerce `chromeProfiles` string fields.
- Reduce the `Atomics.wait` deadline (500→50ms) / skip write past it.
- `accounts.html`: `aria-label`s on inputs/select, table `<caption>`.

### Task E — Theme/page-tweaks/menu
- `GTK_THEME` without a variant: set `appliedGtkVariant` from the resolved scheme or suppress the restart prompt.
- Resolve the colour scheme once, memoise the portal read, shorten timeouts; keep `applyGtkTheme(scheme?)` backward compatible.
- Repaint the Accounts window on theme change.
- Portal watcher `'exit'` retry + buffer partial lines before matching.
- Path-scope CSS/script injection using `cfg.paths`; return early when `APP_HOST` is empty; `.catch()` on `insertCSS`.

### Task F — Stealth/notifications
- Gate the `window.focus` proxy on a real notification-click flag.
- Per-property scrub via `Reflect.deleteProperty`.
- Real full version in `uaFullVersion`/`fullVersionList`; forward `newTarget`; bound `shown`.
- Fix the "non-sandboxed" comment.
- `mirror-notification`/`notification-focus`: verify sender origin against a first-party host set computed from config (avoid requiring routing — cycle); bound/coerce title/body; try/catch `show()`; bound `live`; sanitize `data` keys in logs; capture slot for click focus.

### Task G — Build/install
- Add `^/\.claude($|/)`, `^/CLAUDE-SECURITY-`, `^/\.superpowers($|/)` to `PACKAGER_IGNORES`.
- Re-extract PNG when `.icns` is newer.
- Zip: `mktemp` part, `unzip -t`, verify SHA-256 against `node_modules/electron/checksums.json` when present, `--proto '=https'`, trap cleanup.
- Visible `codesign` failure; `build.sh` EXIT trap cleanup; `mkdir -p ~/Applications`; `bash` not `exec` for Linux dispatch.
- Remove/adjust `ARCH=universal` claim; join `ELECTRON_MIRROR` with `/`.
- Quote/escape `.desktop` `Exec=`; reject control chars.
- Selection: comma-only split under `set -f`; `slugify` via `printf` and reject empty; `10#` for menu numbers; guard `read` under `set -e`; re-check node version after install.
- `usage()` uses `${BASH_SOURCE[0]}`.
- `install_icons`: fall through on ImageMagick failure.
- Stage installs before uninstall (or uninstall after copy succeeds).
- `package.json`: add `"test": "node --test test/"`; add `test/util.test.js` for `hasSuffix`/`pathUnder`.
- Do **not** delete `set-messages-icon.sh`.

### Task H — Page scripts
- Gmail Delete: only act when focus is in the message list/reading pane; exclude interactive controls.
- Messenger: cheap row signature before expensive reads; slow poll when hidden with nothing pending; prune maps; timestamp-safe preview; re-arm a focus-cleared pending when the window later blurs unread.

### Task I — Docs
- Add `lib/handlers.js` to the file table; refresh `main.js` line count; note `build.sh` does not rewrite `productName`.

## Verification

- `node --check` every edited `.js`; `bash -n` every edited `.sh`.
- `node --test test/` green.
- Orchestrator then reviews the combined diff, commits per workstream, and reports verified vs unverified.
