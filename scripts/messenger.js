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

  const seen = new Map(); // conversation href -> last preview observed while unread
  const chats = new Map(); // href -> { pending, since, lastAt, latest, banner }
  let primed = false;

  const shown = (el) => el.getBoundingClientRect().width > 1 && !el.closest('[aria-hidden="true"]');
  const leaves = (row) => Array.from(row.querySelectorAll('span, div'))
    .filter((n) => n.childElementCount === 0 && n.textContent.trim() && shown(n));

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
    const time = sep && visible.find((n) => sep.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING);
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

  // The user is looking at the app, or at this very conversation in a window they can see
  // but have not focused (a second monitor).
  const reading = (href) => document.hasFocus()
    || (document.visibilityState === 'visible' && location.pathname === new URL(href, location.href).pathname);

  const chat = (href) => {
    if (!chats.has(href)) chats.set(href, { pending: false, since: 0, lastAt: 0, latest: null, banner: null });
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

  const scan = () => {
    const now = Date.now();
    const rows = Array.from(document.querySelectorAll(ROW));
    rows.forEach((row, index) => {
      const href = row.getAttribute('href');
      const unread = readRow(row);
      if (!unread) {
        // Read -- here or on another device. Its banner is stale now; take it down.
        seen.delete(href);
        if (chats.has(href)) { const c = chats.get(href); c.pending = false; closeBanner(c); }
        return;
      }
      const known = seen.has(href);
      if (seen.get(href) !== unread.preview) {
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
    chats.forEach((c, href) => {
      if (!c.pending) return;
      if (reading(href)) { c.pending = false; return; }
      if (now - c.since < SETTLE_MS || now - c.lastAt < QUIET_MS) return;
      c.pending = false;
      c.lastAt = now;
      post(href, c);
    });
    // Not until the list has rendered: a pass over an empty list would learn nothing, and the
    // next one would announce every unread conversation.
    if (rows.length) primed = true;
  };

  // A timer, not a MutationObserver on Facebook's whole tree: the list is ~20 links, and the
  // page mutates constantly. Background timers keep running (main.js disables throttling).
  setInterval(scan, 2000);
})();
