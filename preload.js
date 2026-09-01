// Stealth layer: make this embedded Chromium indistinguishable from stock desktop
// Chrome so Google's sign-in page stops returning "this browser may not be secure".
// Runs in the page's main world (contextIsolation:false) BEFORE the page's own scripts.
(function () {
  'use strict';
  // Derive from the REAL bundled Chromium (via Node's process, available in this
  // non-sandboxed preload) so the spoofed version can never lag the engine — a stale major
  // makes Google reject the app (Calendar shows "could not load the data"). Read here,
  // before the Node-global scrub in step 4 below.
  const V = (((typeof process !== 'undefined') && process.versions && process.versions.chrome) || '148.0.0.0').split('.')[0];

  // Spoof the HOST platform. These values must agree with the User-Agent and
  // Sec-CH-UA-Platform headers main.js sends — a client claiming macOS in JS while its
  // headers (and GPU/font fingerprint) say Linux is self-contradictory, and inconsistency
  // is exactly what Google's "browser may not be secure" check hunts for.
  const PLAT = ((typeof process !== 'undefined') && process.platform) || 'darwin';
  const IS_MAC = PLAT === 'darwin';
  const ARCH = ((typeof process !== 'undefined') && process.arch) || 'arm64';
  // Client Hints spell architectures "x86"/"arm", not Node's "x64"/"arm64".
  const CH_ARCH = /^arm/.test(ARCH) ? 'arm' : 'x86';
  const CH_PLATFORM = IS_MAC ? 'macOS' : 'Linux';
  // Chrome reports a real macOS version here, but reports "" on Linux — matching that
  // matters more than supplying a plausible-looking kernel version.
  const CH_PLATFORM_VERSION = IS_MAC ? '14.4.1' : '';

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
      platform: CH_PLATFORM,
      getHighEntropyValues: () => Promise.resolve({
        architecture: CH_ARCH,
        bitness: '64',
        brands,
        fullVersionList,
        mobile: false,
        model: '',
        platform: CH_PLATFORM,
        platformVersion: CH_PLATFORM_VERSION,
        uaFullVersion: V + '.0.0.0',
        wow64: false,
      }),
      toJSON: () => ({ brands, mobile: false, platform: CH_PLATFORM }),
    };
    def(navigator, 'userAgentData', () => uaData);
  } catch (e) {}

  // 2b) navigator.platform — the legacy sibling of the above. Chrome reports "MacIntel" on
  // macOS and "Linux x86_64" on Linux; Electron already reports the host value correctly,
  // so this only pins it against anything that might overwrite it later.
  try { def(navigator, 'platform', () => (IS_MAC ? 'MacIntel' : 'Linux ' + (CH_ARCH === 'arm' ? 'aarch64' : 'x86_64'))); } catch (e) {}

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

  // 5) navigator.plugins needs no patch here. There used to be one, guarded on
  //    `navigator.plugins.length === 0` on the theory that an embedded Chromium reports an
  //    empty list. Measured on this build (Chromium 148) at accounts.google.com: length is 5
  //    — ["PDF Viewer", "Chrome PDF Viewer", "Chromium PDF Viewer", "Microsoft Edge PDF
  //    Viewer", "WebKit built-in PDF"], the set the HTML spec now requires every browser to
  //    hardcode — and it is a genuine PluginArray. The guard never fired, so the patch was
  //    dead code; worse, had it fired it would have replaced a PluginArray with a plain
  //    object, which is itself a fingerprinting tell.

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
      if (!ipc) return;
      // Forward the Notification `data` field alongside title/body. Web Notifications spec
      // requires data to be structured-cloneable, and Electron's IPC uses structured clone —
      // so a well-behaved page's data reaches the main process untouched. Probe with
      // structuredClone first anyway: a page that stuffs something non-cloneable in there
      // would otherwise make ipc.send throw and lose the whole notification. Falling back to
      // undefined keeps the title/body path working even when data can't come along.
      let data;
      try { structuredClone(options.data); data = options.data; } catch (e) { data = undefined; }
      ipc.send('mirror-notification', {
        id: 'n' + (++seq),
        title: String(title == null ? '' : title),
        body: String(options.body || ''),
        tag: String(options.tag || ''),
        data,
      });
    };

    // 7a) page-level Notification — wrap construction via a Proxy; the returned object is
    //     still a genuine Notification.
    //
    //     macOS: mirror to the native main-process path (its field-tested behaviour), which
    //       carries its own click→focus.
    //     Linux: Electron ALREADY shows page-level notifications, so mirroring would post a
    //       second identical banner — but Electron does NOT focus the app when one is
    //       clicked, so clicking a page-level notification (e.g. Google Messages) did
    //       nothing. So on Linux we do not mirror (no double banner); we attach a click
    //       handler that asks the main process to focus this window. This runs ALONGSIDE the
    //       page's own onclick (which navigates to the right conversation) — the page's
    //       window.focus() can't raise the OS window from a renderer, the IPC can.
    if (window.Notification) {
      window.Notification = new Proxy(window.Notification, {
        construct(target, argList) {
          if (IS_MAC) { try { fire(argList[0], argList[1]); } catch (e) {} }
          const notif = Reflect.construct(target, argList, target);
          if (!IS_MAC && ipc) {
            try { notif.addEventListener('click', () => { try { ipc.send('notification-focus'); } catch (e) {} }); } catch (e) {}
          }
          return notif;
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
