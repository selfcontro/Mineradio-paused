'use strict';

const QMKG_LOGIN_URL = 'https://kg.qq.com/node/personal';
const QMKG_LOGIN_PARTITION = 'persist:mineradio-qmkg-login';
const QMKG_COOKIE_FIELDS = ['ver', 'qua', 'uid', 'muid', 'opentype', 'udid', 'openid', 'openkey'];
const QMKG_STATUS_FIELDS = [
  'provider', 'source', 'loggedIn', 'sessionReady', 'playbackKeyReady', 'authValidated',
  'connectionAvailable', 'nickname', 'userId', 'avatar', 'vipType', 'vipLevel', 'isVip', 'isSvip',
  'checkedAt', 'cacheDir', 'reauthRequired', 'error', 'message',
];

function isTrustedQmkgLoginUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
    const host = url.hostname.toLowerCase();
    return host === 'kg.qq.com' || host.endsWith('.kg.qq.com') || [
      'ui.ptlogin2.qq.com', 'xui.ptlogin2.qq.com', 'ssl.ptlogin2.qq.com',
      'graph.qq.com', 'open.weixin.qq.com',
    ].includes(host);
  } catch (_) { return false; }
}

function buildQmkgLoginCookieHeader(cookies, now = Date.now()) {
  const picked = new Map();
  for (const cookie of cookies || []) {
    if (!cookie || !QMKG_COOKIE_FIELDS.includes(cookie.name)) continue;
    const domain = String(cookie.domain || '').replace(/^\./, '').toLowerCase();
    if (domain !== 'qq.com' && domain !== 'kg.qq.com' && !domain.endsWith('.kg.qq.com')) continue;
    const expires = Number(cookie.expirationDate);
    if (Number.isFinite(expires) && expires > 0 && expires <= now / 1000) continue;
    const value = String(cookie.value || '');
    if (/[\x00-\x20\x7f;]/.test(value)) continue;
    const path = String(cookie.path || '/');
    if (path !== '/') continue;
    const score = domain === 'kg.qq.com' ? 300 : domain.endsWith('.kg.qq.com') ? 200 : 100;
    const previous = picked.get(cookie.name);
    if (!previous || score > previous.score || (score === previous.score && expires > previous.expires)) {
      picked.set(cookie.name, { value, score, expires });
    }
  }
  return QMKG_COOKIE_FIELDS.filter(name => picked.has(name)).map(name => name + '=' + picked.get(name).value).join('; ');
}

function qmkgCookieHasLoginFields(header) {
  const values = Object.fromEntries(String(header || '').split(';').map(value => {
    const separator = value.indexOf('=');
    return separator > 0 ? [value.slice(0, separator).trim(), value.slice(separator + 1).trim()] : ['', ''];
  }));
  // muid is not interchangeable with the protocol Cookie uid.
  return !!(values.uid && values.openid && values.openkey);
}

function publicQmkgStatus(status) {
  const result = { provider: 'qmkg' };
  for (const key of QMKG_STATUS_FIELDS) {
    const value = status && status[key];
    if (key !== 'provider' && ['string', 'number', 'boolean'].includes(typeof value)) result[key] = value;
  }
  return result;
}

function createQmkgLoginBridge(options) {
  const { BrowserWindow, session, importCookie, clearCookie } = options;
  const loginUrl = QMKG_LOGIN_URL;
  const partition = QMKG_LOGIN_PARTITION;
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 5 * 60 * 1000);
  const scheduleInterval = options.setInterval || setInterval;
  const cancelInterval = options.clearInterval || clearInterval;
  const scheduleTimeout = options.setTimeout || setTimeout;
  const cancelTimeout = options.clearTimeout || clearTimeout;
  const clock = options.clock || Date.now;
  const activeImports = new Set();
  let revision = 0;
  let activePromise = null;
  let activeWindow = null;
  let cancelActive = null;
  let clearPending = null;

  async function readCookie(cookieSession) {
    // This partition is used only for the official K-song window. Include
    // HttpOnly cookies without injecting credentials into page JavaScript.
    const cookies = await cookieSession.cookies.get({ url: 'https://kg.qq.com/' });
    return buildQmkgLoginCookieHeader(cookies, clock());
  }

  async function validate(header, requestRevision) {
    if (requestRevision !== revision || !qmkgCookieHasLoginFields(header)) return null;
    let operation;
    operation = Promise.resolve().then(() => importCookie(header, { source: 'web' }));
    activeImports.add(operation);
    try {
      const received = await operation;
      const status = publicQmkgStatus(received);
      if (requestRevision !== revision) return null;
      return { ...status, ok: received && received.provider === 'qmkg' && status.loggedIn === true && status.authValidated === true };
    } catch (_) {
      return { provider: 'qmkg', ok: false, error: 'QMKG_LOGIN_VALIDATION_FAILED', message: '暂时无法验证全民 K 歌会话，请稍后重试。' };
    } finally { activeImports.delete(operation); }
  }

  async function runOpen(owner, settings, requestRevision) {
    const cookieSession = session.fromPartition(partition);
    let initialHeader = '';
    let initialStatus = null;
    if (settings.forceReauth === true) {
      await cookieSession.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'cachestorage'] });
    } else {
      try { initialHeader = await readCookie(cookieSession); } catch (_) {}
      initialStatus = await validate(initialHeader, requestRevision);
      if (requestRevision !== revision) return { provider: 'qmkg', ok: false, cancelled: true };
      if (initialStatus && initialStatus.ok) return { ...initialStatus, reused: true };
    }
    if (requestRevision !== revision) return { provider: 'qmkg', ok: false, cancelled: true };

    return new Promise(resolve => {
      let settled = false;
      let closed = false;
      let pollTimer = null;
      let timeoutTimer = null;
      let cookieTimer = null;
      let inFlight = null;
      let previousHeader = initialHeader;
      let previousCheckAt = initialHeader ? clock() : 0;
      let previousStatus = initialStatus;
      const loginWindow = new BrowserWindow({
        width: 980, height: 780, minWidth: 780, minHeight: 600,
        parent: owner && !owner.isDestroyed() ? owner : undefined,
        modal: false, show: false, autoHideMenuBar: true,
        title: '全民 K 歌扫码登录', backgroundColor: '#111111', icon: options.icon,
        webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true },
      });
      activeWindow = loginWindow;

      const cleanUp = () => {
        if (pollTimer) cancelInterval(pollTimer);
        if (timeoutTimer) cancelTimeout(timeoutTimer);
        if (cookieTimer) cancelTimeout(cookieTimer);
        cookieSession.cookies.removeListener('changed', onCookieChanged);
      };
      const finish = result => {
        if (settled) return;
        settled = true;
        cleanUp();
        if (!loginWindow.isDestroyed()) loginWindow.close();
        resolve(result);
      };
      cancelActive = () => finish({ provider: 'qmkg', ok: false, cancelled: true });
      const probe = () => {
        if (inFlight) return inFlight;
        inFlight = (async () => {
          let header = '';
          try { header = await readCookie(cookieSession); } catch (_) { return null; }
          if (requestRevision !== revision || !qmkgCookieHasLoginFields(header)) return null;
          if (header === previousHeader && clock() - previousCheckAt < 15000) return previousStatus;
          previousHeader = header;
          previousCheckAt = clock();
          previousStatus = await validate(header, requestRevision);
          return previousStatus;
        })().finally(() => { inFlight = null; });
        return inFlight;
      };
      const checkCookies = async () => {
        if (settled || closed) return;
        const status = await probe();
        if (status && status.ok && !settled && !closed) finish(status);
      };
      function onCookieChanged() {
        if (settled || closed) return;
        if (cookieTimer) cancelTimeout(cookieTimer);
        cookieTimer = scheduleTimeout(checkCookies, 300);
      }
      cookieSession.cookies.on('changed', onCookieChanged);
      loginWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (isTrustedQmkgLoginUrl(url)) loginWindow.loadURL(url).catch(() => {});
        return { action: 'deny' };
      });
      const guardNavigation = (event, url) => {
        if (!isTrustedQmkgLoginUrl(url)) event.preventDefault();
      };
      loginWindow.webContents.on('will-navigate', guardNavigation);
      loginWindow.webContents.on('will-redirect', guardNavigation);
      loginWindow.webContents.on('did-finish-load', () => {
        checkCookies();
        let current;
        try { current = new URL(loginWindow.webContents.getURL()); } catch (_) { return; }
        if (current.hostname !== 'kg.qq.com') return;
        // Trigger the official page's own login dialog and QR generation.
        loginWindow.webContents.executeJavaScript(`new Promise(resolve => setTimeout(() => {
          const button = document.querySelector('.j_login');
          const rect = button && button.getBoundingClientRect();
          if (button && rect.width > 0 && rect.height > 0) button.click();
          resolve(true);
        }, 700))`, true).catch(() => {});
      });
      loginWindow.on('ready-to-show', () => { if (!settled && !loginWindow.isDestroyed()) loginWindow.show(); });
      loginWindow.on('closed', async () => {
        if (settled) return;
        closed = true;
        cleanUp();
        const status = await probe();
        finish(status && status.ok ? status : { provider: 'qmkg', ok: false, cancelled: true, message: '全民 K 歌登录窗口已关闭，尚未验证登录会话。' });
      });
      pollTimer = scheduleInterval(checkCookies, 1200);
      timeoutTimer = scheduleTimeout(() => finish({ provider: 'qmkg', ok: false, error: 'QMKG_LOGIN_TIMEOUT', message: '扫码登录已超时，请重新打开官方登录窗口。' }), timeoutMs);
      loginWindow.loadURL(loginUrl).catch(() => finish({ provider: 'qmkg', ok: false, error: 'QMKG_LOGIN_PAGE_FAILED', message: '暂时无法打开全民 K 歌官方登录页面。' }));
    });
  }

  function open(owner, settings = {}) {
    if (clearPending) return clearPending.then(() => open(owner, settings));
    if (activePromise) {
      if (activeWindow && !activeWindow.isDestroyed()) activeWindow.show();
      return activePromise;
    }
    const requestRevision = revision;
    activePromise = runOpen(owner, settings && typeof settings === 'object' ? settings : {}, requestRevision)
      .catch(() => ({ provider: 'qmkg', ok: false, error: 'QMKG_LOGIN_FAILED', message: '全民 K 歌登录暂时不可用，请稍后重试。' }))
      .finally(() => { activePromise = null; activeWindow = null; cancelActive = null; });
    return activePromise;
  }

  function clear() {
    if (clearPending) return clearPending;
    revision += 1;
    if (cancelActive) cancelActive();
    clearPending = (async () => {
      const cookieSession = session.fromPartition(partition);
      await cookieSession.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'cachestorage'] });
      // A pending validation must finish before deleting the saved credential,
      // so a late success cannot resurrect a logged-out session.
      await Promise.allSettled([...activeImports]);
      await clearCookie();
      return { provider: 'qmkg', ok: true };
    })().finally(() => { clearPending = null; });
    return clearPending;
  }
  return { open, clear };
}

module.exports = { createQmkgLoginBridge, buildQmkgLoginCookieHeader, qmkgCookieHasLoginFields, isTrustedQmkgLoginUrl, publicQmkgStatus };
