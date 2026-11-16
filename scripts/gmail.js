/* Loaded automatically by the app whose slug is "gmail", on pages served by its own host.
 *
 * Makes the Delete key delete the highlighted conversation, the way a desktop mail client
 * does. Gmail has no Delete-key binding of its own.
 *
 * The first version re-sent Delete as "#", Gmail's delete shortcut. That only works where
 * Gmail's "Keyboard shortcuts" setting is on, and the setting is per ACCOUNT: measured, it
 * was on for a personal account and off for a Workspace one, so Delete worked in one window
 * and did nothing in the other. With shortcuts off Gmail ignores even a genuine "#"/"s"
 * keypress, so no way of sending the key could fix it.
 *
 * So Delete presses Gmail's own Delete button instead, which works under either setting. The
 * toolbar shows it whenever there is something to delete — checked conversations, or the
 * one open — and it acts on exactly that. Found by act="10", Gmail's action code for
 * delete, rather than its label, so it does not depend on the UI language.
 *
 * The one thing the button cannot reach is a conversation marked only by the keyboard cursor
 * (j/k), with nothing checked or open — the toolbar hides the button then. That cursor
 * exists only when shortcuts are on, which is also when "#" works, so "#" covers it.
 *
 * Anywhere text can be edited, Delete is left completely alone, and so is any focused control
 * (a toolbar or compose button, a link): Delete there belongs to that control, not to the
 * conversation showing behind it. The decision is made synchronously on the key event itself,
 * so no keystroke is ever delayed or reordered.
 */
(function () {
  'use strict';

  const isEditable = (el) => {
    if (!el || el.nodeType !== 1) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag === 'INPUT') {
      // A checkbox or button has no text for Delete to act on. It is not a text entry point;
      // whether Delete may act at all is decided by inDeleteContext() below.
      return !/^(checkbox|radio|button|submit|reset|image|file|color|range)$/i.test(el.type);
    }
    return /^(textbox|searchbox|combobox|spinbutton)$/.test(el.getAttribute('role') || '');
  };

  // A focused control means Delete belongs to that control, not to the conversation showing
  // behind it: compose's Send, a toolbar action, the account switcher. It is not a text entry
  // point, so isEditable() deliberately lets it through -- this is what stops Delete from
  // trashing the open or selected conversation when the key was aimed at the control.
  const CONTROL_ROLE = /^(button|link|menuitem|menuitemcheckbox|menuitemradio|tab|switch|option|combobox)$/;

  const isControl = (el) => {
    if (el.tagName === 'BUTTON' || el.tagName === 'A') return true;
    const role = el.getAttribute('role') || '';
    if (CONTROL_ROLE.test(role)) return true;
    // The row checkbox is the selection itself, so Delete still means "delete the selected
    // conversation". A checkbox anywhere else is a control with its own behaviour.
    if (role === 'checkbox' || role === 'radio') return !el.closest('[role="grid"]');
    return false;
  };

  // Delete is only meaningful in the message list or the reading pane. Focus anywhere else --
  // a compose dialog, a toolbar, a menu -- is someone else's key event.
  const inDeleteContext = (el) => {
    // Nothing focused, or the document itself: Gmail's j/k keyboard cursor lives here, which
    // is the case this script exists for.
    if (!el || el.nodeType !== 1 || el === document.body || el === document.documentElement) return true;
    if (isControl(el)) return false;
    if (el.closest('[role="dialog"], [role="toolbar"], [role="menu"]')) return false;
    return !!el.closest('[role="main"], [role="grid"]');
  };

  // Gmail keeps a toolbar per view and hides the inactive ones, so the visible button is the
  // one for what the user is looking at.
  const deleteButton = () => Array.from(document.querySelectorAll('[role="button"][act="10"]'))
    .find((b) => b.offsetParent && b.getAttribute('aria-disabled') !== 'true');

  const press = (button) => {
    // Gmail's toolbar buttons act on mousedown/mouseup, not on click alone.
    for (const type of ['mousedown', 'mouseup', 'click']) {
      button.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, button: 0 }));
    }
  };

  const sendShortcut = (target) => {
    const send = (type, init) => target.dispatchEvent(new KeyboardEvent(type, Object.assign({
      key: '#', code: 'Digit3', shiftKey: true, bubbles: true, cancelable: true, composed: true,
    }, init)));
    // All three phases: which one Gmail's shortcut handler listens on is not ours to assume.
    send('keydown', { keyCode: 51, which: 51 });
    send('keypress', { keyCode: 35, charCode: 35, which: 35 });
    send('keyup', { keyCode: 51, which: 51 });
  };

  // On window, in the capture phase: the first stop of every key event, ahead of anything
  // Gmail registers on document. This script runs at dom-ready, by which point Gmail may or
  // may not have attached its own key handlers — a document-level listener's place in the
  // queue would depend on that race.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Delete' || !e.isTrusted || e.defaultPrevented) return;
    if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
    if (e.composedPath().some(isEditable) || isEditable(document.activeElement)) return;
    if (!inDeleteContext(document.activeElement)) return;

    e.preventDefault();
    e.stopImmediatePropagation();
    const button = deleteButton();
    if (button) press(button);
    else sendShortcut(e.target instanceof Element ? e.target : document.body);
  }, true);
})();
