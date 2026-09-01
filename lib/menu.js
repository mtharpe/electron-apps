// The application menu.
//
// The window-opening actions are injected rather than imported: they live in main.js, which
// requires this module, so importing them back would close a cycle. main.js calls init()
// once at startup.
const { Menu, Notification } = require('electron');
const { IS_MAC, APP_NAME } = require('./config');
const { ACCOUNT_SLOTS, accountMenuLabel } = require('./accounts');
const { getThemePreference, setThemePreference } = require('./theme');
const { nativeNotification } = require('./notifications');

let actions = { openAccountWindow: () => {}, nextFreeSlot: () => 1, openAccountsWindow: () => {} };
function init(a) { actions = a; }

function buildMenu() {
  const accountItems = [];
  for (let i = 1; i <= ACCOUNT_SLOTS; i++) {
    accountItems.push({
      label: accountMenuLabel(i),
      accelerator: 'CmdOrCtrl+' + i,
      click: () => actions.openAccountWindow(i),
    });
  }

  // The leading menu differs by platform: macOS gets the standard application menu
  // (About / Hide / Hide Others / Unhide are macOS-only roles and are ignored elsewhere),
  // while Linux gets a conventional File menu — the menu bar is drawn inside the window
  // there, so there is no app-name menu for those items to live in.
  const leadingMenu = IS_MAC
    ? {
      label: APP_NAME,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }
    : {
      label: 'File',
      submenu: [
        { role: 'close' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    };

  const template = [
    leadingMenu,
    {
      label: 'Accounts',
      submenu: [
        {
          label: 'New Account Window',
          accelerator: 'CmdOrCtrl+N',
          click: () => actions.openAccountWindow(actions.nextFreeSlot()),
        },
        { type: 'separator' },
        ...accountItems,
        { type: 'separator' },
        {
          label: 'Configure Accounts…',
          accelerator: 'CmdOrCtrl+,',
          click: () => actions.openAccountsWindow(),
        },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
        { role: 'pasteAndMatchStyle' }, { role: 'delete' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' }, { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' },
        { role: 'togglefullscreen' }, { role: 'toggleDevTools' }, { type: 'separator' },
        {
          // Escape hatch for when detection disagrees with the desktop the user actually
          // sees. "System" is the default and follows the appearance portal.
          label: 'Appearance',
          submenu: [
            {
              label: 'System',
              type: 'radio',
              checked: getThemePreference() === 'system',
              click: () => setThemePreference('system'),
            },
            {
              label: 'Light',
              type: 'radio',
              checked: getThemePreference() === 'light',
              click: () => setThemePreference('light'),
            },
            {
              label: 'Dark',
              type: 'radio',
              checked: getThemePreference() === 'dark',
              click: () => setThemePreference('dark'),
            },
          ],
        },
      ],
    },
    {
      label: 'Window',
      // 'zoom' and 'front' are macOS-only roles.
      submenu: IS_MAC
        ? [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }, { role: 'front' }]
        : [{ role: 'minimize' }, { role: 'close' }],
    },
    {
      label: 'Help',
      submenu: [
        // On macOS About lives in the application menu; on Linux it belongs here.
        ...(IS_MAC ? [] : [{ role: 'about' }, { type: 'separator' }]),
        {
          label: 'Send Test Notification (now)',
          click: () => {
            if (Notification.isSupported()) {
              nativeNotification({ title: APP_NAME, body: 'Native desktop notifications are working ✓' }).show();
            }
          },
        },
        {
          label: 'Send Test Notification in 5s (click away to see the banner)',
          click: () => {
            if (!Notification.isSupported()) return;
            setTimeout(() => {
              nativeNotification({
                title: APP_NAME,
                body: 'If you can see this banner, notifications work while ' + APP_NAME + ' is in the background ✓',
              }).show();
            }, 5000);
          },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

module.exports = { init, buildMenu };
