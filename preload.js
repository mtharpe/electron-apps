// Stealth layer: make this embedded Chromium indistinguishable from stock desktop
// Chrome so Google's sign-in page stops returning "this browser may not be secure".
// Runs in the page's main world (contextIsolation:false) BEFORE the page's own scripts.
(function () {
  'use strict';
  const V = '138';

  const def = (obj, prop, getter) => {
    try { Object.defineProperty(obj, prop, { get: getter, configurable: true }); } catch (e) {}
  };

  // Capture IPC now, before the Node-global scrub below removes window.require.
  // Used to mirror web notifications to the native (main-process) banner path.
  let ipc = null;
  try { ipc = require('electron').ipcRenderer; } catch (e) {}

  // 1) navigator.webdriver must be false
  def(navigator, 'webdriver', () => false);

  // 2) navigator.userAgentData — the Client Hints JS API. Electron leaks "Electron" here.
  try {
    const brands = [
      { brand: 'Google Chrome', version: V },
      { brand: 'Chromium', version: V },
      { brand: 'Not.A/Brand', version: '24' },
    ];
    const fullVersionList = brands.map((b) => ({ brand: b.brand, version: b.version + '.0.0.0' }));
    const uaData = {
      brands,
      mobile: false,
      platform: 'macOS',
      getHighEntropyValues: () => Promise.resolve({
        architecture: 'arm',
        bitness: '64',
        brands,
        fullVersionList,
        mobile: false,
        model: '',
        platform: 'macOS',
        platformVersion: '14.4.1',
        uaFullVersion: V + '.0.0.0',
        wow64: false,
      }),
      toJSON: () => ({ brands, mobile: false, platform: 'macOS' }),
    };
    def(navigator, 'userAgentData', () => uaData);
  } catch (e) {}

  // 3) window.chrome — real Chrome exposes a rich object; Electron's is sparse/absent.
  try {
    window.chrome = window.chrome || {};
    window.chrome.runtime = window.chrome.runtime || {};
    window.chrome.app = window.chrome.app || { isInstalled: false, InstallState: {}, RunningState: {} };
    window.chrome.csi = window.chrome.csi || function () { return {}; };
    window.chrome.loadTimes = window.chrome.loadTimes || function () { return {}; };
  } catch (e) {}

  // 4) Scrub Electron/Node globals that fingerprinting scripts probe for.
  try {
    delete window.require;
    delete window.exports;
    delete window.module;
    delete window.process;
    delete window.global;
    delete window.Buffer;
  } catch (e) {}

  // 5) Plugins/mimeTypes: headless/embedded often report 0; give it a non-empty length.
  try {
    if (navigator.plugins && navigator.plugins.length === 0) {
      def(navigator, 'plugins', () => ({ length: 1, 0: { name: 'PDF Viewer' } }));
    }
  } catch (e) {}

  // 6) Force web Notification permission to "granted". Web apps like Google Calendar
  //    check Notification.permission before firing a desktop notification; if it isn't
  //    "granted" they fall back to an in-page sound and never ask macOS for a banner.
  try {
    if (window.Notification) {
      Object.defineProperty(window.Notification, 'permission', {
        configurable: true,
        get: () => 'granted',
      });
      window.Notification.requestPermission = function (cb) {
        if (typeof cb === 'function') { try { cb('granted'); } catch (e) {} }
        return Promise.resolve('granted');
      };
    }
  } catch (e) {}

  // 7) Mirror page-level AND service-worker notifications to the native banner path —
  //    WITHOUT disturbing the page's own notification objects/flows. We keep the real
  //    Notification object (so Google's code, instanceof checks, and service-worker sync
  //    are untouched) and merely send a parallel copy to the native main process.
  try {
    let seq = 0;
    const fire = (title, options) => {
      options = options || {};
      if (ipc) {
        ipc.send('mirror-notification', {
          id: 'n' + (++seq),
          title: String(title == null ? '' : title),
          body: String(options.body || ''),
          tag: String(options.tag || ''),
        });
      }
    };

    // 7a) page-level Notification — wrap construction via a Proxy; the returned object is
    //     still a genuine Notification.
    if (window.Notification) {
      window.Notification = new Proxy(window.Notification, {
        construct(target, argList) {
          try { fire(argList[0], argList[1]); } catch (e) {}
          return Reflect.construct(target, argList, target);
        },
      });
    }

    // 7b) service-worker notifications — mirror, then call the ORIGINAL so the page's own
    //     notification/sync logic still runs.
    if (window.ServiceWorkerRegistration &&
        ServiceWorkerRegistration.prototype &&
        ServiceWorkerRegistration.prototype.showNotification) {
      const origShow = ServiceWorkerRegistration.prototype.showNotification;
      ServiceWorkerRegistration.prototype.showNotification = function (title, options) {
        try { fire(title, options); } catch (e) {}
        try { return origShow.apply(this, arguments); } catch (e) { return Promise.resolve(); }
      };
    }
  } catch (e) {}
})();
