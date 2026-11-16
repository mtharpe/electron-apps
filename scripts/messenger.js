/* Loaded automatically by the app whose slug is "messenger", on pages served by its own host.
 *
 * Posts a desktop notification when a message arrives. Facebook sends its message
 * notifications only as web push, and Electron has no push service: measured,
 * pushManager.subscribe() rejects with "AbortError: Registration failed - push service not
 * available". Facebook does not even try in this app -- no service worker, no subscribe, no
 * permission request on a full reload -- so no setting on Facebook's side can turn them on.
 *
 * The chat list is the one thing that reliably updates: the page keeps its own live
 * connection and moves a conversation to the top, with its name in bold, when something new
 * arrives. So this watches the list and notifies for a bold (unread) conversation whose
 * preview changed. Bold rather than the hidden "Unread message:" label, which is English-only.
 *
 * Notifications go through the page's own Notification, so preload.js's click hook raises
 * this window, and the click handler here opens the conversation it was about.
 */
(function () {
  'use strict';
  if (window.__messengerNotify) return;
  window.__messengerNotify = true;

  const ROW = 'a[href*="/messages/t/"]';
  // A change is held this long before it is announced, and dropped if the conversation was
  // read meanwhile -- on the phone, say. It also folds a quick run of messages into one.
  const SETTLE_MS = 3000;
  // After a banner, a conversation stays quiet this long; whatever arrives in between is
  // announced once, as its latest message, when it ends. A back-and-forth posted one banner
  // per message before this (five in one minute, in the log).
  const QUIET_MS = 60000;
  // The list is checked every 2s while it is in use. A hidden window with nothing waiting does
  // not need that; 12s still finds an arrival well inside QUIET_MS, and the slow poll is what
  // keeps a background app from forcing layout every 2s.
  const VISIBLE_MS = 2000;
  const HIDDEN_MS = 12000;

  const seen = new Map(); // conversation href -> last preview observed while unread
  const chats = new Map(); // href -> { pending, unannounced, since, lastAt, latest, banner }
  // readRow walks every leaf in a row and forces layout for each (getBoundingClientRect). The
  // list is ~20 rows and the page mutates constantly, so a cheap signature gates it: a row is
  // re-read only when its text length, class or aria label changed.
  const sigs = new Map(); // href -> last cheap row signature
  const parsed = new Map(); // href -> last readRow result, or null when read
  let primed = false;

  const shown = (el) => el.getBoundingClientRect().width > 1 && !el.closest('[aria-hidden="true"]');
  const leaves = (row) => Array.from(row.querySelectorAll('span, div'))
    .filter((n) => n.childElementCount === 0 && n.textContent.trim() && shown(n));

  // Messenger puts a relative timestamp after the preview, normally set off by an aria-hidden
  // "·". Some rows render without the separator. Recognising it by shape -- a whole token,
  // never a substring -- keeps the ticking time out of the preview without eating a message
  // that merely ends in "5m".
  const isTimestamp = (text) => {
    const t = text.trim();
    return /^\d{1,2}:\d{2}(?:\s*[AP]M)?$/i.test(t)
      || /^\d+\s*[smhdwy]$/i.test(t)
      || /^(?:just now|yesterday|today)$/i.test(t)
      || /^(?:monday|mon|tuesday|tues|tue|wednesday|weds|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat|sunday|sun)$/i.test(t)
      || /^(?:january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)\.?\s+\d{1,2}(?:,?\s*\d{4})?$/i.test(t);
  };

  // A preview that differs only by a trailing timestamp token is the same message: the
  // relative time ticks every minute, and on a row without the "·" it can land in the preview.
  // This backstops readRow if the timestamp could not be identified there.
  const settle = (text) => {
    if (isTimestamp(text)) return '';
    const m = /^(.*\S)\s+(\S+)$/.exec(text);
    return m && isTimestamp(m[2]) ? m[1] : text;
  };
  const samePreview = (a, b) => a === b
    || (typeof a === 'string' && typeof b === 'string' && settle(a) === settle(b));

  // Name and preview, read by structure. The first draft took the longest line of the row's
  // innerText as the preview, and that line is often not the message: innerText includes a
  // screen-reader-only presence label (1px wide, toggling as the friend comes and goes) and
  // the relative timestamp ("23m"). For a short message either is longer -- so the banner
  // read "23m", and the same unread chat was announced again every minute as it ticked.
  // Measured on the live list: the name is the first bold leaf, and the timestamp is the
  // first visible leaf after an aria-hidden "·". The preview is the visible text left over.
  const readRow = (row) => {
    const visible = leaves(row);
    const nameEl = visible.find((n) => Number(getComputedStyle(n).fontWeight) >= 600);
    if (!nameEl) return null;
    const sep = Array.from(row.querySelectorAll('[aria-hidden="true"]'))
      .find((n) => n.textContent.trim() === '·');
    let time = sep && visible.find((n) => sep.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING);
    if (!time) {
      // No separator: the timestamp is still a visible leaf after the name. Take the last one
      // that looks like a time rather than the last leaf outright, so a row whose preview
      // really is the final text keeps it. Requiring another leaf after the name keeps a
      // preview that is itself a time-like word ("Sunday") from being eaten when there is no
      // timestamp to distinguish it from.
      const after = visible.filter((n) => n !== nameEl
        && (nameEl.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING));
      const tail = after.filter((n) => isTimestamp(n.textContent)).pop();
      if (tail && after.length > 1) time = tail;
    }
    const parts = [];
    const walk = document.createTreeWalker(row, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      // Emoji render as <img alt="😂">; without this an emoji-only message has no preview.
      if (n.nodeType === 1) { if (n.tagName === 'IMG' && n.alt && shown(n)) parts.push(n.alt); continue; }
      if (!n.textContent.trim() || !shown(n.parentElement)) continue;
      if (nameEl.contains(n) || (time && time.contains(n))) continue;
      parts.push(n.textContent.trim());
    }
    return { name: nameEl.textContent.trim(), preview: parts.join(' ') };
  };

  const open = (href) => {
    const row = document.querySelector('a[href="' + CSS.escape(href) + '"]');
    // The list link drives Facebook's own router; a location change would reload the app.
    if (row) row.click();
    else location.href = href;
  };

  // This conversation is on screen in a visible window, focused or not (a second monitor), so
  // the user is reading it and there is nothing to announce.
  const chatOpen = (href) => document.visibilityState === 'visible'
    && location.pathname === new URL(href, location.href).pathname;

  const chat = (href) => {
    if (!chats.has(href)) chats.set(href, { pending: false, unannounced: false, since: 0, lastAt: 0, latest: null, banner: null });
    return chats.get(href);
  };

  const closeBanner = (c) => {
    if (!c.banner) return;
    try { c.banner.close(); } catch (e) { /* already gone */ }
    c.banner = null;
  };

  const post = (href, c) => {
    closeBanner(c);
    try {
      const n = new Notification(c.latest.name, { body: c.latest.preview.slice(0, 200), tag: href });
      n.addEventListener('click', () => open(href));
      n.addEventListener('close', () => { if (c.banner === n) c.banner = null; });
      c.banner = n;
    } catch (e) { /* a notification is a nicety; never break the page */ }
  };

  // textContent length catches a new preview; the class and aria label catch read/unread,
  // which changes styling and state without changing the message text. Neither runs layout.
  const signature = (row) => row.textContent.length + '|' + (row.className || '') + '|' + (row.getAttribute('aria-label') || '');

  const scan = () => {
    const now = Date.now();
    const rows = Array.from(document.querySelectorAll(ROW));
    const present = new Set();
    rows.forEach((row, index) => {
      const href = row.getAttribute('href');
      if (!href) return;
      present.add(href);
      const sig = signature(row);
      if (sigs.get(href) !== sig) {
        sigs.set(href, sig);
        parsed.set(href, readRow(row));
      }
      const unread = parsed.has(href) ? parsed.get(href) : null;
      if (!unread) {
        // Read -- here or on another device. Its banner is stale now; take it down, and drop
        // the entries that only exist while this conversation is unread.
        seen.delete(href);
        if (chats.has(href)) { closeBanner(chats.get(href)); chats.delete(href); }
        return;
      }
      const known = seen.has(href);
      if (!samePreview(seen.get(href), unread.preview)) {
        seen.set(href, unread.preview);
        // The first pass only learns what is already unread; that is old news, not an
        // arrival. A row seen for the first time is an arrival only near the top -- further
        // down it is an old unread conversation the list just rendered because the user
        // scrolled.
        if (primed && (known || index <= 2)) {
          const c = chat(href);
          if (!c.pending) { c.pending = true; c.since = now; }
          c.latest = unread;
        }
      }
    });
    // The list virtualises rows that scroll out; their parsed state would only grow. `seen` is
    // kept for them, because it is what tells a returning row apart from a new arrival.
    for (const href of sigs.keys()) if (!present.has(href)) sigs.delete(href);
    for (const href of parsed.keys()) if (!present.has(href)) parsed.delete(href);

    chats.forEach((c, href) => {
      if (chatOpen(href)) {
        c.pending = false;
        c.unannounced = false;
        return;
      }
      if (document.hasFocus()) {
        // The app is focused but this conversation is not open. A banner would interrupt
        // someone already in the list, so hold it back -- but remember it was never
        // announced: if the window loses focus while the chat is still unread, it still
        // needs to be announced (and the seen preview will not change again to re-arm it).
        if (c.pending) { c.pending = false; c.unannounced = true; }
        return;
      }
      if (c.unannounced && present.has(href) && seen.has(href)) {
        c.unannounced = false;
        c.pending = true;
        c.since = now;
      }
      if (!c.pending) return;
      if (now - c.since < SETTLE_MS || now - c.lastAt < QUIET_MS) return;
      c.pending = false;
      c.lastAt = now;
      post(href, c);
    });
    // Not until the list has rendered: a pass over an empty list would learn nothing, and the
    // next one would announce every unread conversation.
    if (rows.length) primed = true;
  };

  const anyPending = () => {
    let pending = false;
    chats.forEach((c) => { if (c.pending) pending = true; });
    return pending;
  };

  // A timer, not a MutationObserver on Facebook's whole tree: the list is ~20 links, and the
  // page mutates constantly. Background timers keep running (main.js disables throttling).
  // When the window is hidden and nothing is waiting, poll slowly; a pending chat always gets
  // the fast cadence, so its settle and quiet windows are honoured on time.
  const tick = () => {
    scan();
    setTimeout(tick, document.hidden && !anyPending() ? HIDDEN_MS : VISIBLE_MS);
  };
  setTimeout(tick, VISIBLE_MS);
})();
