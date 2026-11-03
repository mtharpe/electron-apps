// Where each account window was: its monitor, position, size and whether it was maximized,
// so it reopens there. Per app, in <userData>/window-place.json, keyed by slot.
//
// Why: on GNOME every new window went to the primary monitor (and the user kept the mail
// apps on a side one). An app cannot place its own window under Wayland, so main.js runs
// these apps through XWayland on Linux, where a requested position is honoured.
//
// A saved place is only used while its monitor is still connected -- same bounds as when it
// was saved. Undocked, the side monitor is gone and the window opens where it would anyway,
// rather than off-screen; docked again, it goes back.
const path = require('path');
const fs = require('fs');
const { app, screen } = require('electron');

let places = null;

function placeFile() {
  // userData depends on app.setName(); only called after it.
  return path.join(app.getPath('userData'), 'window-place.json');
}

function load() {
  if (places) return places;
  try { places = JSON.parse(fs.readFileSync(placeFile(), 'utf8')) || {}; } catch (e) { places = {}; }
  return places;
}

function write() {
  try {
    const tmp = placeFile() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(places) + '\n');
    fs.renameSync(tmp, placeFile());
  } catch (e) { /* losing a position is not worth failing over */ }
}

const sameRect = (a, b) => !!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

// BrowserWindow options for the slot's saved place, or {} to let the desktop decide.
function savedPlace(slot) {
  const p = load()[slot];
  if (!p || !p.bounds || !p.display) return {};
  const display = screen.getAllDisplays().find((d) => sameRect(d.bounds, p.display));
  if (!display) return {};
  const { x, y, width, height } = p.bounds;
  return { x, y, width, height, __maximized: !!p.maximized };
}

// Keep the slot's place current as the user moves or resizes the window, and at close.
function track(slot, win) {
  let t = null;
  const remember = () => {
    if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
    const bounds = win.getNormalBounds();
    const display = screen.getDisplayMatching(win.getBounds()).bounds;
    load()[slot] = { bounds, maximized: win.isMaximized(), display };
    write();
  };
  const soon = () => { if (t) clearTimeout(t); t = setTimeout(() => { t = null; remember(); }, 500); };
  win.on('moved', soon);
  win.on('resize', soon);
  win.on('maximize', soon);
  win.on('unmaximize', soon);
  win.on('close', () => { if (t) { clearTimeout(t); t = null; } remember(); });
}

module.exports = { savedPlace, track };
