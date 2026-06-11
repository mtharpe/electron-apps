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

  // 7) Mirror page-level AND service-worker notifications through the native
  //    main-process Notification (the path proven to render banners on macOS).
  try {
    const pending = Object.create(null);
    let seq = 0;
    const fire = (title, options, instance) => {
      options = options || {};
      const id = 'n' + (++seq);
      if (instance) pending[id] = instance;
      if (ipc) {
        ipc.send('mirror-notification', {
          id: id,
          title: String(title == null ? '' : title),
          body: String(options.body || ''),
          tag: String(options.tag || ''),
        });
      }
      return id;
    };

    if (ipc) {
      ipc.on('mirror-notification-click', (_e, id) => {
        const inst = pending[id];
        if (inst && typeof inst._onclick === 'function') {
          try { inst._onclick({ type: 'click' }); } catch (e) {}
        }
      });
    }

    // 7a) page-level Notification → replace with a mirroring shim
    const RealNotification = window.Notification;
    function MirrorNotification(title, options) {
      this._onclick = null;
      this._id = fire(title, options, this);
    }
    MirrorNotification.prototype.close = function () {};
    MirrorNotification.prototype.addEventListener = function (type, cb) {
      if (type === 'click') this._onclick = cb;
    };
    MirrorNotification.prototype.removeEventListener = function () {};
    MirrorNotification.prototype.dispatchEvent = function () { return true; };
    Object.defineProperty(MirrorNotification.prototype, 'onclick', {
      configurable: true,
      get: function () { return this._onclick; },
      set: function (fn) { this._onclick = fn; },
    });
    Object.defineProperty(MirrorNotification, 'permission', { configurable: true, get: () => 'granted' });
    MirrorNotification.requestPermission = function (cb) {
      if (typeof cb === 'function') { try { cb('granted'); } catch (e) {} }
      return Promise.resolve('granted');
    };
    MirrorNotification.maxActions = (RealNotification && RealNotification.maxActions) || 2;
    window.Notification = MirrorNotification;

    // 7b) service-worker notifications (registration.showNotification)
    if (window.ServiceWorkerRegistration &&
        ServiceWorkerRegistration.prototype &&
        ServiceWorkerRegistration.prototype.showNotification) {
      ServiceWorkerRegistration.prototype.showNotification = function (title, options) {
        fire(title, options, null);
        return Promise.resolve();
      };
      ServiceWorkerRegistration.prototype.getNotifications = function () { return Promise.resolve([]); };
    }
  } catch (e) {}
})();
