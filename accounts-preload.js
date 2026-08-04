// Preload for the Accounts window ONLY — not for Google pages (that is preload.js, which
// runs in the page's main world to spoof fingerprints). This one is the opposite: a
// context-isolated bridge exposing exactly three calls and nothing else, so the settings
// page never gets a handle on ipcRenderer itself.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('accountsApi', {
  load: () => ipcRenderer.invoke('accounts:load'),
  save: (slots) => ipcRenderer.invoke('accounts:save', slots),
  close: () => ipcRenderer.send('accounts:close'),
});
