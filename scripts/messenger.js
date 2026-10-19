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
  const seen = new Map(); // conversation href -> last preview text notified or observed
  let primed = false;

  const leaves = (row) => Array.from(row.querySelectorAll('span, div'))
    .filter((n) => n.childElementCount === 0 && n.textContent.trim() && n.getBoundingClientRect().width > 1);

  // Name and preview from what is visible in the row: the bold leaf is the name; the preview is
  // the longest remaining visible line (the timestamp and "·" are always short).
  const readRow = (row) => {
    const bold = leaves(row).find((n) => Number(getComputedStyle(n).fontWeight) >= 600);
    if (!bold) return null;
    const name = bold.textContent.trim();
    const preview = (row.innerText || '').split('\n').map((l) => l.trim())
      .filter((l) => l && l !== name)
      .sort((a, b) => b.length - a.length)[0] || '';
    return { name, preview };
  };

  const open = (href) => {
    const row = document.querySelector('a[href="' + CSS.escape(href) + '"]');
    // The list link drives Facebook's own router; a location change would reload the app.
    if (row) row.click();
    else location.href = href;
  };

  const scan = () => {
    const rows = Array.from(document.querySelectorAll(ROW));
    rows.forEach((row, index) => {
      const href = row.getAttribute('href');
      const unread = readRow(row);
      if (!unread) { seen.delete(href); return; }
      const known = seen.has(href);
      if (seen.get(href) === unread.preview) return;
      seen.set(href, unread.preview);
      // The first pass only learns what is already unread; that is old news, not an arrival.
      // Nor while the window is focused: the user is looking at the list already. A row seen
      // for the first time is an arrival only near the top -- further down it is an old
      // unread conversation the list just rendered because the user scrolled.
      if (!primed || document.hasFocus() || (!known && index > 2)) return;
      try {
        const n = new Notification(unread.name, { body: unread.preview.slice(0, 200), tag: href });
        n.addEventListener('click', () => open(href));
      } catch (e) { /* a notification is a nicety; never break the page */ }
    });
    // Not until the list has rendered: a pass over an empty list would learn nothing, and the
    // next one would announce every unread conversation.
    if (rows.length) primed = true;
  };

  // A timer, not a MutationObserver on Facebook's whole tree: the list is ~20 links, and the
  // page mutates constantly. Background timers keep running (main.js disables throttling).
  setInterval(scan, 2000);
})();
