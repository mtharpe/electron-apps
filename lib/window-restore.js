// Which account windows open at launch: the ones marked "Open at launch" in the Accounts
// window, plus — while Reopen is on — the ones that were open when the app last quit.
//
// Per app, in its own userData, never in the shared accounts.json: having Accounts 1 and 3
// open in Gmail says nothing about which Calendar windows the user wants.
//
// Also holds each slot's window geometry (bounds, maximized, zoom), because that is the same
// kind of fact: a preference of this app, in this app's own userData.
//
// The record is rewritten on every open and close, not only at quit. A logout or shutdown
// does not reliably give the app a 'before-quit' to save from, and a record that is already
// current needs no last-moment write.
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { WINDOW_SLOTS } = require('./accounts');
const { IS_MAC } = require('./config');

// A move/resize/zoom produces a burst of events, and each one is a synchronous write. Coalesce
// them; a close or an explicit save still writes immediately.
const SAVE_DEBOUNCE_MS = 250;

let reopenAccounts = true;
let openSlots = [1];
let launchSlots = [];
// slot -> { maximized, bounds: {x,y,width,height}|null, zoom }
let geometry = new Map();
let quitting = false;
let saveTimer = null;

function restoreFile() {
  // app.getPath('userData') derives from the app name, so this is only correct after
  // app.setName() has run — every call site below is on that side of it.
  return path.join(app.getPath('userData'), 'restore.json');
}

const validSlots = (list) => Array.isArray(list)
  ? [...new Set(list.filter((n) => Number.isInteger(n) && n >= 1 && n <= WINDOW_SLOTS))].sort((a, b) => a - b)
  : [];

// A saved geometry is used to place a window, so reject anything malformed rather than hand
// BrowserWindow NaN/negative values. Zoom 0 is not a factor Chromium has; drop it to 1.
function cleanGeometry(v) {
  if (!v || typeof v !== 'object') return null;
  const b = v.bounds;
  const finite = b && ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(b[k]));
  return {
    maximized: !!v.maximized,
    bounds: finite ? { x: b.x, y: b.y, width: b.width, height: b.height } : null,
    zoom: Number.isFinite(v.zoom) && v.zoom > 0 ? v.zoom : 1,
  };
}

function loadRestoreState() {
  try {
    const saved = JSON.parse(fs.readFileSync(restoreFile(), 'utf8'));
    if (typeof saved.reopenAccounts === 'boolean') reopenAccounts = saved.reopenAccounts;
    const slots = validSlots(saved.openSlots);
    if (slots.length > 0) openSlots = slots;
    launchSlots = validSlots(saved.launchSlots);
    const savedGeometry = saved.geometry;
    if (savedGeometry && typeof savedGeometry === 'object') {
      geometry = new Map();
      for (const [k, v] of Object.entries(savedGeometry)) {
        const n = Number(k);
        if (!Number.isInteger(n) || n < 1 || n > WINDOW_SLOTS) continue;
        const clean = cleanGeometry(v);
        if (clean) geometry.set(n, clean);
      }
    }
  } catch {
    // No file yet, or it is unreadable/corrupt — Account 1 alone is the right answer either way.
  }
  // A debounced geometry write still in flight at quit must land, or the last move is lost.
  app.on('before-quit', () => { quitting = true; flushSave(); });
}

function save() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try {
    const geo = {};
    for (const [n, g] of geometry) geo[n] = g;
    const tmp = restoreFile() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ reopenAccounts, openSlots, launchSlots, geometry: geo }) + '\n');
    fs.renameSync(tmp, restoreFile());
  } catch (e) {
    // A failed write only costs the windows at next launch; don't take the app down for it.
  }
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; save(); }, SAVE_DEBOUNCE_MS);
}

function flushSave() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  save();
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
//
// macOS is the exception the early return used to swallow: it keeps running with zero
// windows, so closing the last one is a real state — remember that nothing was open, rather
// than leaving the previous set in place and reopening windows the user just closed.
function noteWindowClosed(n, stillOpen) {
  if (quitting) return;
  if (stillOpen.length === 0) {
    if (!IS_MAC) return;
    openSlots = [];
    save();
    return;
  }
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

// Last known geometry for a slot, or null on a first run. Bounds are copied so a caller
// cannot mutate the stored rectangle it is about to be handed.
function getWindowGeometry(n) {
  const g = geometry.get(n);
  return g ? { maximized: g.maximized, bounds: g.bounds ? { ...g.bounds } : null, zoom: g.zoom } : null;
}

function noteWindowGeometry(n, geo) {
  if (!Number.isInteger(n) || n < 1 || n > WINDOW_SLOTS) return;
  const clean = cleanGeometry(geo);
  if (!clean) return;
  geometry.set(n, clean);
  scheduleSave();
}

module.exports = {
  loadRestoreState, takeLaunchSlots, noteWindowOpened, noteWindowClosed,
  getReopenAccounts, setReopenAccounts, getLaunchSlots, setLaunchSlots,
  getWindowGeometry, noteWindowGeometry,
};
