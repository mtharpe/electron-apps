// Which account windows open at launch: the ones marked "Open at launch" in the Accounts
// window, plus — while Reopen is on — the ones that were open when the app last quit.
//
// Per app, in its own userData, never in the shared accounts.json: having Accounts 1 and 3
// open in Gmail says nothing about which Calendar windows the user wants.
//
// The record is rewritten on every open and close, not only at quit. A logout or shutdown
// does not reliably give the app a 'before-quit' to save from, and a record that is already
// current needs no last-moment write.
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { ACCOUNT_SLOTS } = require('./accounts');

let reopenAccounts = true;
let openSlots = [1];
let launchSlots = [];
let quitting = false;

function restoreFile() {
  // app.getPath('userData') derives from the app name, so this is only correct after
  // app.setName() has run — every call site below is on that side of it.
  return path.join(app.getPath('userData'), 'restore.json');
}

const validSlots = (list) => Array.isArray(list)
  ? [...new Set(list.filter((n) => Number.isInteger(n) && n >= 1 && n <= ACCOUNT_SLOTS))].sort((a, b) => a - b)
  : [];

function loadRestoreState() {
  try {
    const saved = JSON.parse(fs.readFileSync(restoreFile(), 'utf8'));
    if (typeof saved.reopenAccounts === 'boolean') reopenAccounts = saved.reopenAccounts;
    const slots = validSlots(saved.openSlots);
    if (slots.length > 0) openSlots = slots;
    launchSlots = validSlots(saved.launchSlots);
  } catch {
    // No file yet, or it is unreadable/corrupt — Account 1 alone is the right answer either way.
  }
  app.on('before-quit', () => { quitting = true; });
}

function save() {
  try {
    const tmp = restoreFile() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ reopenAccounts, openSlots, launchSlots }) + '\n');
    fs.renameSync(tmp, restoreFile());
  } catch (e) {
    // A failed write only costs the windows at next launch; don't take the app down for it.
  }
}

// The slots to open at launch, in slot order. Always at least one. Called once: it starts
// the record over, so the windows opened from it are what the next launch sees — not the
// last session's slots plus whatever "Open at launch" added on top.
function takeLaunchSlots() {
  const slots = validSlots([...launchSlots, ...(reopenAccounts ? openSlots : [])]);
  openSlots = [];
  return slots.length > 0 ? slots : [1];
}

function noteWindowOpened(n) {
  if (openSlots.includes(n)) return;
  openSlots = validSlots([...openSlots, n]);
  save();
}

// `stillOpen` is the slots whose windows remain after this one closed. Quitting closes every
// window, and closing the last one quits the app on Linux, so neither forgets anything: the
// app reopens the way it was left, rather than on whichever window happened to close last.
function noteWindowClosed(n, stillOpen) {
  if (quitting || stillOpen.length === 0) return;
  openSlots = validSlots(stillOpen);
  save();
}

function getReopenAccounts() { return reopenAccounts; }

function getLaunchSlots() { return launchSlots.slice(); }

function setLaunchSlots(list) {
  launchSlots = validSlots(list);
  save();
}

function setReopenAccounts(on) {
  reopenAccounts = !!on;
  save();
}

module.exports = {
  loadRestoreState, takeLaunchSlots, noteWindowOpened, noteWindowClosed,
  getReopenAccounts, setReopenAccounts, getLaunchSlots, setLaunchSlots,
};
