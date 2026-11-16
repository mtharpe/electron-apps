const test = require('node:test');
const assert = require('node:assert');
const { createIdleReloader } = require('../lib/idle-reload');

const APP = 'https://app.example/';
const MIN = 60000;

function fakeWin(opts = {}) {
  const state = {
    focused: opts.focused || false,
    minimized: opts.minimized || false,
    visible: opts.visible === undefined ? true : opts.visible,
    audible: opts.audible || false,
    destroyed: opts.destroyed || false,
    url: opts.url === undefined ? APP + 'home' : opts.url,
  };
  const win = {
    reloads: 0,
    isDestroyed: () => state.destroyed,
    isFocused: () => state.focused,
    isMinimized: () => state.minimized,
    isVisible: () => state.visible,
    webContents: {
      isDestroyed: () => state.destroyed,
      isCurrentlyAudible: () => state.audible,
      isDevToolsOpened: () => false,
      getURL: () => state.url,
      loadURL: () => { win.reloads++; return Promise.resolve(); },
      reload: () => { win.reloads++; },
    },
  };
  return win;
}

function setup(win, idleMs = MIN) {
  let t = 1000000;
  const windows = new Map([[1, win]]);
  const r = createIdleReloader({ windows, appUrl: APP, idleMs, now: () => t });
  r.noteWindow(win);
  return { r, advance: (ms) => { t += ms; }, win };
}

test('idle reload disabled does nothing', () => {
  const win = fakeWin({ minimized: true, visible: false });
  const { r, advance } = setup(win, 0);
  advance(10 * MIN);
  assert.strictEqual(r.maybeReload(), 0);
  assert.strictEqual(win.reloads, 0);
});

test('reloads a hidden window after the threshold', () => {
  const win = fakeWin({ minimized: true, visible: false });
  const { r, advance } = setup(win);
  advance(MIN + 1);
  assert.strictEqual(r.maybeReload(), 1);
  assert.strictEqual(win.reloads, 1);
});

test('does not reload before the threshold', () => {
  const win = fakeWin({ minimized: true, visible: false });
  const { r, advance } = setup(win);
  advance(MIN - 1);
  assert.strictEqual(r.maybeReload(), 0);
  assert.strictEqual(win.reloads, 0);
});

test('does not reload a focused window, and refreshes its idle clock', () => {
  const win = fakeWin({ focused: true, minimized: true, visible: false });
  const { r, advance } = setup(win);
  advance(MIN + 1);
  assert.strictEqual(r.maybeReload(), 0);
  assert.strictEqual(win.reloads, 0);
});

test('does not reload a visible side-by-side window even if unfocused', () => {
  const win = fakeWin({ focused: false, minimized: false, visible: true });
  const { r, advance } = setup(win);
  advance(MIN + 1);
  assert.strictEqual(r.maybeReload(), 0);
  assert.strictEqual(win.reloads, 0);
});

test('does not interrupt audible windows', () => {
  const win = fakeWin({ minimized: true, visible: false, audible: true });
  const { r, advance } = setup(win);
  advance(MIN + 1);
  assert.strictEqual(r.maybeReload(), 0);
});

test('does not reload a window off the app URL', () => {
  const win = fakeWin({ minimized: true, visible: false, url: 'https://accounts.google.com/signin' });
  const { r, advance } = setup(win);
  advance(MIN + 1);
  assert.strictEqual(r.maybeReload(), 0);
});

test('does not reload a destroyed window', () => {
  const win = fakeWin({ minimized: true, visible: false, destroyed: true });
  const { r, advance } = setup(win);
  advance(MIN + 1);
  assert.strictEqual(r.maybeReload(), 0);
});
