'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const {
  createQmkgLoginBridge, buildQmkgLoginCookieHeader, qmkgCookieHasLoginFields,
  isTrustedQmkgLoginUrl, publicQmkgStatus,
} = require('../desktop/qmkg-login-bridge');

const tick = () => new Promise(setImmediate);
function syntheticCookies(key = 'synthetic-k-song-openkey') {
  return [
    { name: 'uid', value: '123456', domain: '.kg.qq.com', path: '/' },
    { name: 'openid', value: 'synthetic-k-song-openid', domain: '.kg.qq.com', path: '/' },
    { name: 'openkey', value: key, domain: '.kg.qq.com', path: '/' },
  ];
}

function harness(options = {}) {
  const state = { cookies: options.cookies || [], windows: [], imports: [], clears: [], events: [], intervals: new Set(), timeouts: new Map() };
  const cookies = new EventEmitter();
  cookies.get = async (filter) => {
    assert.equal(filter.url, 'https://kg.qq.com/');
    return state.cookies;
  };
  const cookieSession = {
    cookies,
    async clearStorageData(settings) {
      assert.ok(settings.storages.includes('cookies'));
      state.cookies = [];
      state.clears.push(settings);
      state.events.push('clear-browser');
    },
  };
  class LoginWindow extends EventEmitter {
    constructor(settings) {
      super();
      this.settings = settings;
      this.destroyed = false;
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = callback => { this.popup = callback; };
      this.webContents.executeJavaScript = async script => { this.script = script; };
      this.webContents.getURL = () => this.url || '';
      state.windows.push(this);
    }
    async loadURL(url) { this.url = url; }
    isDestroyed() { return this.destroyed; }
    show() { this.shown = true; }
    close() { if (!this.destroyed) { this.destroyed = true; this.emit('closed'); } }
  }
  const bridge = createQmkgLoginBridge({
    BrowserWindow: LoginWindow,
    session: { fromPartition: partition => {
      assert.equal(partition, 'persist:mineradio-qmkg-login');
      return cookieSession;
    } },
    importCookie: async (header, settings) => {
      state.imports.push({ header, settings });
      const status = options.importCookie ? await options.importCookie(header) : {
        provider: 'qmkg', loggedIn: true, authValidated: true, playbackKeyReady: true,
        nickname: 'Synthetic singer', cookie: header, openkey: 'must-never-return',
      };
      state.events.push('validated');
      return status;
    },
    clearCookie: async () => { state.events.push('clear-saved'); },
    setInterval: callback => { state.intervals.add(callback); return callback; },
    clearInterval: callback => state.intervals.delete(callback),
    setTimeout: (callback, ms) => { state.timeouts.set(callback, ms); return callback; },
    clearTimeout: callback => state.timeouts.delete(callback),
    timeoutMs: 1000,
  });
  return { state, bridge, cookieSession };
}

test('K-song cookies use only the official scope and whitelist, without treating muid as uid', () => {
  const cookies = syntheticCookies().concat([
    { name: 'uid', value: 'parent-fallback', domain: '.qq.com', path: '/' },
    { name: 'openkey', value: 'expired', domain: '.kg.qq.com', path: '/', expirationDate: 1 },
    { name: 'openkey', value: 'wrong-domain', domain: '.qq.com.attacker.invalid', path: '/' },
    { name: 'payment_token', value: 'do-not-import', domain: '.kg.qq.com', path: '/' },
    { name: 'muid', value: 'other-user-id', domain: '.kg.qq.com', path: '/' },
  ]);
  const header = buildQmkgLoginCookieHeader(cookies);
  assert.match(header, /uid=123456/);
  assert.match(header, /openkey=synthetic-k-song-openkey/);
  assert.doesNotMatch(header, /parent-fallback|expired|wrong-domain|payment_token|do-not-import/);
  assert.equal(qmkgCookieHasLoginFields(header), true);
  assert.equal(qmkgCookieHasLoginFields('muid=123;openid=synthetic;openkey=synthetic'), false);
  assert.equal(publicQmkgStatus({ cookie: 'sensitive', openkey: 'sensitive', provider: 'other' }).provider, 'qmkg');
});

test('K-song authentication navigation rejects lookalikes, credentials, non-HTTPS and arbitrary QQ pages', () => {
  for (const url of ['https://kg.qq.com/node/personal', 'https://node.kg.qq.com/cgi/fcgi-bin/fcg_login_code', 'https://open.weixin.qq.com/connect/qrconnect']) {
    assert.equal(isTrustedQmkgLoginUrl(url), true, url);
  }
  for (const url of ['http://kg.qq.com/', 'https://kg.qq.com.attacker.invalid/', 'https://attackerkg.qq.com/', 'https://user@kg.qq.com/', 'https://kg.qq.com:8443/', 'file:///C:/secret', 'javascript:alert(1)', 'https://y.qq.com/']) {
    assert.equal(isTrustedQmkgLoginUrl(url), false, url);
  }
});

test('an existing K-song browser session is reused only after remote validation and never returns credentials', async () => {
  const { bridge, state } = harness({ cookies: syntheticCookies() });
  const result = await bridge.open(null);
  assert.equal(result.ok, true);
  assert.equal(result.reused, true);
  assert.equal(result.authValidated, true);
  assert.equal(state.imports.length, 1);
  assert.equal(state.imports[0].settings.source, 'web');
  assert.equal(state.windows.length, 0);
  assert.equal(result.cookie, undefined);
  assert.equal(result.openkey, undefined);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-k-song-openkey|must-never-return/);
});

test('cookie presence and other-platform validation do not claim a successful K-song login', async () => {
  for (const status of [
    { provider: 'qmkg', loggedIn: true, authValidated: false },
    { provider: 'netease', loggedIn: true, authValidated: true },
  ]) {
    const { bridge, state } = harness({ cookies: syntheticCookies(), importCookie: async () => status });
    const completion = bridge.open(null);
    await tick();
    assert.equal(state.windows.length, 1);
    state.windows[0].close();
    const result = await completion;
    assert.equal(result.ok, false);
    assert.equal(result.cancelled, true);
    assert.equal(result.cookie, undefined);
  }
});

test('the sandboxed official window completes after a verified scan and removes its listeners and timers', async () => {
  const { bridge, state, cookieSession } = harness();
  const completion = bridge.open(null);
  await tick();
  const window = state.windows[0];
  assert.equal(window.url, 'https://kg.qq.com/node/personal');
  assert.deepEqual(window.settings.webPreferences, { partition: 'persist:mineradio-qmkg-login', contextIsolation: true, nodeIntegration: false, sandbox: true });
  state.cookies = syntheticCookies();
  window.webContents.emit('did-finish-load');
  const result = await completion;
  assert.equal(result.ok, true);
  assert.equal(window.isDestroyed(), true);
  assert.equal(cookieSession.cookies.listenerCount('changed'), 0);
  assert.equal(state.intervals.size, 0);
  assert.equal(state.timeouts.size, 0);
  assert.match(window.script, /\.j_login/);
});

test('explicit re-login clears the dedicated browser session and popup navigation remains in the trusted window', async () => {
  const { bridge, state } = harness({ cookies: syntheticCookies() });
  const completion = bridge.open(null, { forceReauth: true });
  await tick();
  const window = state.windows[0];
  assert.equal(state.imports.length, 0);
  assert.equal(state.clears.length, 1);
  let prevented = false;
  window.webContents.emit('will-navigate', { preventDefault() { prevented = true; } }, 'https://attacker.invalid/');
  assert.equal(prevented, true);
  assert.equal(window.popup({ url: 'https://node.kg.qq.com/login' }).action, 'deny');
  assert.equal(window.url, 'https://node.kg.qq.com/login');
  window.popup({ url: 'https://attacker.invalid/' });
  assert.equal(window.url, 'https://node.kg.qq.com/login');
  window.close();
  assert.equal((await completion).cancelled, true);
});

test('concurrent open calls share one official window and a timeout cancels cleanly', async () => {
  const { bridge, state } = harness();
  const first = bridge.open(null);
  const second = bridge.open(null);
  assert.equal(first, second);
  await tick();
  assert.equal(state.windows.length, 1);
  for (const [callback, ms] of state.timeouts) if (ms === 1000) callback();
  const result = await first;
  assert.equal(result.error, 'QMKG_LOGIN_TIMEOUT');
  assert.equal(state.windows[0].isDestroyed(), true);
  assert.equal(state.intervals.size, 0);
});

test('logging out waits for in-flight validation and clears saved state after any late success', async () => {
  let finishImport;
  const pendingStatus = new Promise(resolve => { finishImport = resolve; });
  const { bridge, state } = harness({ importCookie: () => pendingStatus });
  const opened = bridge.open(null);
  await tick();
  state.cookies = syntheticCookies();
  state.windows[0].webContents.emit('did-finish-load');
  await tick();
  const cleared = bridge.clear();
  const next = bridge.open(null);
  await tick();
  assert.equal(state.windows.length, 1, 'new login waits until logout completes');
  finishImport({ provider: 'qmkg', loggedIn: true, authValidated: true });
  assert.equal((await opened).cancelled, true);
  assert.equal((await cleared).ok, true);
  await tick();
  assert.equal(state.events.at(-1), 'clear-saved');
  assert.equal(state.windows.length, 2);
  state.windows[1].close();
  assert.equal((await next).cancelled, true);
});

test('K-song preload actions retain main-window trust and login-gate checks', async () => {
  const main = fs.readFileSync(path.join(__dirname, '../desktop/main.js'), 'utf8');
  const source = main.slice(main.indexOf("ipcMain.handle('qmkg-music-open-login'"), main.indexOf("ipcMain.handle('mineradio-open-update-page'"));
  const handlers = {};
  const calls = [];
  let trusted = true;
  let unlocked = true;
  vm.runInNewContext(source, {
    ipcMain: { handle: (name, fn) => { handlers[name] = fn; } },
    isTrustedMainWindowIpc: () => trusted,
    loginEasterEggGate: { isUnlocked: () => unlocked },
    loginEasterEggLockedResult: () => ({ ok: false, error: 'LOCKED' }),
    getSenderWindow: () => 'synthetic-main-window',
    openQmkgMusicLoginWindow: async (owner, settings) => { calls.push([owner, settings]); return { ok: true, provider: 'qmkg' }; },
    clearQmkgMusicLoginSession: async () => ({ ok: true }),
  });
  let desktopApi;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../desktop/preload.js'), 'utf8'), {
    require: () => ({
      contextBridge: { exposeInMainWorld: (_name, api) => { desktopApi = api; } },
      ipcRenderer: { invoke: (name, settings) => handlers[name]({}, settings) },
    }), window: { addEventListener() {} },
  });
  await desktopApi.openQmkgMusicLogin({ forceReauth: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'synthetic-main-window');
  assert.equal(calls[0][1].forceReauth, true);
  unlocked = false;
  assert.equal((await desktopApi.openQmkgMusicLogin()).error, 'LOCKED');
  trusted = false;
  assert.equal((await desktopApi.openQmkgMusicLogin()).error, 'UNTRUSTED_SENDER');
  assert.equal((await desktopApi.clearQmkgMusicLogin()).error, 'UNTRUSTED_SENDER');
  assert.equal(calls.length, 1);
});
