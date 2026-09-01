// Who owns which window.
//
// Extracted so that theme, accounts and recovery can all reach the app's windows without
// requiring each other -- they only ever need "the window for slot N" or "every window",
// and routing those questions through one another is what would make the module graph
// cyclic. This module deliberately depends on nothing.

// acctNum -> BrowserWindow
const windows = new Map();

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

module.exports = { windows, focusWindow, getAccountsWindow, setAccountsWindow };
