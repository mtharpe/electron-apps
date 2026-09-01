// Per-webContents adjustments to the page itself: the app's own stylesheet, the window
// title, and the right-click menu. All three are attached to EVERY webContents (see
// main.js's web-contents-created hook), not just the first window, because switching
// accounts opens a new one that needs them just as much.
const path = require('path');
const fs = require('fs');
const { app, Menu, BrowserWindow, clipboard } = require('electron');
const { ROOT, APP_SLUG, APP_HOST } = require('./config');
const { hasSuffix } = require('./util');
const { accountLabel, slotOf, ACCOUNT_TITLE_JS } = require('./accounts');

// Per-app CSS. Two sources, both optional, concatenated in this order:
//
//   styles/<slug>.css                 shipped with the app (styles/gmail.css hides Workspace
//                                     Gmail's Mail/Chat/Meet/Spaces rail, for example)
//   <userData>/custom.css             the user's own, not overwritten by a rebuild
//
// This used to be a Gmail-specific constant and a hostname test hardcoded in this file.
// Nothing about "restyle this app's pages" is Gmail-specific, and a wrapper for a
// non-Google app is just as likely to want a rule, so it is a file convention now.
//
// Injected as a stylesheet rather than an inline style so it survives the page's re-renders.
let CUSTOM_CSS = '';

// Read once, after app.setName() — userData is named after the app, so the path is not
// stable before then.
function loadCustomCss() {
  const parts = [];
  const sources = [
    APP_SLUG ? path.join(ROOT, 'styles', APP_SLUG + '.css') : null,
    path.join(app.getPath('userData'), 'custom.css'),
  ];
  for (const file of sources) {
    if (!file) continue;
    // __dirname is inside the asar in a packaged build; Electron patches fs to read it.
    try { parts.push(fs.readFileSync(file, 'utf8')); } catch (e) { /* absent is the normal case */ }
  }
  CUSTOM_CSS = parts.join('\n');
}

// Re-apply on every document load. This must cover EVERY webContents, not just the first
// account window: picking another account from an account switcher opens it in a NEW window,
// and that window needs the rule too. Registered globally below via 'web-contents-created'.
function applyCustomStyles(wc) {
  wc.on('dom-ready', () => {
    if (!CUSTOM_CSS) return;
    try {
      if (hasSuffix(new URL(wc.getURL()).hostname, [APP_HOST])) wc.insertCSS(CUSTOM_CSS);
    } catch (e) { /* ignore */ }
  });
}

// Gmail rewrites its document title on every unread-count change, and each one used to cost
// a synchronous-looking round trip into the renderer to re-scrape the account name. Coalesce
// the burst: the title we want is derived from the account, not from the count, so the last
// event in a flurry is the only one worth answering. Short enough to be imperceptible.
const TITLE_SETTLE_MS = 250;

function manageWindowTitle(wc) {
  let settleTimer = null;
  let lastApplied = null;

  const setTitle = (label) => {
    if (!label || label === lastApplied) return; // nothing changed — skip the native call
    const win = BrowserWindow.fromWebContents(wc);
    if (win && !win.isDestroyed()) { win.setTitle(label); lastApplied = label; }
  };

  const apply = () => {
    // A configured account name (or the name of the Chrome profile it maps to) is a
    // deliberate choice by the user and outranks anything scraped from the page.
    const pinned = accountLabel(slotOf(wc));
    if (pinned) { setTitle(pinned); return; }
    wc.executeJavaScript(ACCOUNT_TITLE_JS, true)
      .then(setTitle)
      .catch(() => { /* ignore */ });
  };

  const applySoon = () => {
    if (settleTimer) return;
    settleTimer = setTimeout(() => { settleTimer = null; apply(); }, TITLE_SETTLE_MS);
  };

  // Stop Electron from auto-applying Google's full page title, then set our short one.
  wc.on('page-title-updated', (e) => { e.preventDefault(); applySoon(); });
  // A fresh document gets the immediate path: there is no burst to coalesce, and waiting
  // would leave the window showing the PREVIOUS page's title for a beat.
  wc.on('dom-ready', () => { lastApplied = null; apply(); });
  wc.on('destroyed', () => { if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; } });
}

// Spell checking was only ever half-present. webPreferences.spellcheck is on, and Chromium
// does mark misspellings — measured in Google Messages (a bare <textarea>, so spellcheck
// defaults on) and Messenger (spellcheck="true" on its composer), both showing red
// underlines, both with an en-US .bdic downloaded into their profile. But Electron ships NO
// default context menu, so right-clicking an underlined word did nothing at all: no
// suggestions, no way to apply one, no way to teach it a word. The squiggle was the entire
// feature. That is what this adds.
//
// Built per-event, not once at startup: every item depends on what was clicked, and
// dictionarySuggestions is only populated when the cursor is actually over a misspelling.
function attachContextMenu(wc) {
  wc.on('context-menu', (event, params) => {
    const spelling = params.dictionarySuggestions.map((word) => ({
      label: word,
      click: () => wc.replaceMisspelling(word),
    }));
    if (params.misspelledWord) {
      // Chromium returns no suggestions for a word it cannot get close to. Saying so beats
      // a menu that silently drops its top section and looks like nothing happened.
      if (spelling.length === 0) spelling.push({ label: 'No suggestions', enabled: false });
      spelling.push({
        label: 'Add to Dictionary',
        // Per-session, so the word lands in THIS app's profile. Each app has its own
        // userData dir, so a word taught to Messenger is not known to Gmail.
        click: () => wc.session.addWordToSpellCheckerDictionary(params.misspelledWord),
      });
    }

    const link = params.linkURL
      ? [{ label: 'Copy Link', click: () => clipboard.writeText(params.linkURL) }]
      : [];

    // Roles, not hand-rolled clipboard calls: the role handlers target the focused frame,
    // which is what was right-clicked, and get contenteditable/selection semantics right.
    const { editFlags } = params;
    const edit = params.isEditable || params.selectionText
      ? [
        { role: 'cut', enabled: editFlags.canCut },
        { role: 'copy', enabled: editFlags.canCopy },
        { role: 'paste', enabled: editFlags.canPaste },
        { role: 'selectAll', enabled: editFlags.canSelectAll },
      ]
      : [];

    // Join non-empty sections with separators, rather than emitting separators inline —
    // inline ones strand a divider at the top or bottom whenever a section turns out empty.
    const template = [];
    for (const section of [spelling, link, edit]) {
      if (section.length === 0) continue;
      if (template.length > 0) template.push({ type: 'separator' });
      template.push(...section);
    }
    if (template.length === 0) return; // nothing actionable — don't flash an empty menu

    Menu.buildFromTemplate(template).popup({ window: BrowserWindow.fromWebContents(wc) });
  });
}

module.exports = { loadCustomCss, applyCustomStyles, manageWindowTitle, attachContextMenu };
