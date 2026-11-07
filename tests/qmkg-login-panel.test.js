'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..', 'public', 'js', 'modules');
const sources = ['01-login-modal-utils.js', '03-login-modal-flows.js'].map(file => fs.readFileSync(path.join(root, '08-account', file), 'utf8'));
const search = fs.readFileSync(path.join(root, '05-playback', '07-search.js'), 'utf8');
const normalize = search.slice(search.indexOf('function normalizeQmkgLoginStatus('), search.indexOf('function renderQmkgConnection('));
const plain = value => JSON.parse(JSON.stringify(value));
const count = (calls, event) => calls.filter(item => item[0] === event).length;

function panel() {
  const calls = [], storage = new Map();
  const input = { value: '', focus: () => calls.push(['focus-cookie']) };
  const status = { textContent: '', className: '' };
  const sandbox = {
    loginProvider: 'netease', activeAccountProvider: 'netease',
    neteaseManualCookieOpen: false, qqManualCookieOpen: false, kugouManualCookieOpen: false,
    qishuiManualCookieOpen: false, qmkgManualCookieOpen: false,
    qmkgWebLoginBusy: false, qmkgCookieBusy: false, qmkgAuthUiNotice: '', qmkgConnectionBusy: false, qmkgStatusRequestSeq: 0,
    qmkgLoginStatus: { provider: 'qmkg', loggedIn: false, sessionReady: false, playbackKeyReady: false },
    loginStatus: { loggedIn: false }, qqLoginStatus: { loggedIn: false }, kugouLoginStatus: { loggedIn: false }, qishuiLoginStatus: { loggedIn: false }, spotifyLoginStatus: { loggedIn: false },
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    document: { getElementById: id => id === 'qq-cookie-input' ? input : id === 'qr-status' ? status : null, querySelector: () => null },
    window: {},
    setTimeout: callback => { callback(); return 1; },
    showToast: message => calls.push(['toast', message]),
    loadQmkgConnectionStatus: async () => { calls.push(['cached-status']); },
    refreshQmkgConnection: async () => { calls.push(['detect-session']); },
    apiJson: async () => { throw new Error('unexpected API'); },
  };
  vm.createContext(sandbox);
  vm.runInContext(normalize + sources.join('\n'), sandbox, { filename: 'qmkg-account-bundle.js' });
  sandbox.updateLoginProviderUi = () => calls.push(['render']);
  sandbox.stopQrPoll = () => calls.push(['stop-poll']);
  sandbox.markLoginNodeConnecting = () => calls.push(['connect-animation']);
  sandbox.renderUserBtn = () => calls.push(['render-account']);
  sandbox.renderQmkgConnection = () => calls.push(['render-connection']);
  sandbox.closeLoginModal = () => calls.push(['close-modal']);
  return { sandbox, calls, storage, input, status };
}
function verified() { return { provider: 'qmkg', loggedIn: true, sessionReady: true, playbackKeyReady: true, authValidated: true, nickname: '演唱者', source: 'cookie' }; }

test('early search initialization does not access account DOM before hoisted state is assigned', () => {
  let reads = 0;
  const sandbox = { document: { getElementById: () => { reads++; throw new Error('premature DOM read'); } } };
  vm.createContext(sandbox);
  assert.doesNotThrow(() => vm.runInContext('renderLoginQmkgConnection();\n' + sources.join('\n'), sandbox));
  assert.equal(reads, 0);
  assert.deepEqual(plain(sandbox.ACCOUNT_PROVIDER_KEYS), ['netease', 'qq', 'kugou', 'qishui', 'qmkg']);
});

test('K-song is a sortable and visible account platform with the same QR and Cookie modes', () => {
  const { sandbox, storage } = panel();
  storage.set('mineradio-account-provider-order-v1', JSON.stringify(['qmkg', 'qq', 'netease', 'qishui', 'kugou']));
  assert.deepEqual(plain(sandbox.loginWorkflowProviderOrder()), ['qmkg', 'qq', 'netease', 'qishui', 'kugou']);
  assert.equal(sandbox.normalizeLoginProviderKey('qmkg'), 'qmkg');
  assert.equal(sandbox.normalizeAccountProviderKey('qmkg'), 'qmkg');
  assert.equal(sandbox.loginProviderSupportsCookieMode('qmkg'), true);
  assert.equal(sandbox.loginProviderOfficialModeText('qmkg').title, '扫码');
  sandbox.setManualCookieOpenForProvider('qmkg', true);
  assert.equal(sandbox.isManualCookieOpenForProvider('qmkg'), true);
  assert.equal(sandbox.neteaseManualCookieOpen, false);
  sandbox.saveAccountProviderVisibleList(['qmkg']);
  assert.deepEqual(plain(sandbox.accountProviderExternalRenderList()), ['qmkg']);
});

test('an expired K-song session removes its graph connection even after earlier verification', () => {
  const { sandbox } = panel();
  sandbox.loginWorkflowVerifiedSession.qmkg = true;
  sandbox.qmkgLoginStatus = verified();
  assert.equal(sandbox.hasLoginWorkflowConnection('qmkg'), true);
  assert.equal(sandbox.hasAnyPlatformLogin(), true);
  assert.equal(sandbox.firstLoggedProvider(), 'qmkg');
  sandbox.qmkgLoginStatus = { loggedIn: false, sessionReady: false, playbackKeyReady: false, reauthRequired: true };
  assert.equal(sandbox.hasLoginWorkflowConnection('qmkg'), false);
  assert.equal(sandbox.hasAnyPlatformLogin(), false);
});

test('selection only reads saved status; QR and Cookie connections use their own explicit actions', async () => {
  const { sandbox, calls } = panel();
  sandbox.openQmkgWebLogin = async () => calls.push(['official-qr']);
  sandbox.selectLoginProviderNode('qmkg');
  assert.equal(count(calls, 'cached-status'), 1);
  assert.equal(count(calls, 'official-qr'), 0);
  sandbox.connectLoginMode('official');
  assert.equal(count(calls, 'official-qr'), 1);
  sandbox.connectLoginMode('cookie');
  assert.equal(sandbox.qmkgManualCookieOpen, true);
  assert.equal(count(calls, 'official-qr'), 1);
  assert.equal(count(calls, 'detect-session'), 0);
  await sandbox.refreshQr();
  await sandbox.openProviderWebLogin();
  assert.equal(count(calls, 'official-qr'), 3);
});

test('Cookie import posts only to K-song and promotes the account only after remote validation', async () => {
  const { sandbox, calls, input } = panel();
  sandbox.loginProvider = 'qmkg';
  sandbox.qmkgManualCookieOpen = true;
  input.value = 'uid=fixture-user; openid=fixture-open; openkey=fixture-key';
  const requests = [];
  sandbox.apiJson = async (url, options) => { requests.push({ url, options }); return { ...verified(), cookie: 'must-not-reach-renderer-state', openkey: 'must-not-reach-renderer-state' }; };
  await sandbox.submitQQCookieLogin();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/qmkg/login/cookie');
  assert.equal(requests[0].options.method, 'POST');
  assert.equal(JSON.parse(requests[0].options.body).cookie.includes('fixture-key'), true);
  assert.equal(input.value, '');
  assert.equal(sandbox.activeAccountProvider, 'qmkg');
  assert.equal(sandbox.qmkgLoginStatus.authValidated, true);
  assert.equal(sandbox.qmkgLoginStatus.cookie, undefined);
  assert.equal(sandbox.qmkgLoginStatus.openkey, undefined);
  assert.equal(sandbox.qqLoginStatus.loggedIn, false);
  assert.equal(sandbox.loginStatus.loggedIn, false);
  assert.equal(sandbox.pendingCookieExportProvider, '');
  assert.equal(count(calls, 'detect-session'), 0);
});

test('failed Cookie import keeps the error visible and does not activate a platform', async () => {
  const { sandbox, input, status } = panel();
  sandbox.loginProvider = 'qmkg';
  input.value = 'fixture-invalid-cookie';
  sandbox.apiJson = async () => ({ loggedIn: false, authValidated: false, message: 'fixture-invalid-cookie' });
  await sandbox.submitQQCookieLogin();
  assert.equal(sandbox.qmkgLoginStatus.loggedIn, false);
  assert.equal(sandbox.activeAccountProvider, 'netease');
  assert.equal(input.value, 'fixture-invalid-cookie');
  assert.match(sandbox.qmkgAuthUiNotice, /未通过验证/);
  assert.doesNotMatch(status.textContent, /fixture-invalid-cookie/);
});

test('official login requires both the new bridge result and saved status to pass remote validation', async () => {
  const { sandbox, calls } = panel();
  sandbox.loginProvider = 'qmkg';
  sandbox.qmkgLoginStatus = verified();
  let requests = 0;
  sandbox.window.desktopWindow = { openQmkgMusicLogin: async () => ({ ok: true, authValidated: false }) };
  sandbox.apiJson = async () => { requests++; return verified(); };
  await sandbox.openQmkgWebLogin();
  assert.equal(requests, 0);
  assert.equal(count(calls, 'close-modal'), 0);
  assert.match(sandbox.qmkgAuthUiNotice, /未完成/);
  sandbox.window.desktopWindow.openQmkgMusicLogin = async () => ({ ok: true, authValidated: true });
  sandbox.apiJson = async url => { assert.equal(url, '/api/qmkg/status'); requests++; return verified(); };
  await sandbox.openQmkgWebLogin();
  assert.equal(requests, 1);
  assert.equal(sandbox.activeAccountProvider, 'qmkg');
  assert.equal(count(calls, 'close-modal'), 1);
});

test('logout clears only K-song and cannot route to another account logout', async () => {
  const { sandbox, calls } = panel();
  const logoutSource = fs.readFileSync(path.join(root, '08-account', '04-user-modal-logout.js'), 'utf8');
  vm.runInContext(logoutSource, sandbox);
  sandbox.activeAccountProvider = 'qmkg';
  sandbox.qmkgLoginStatus = verified();
  sandbox.closeUserModal = () => calls.push(['close-user']);
  sandbox.window.desktopWindow = { clearQmkgMusicLogin: async () => calls.push(['clear-partition']) };
  sandbox.apiJson = async (url, options) => { calls.push(['logout', url, options.method]); return { provider: 'qmkg', loggedIn: false, sessionReady: false, playbackKeyReady: false, authValidated: false }; };
  await sandbox.logoutActiveAccount();
  assert.deepEqual(plain(calls.filter(call => call[0] === 'logout')), [['logout', '/api/qmkg/logout', 'POST']]);
  assert.equal(sandbox.qmkgLoginStatus.loggedIn, false);
  assert.equal(count(calls, 'clear-partition'), 1);
});

test('compatibility settings submit only a directory and search stays in accompaniment mode', async () => {
  const { sandbox, calls } = panel();
  const cacheInput = { value: '  D:\\WeSingCache  ' };
  sandbox.document.getElementById = id => id === 'login-qmkg-cache-dir' ? cacheInput : id === 'search-input' ? { focus: () => calls.push(['focus-search']) } : null;
  sandbox.updateQmkgConnection = async (...args) => calls.push(['configure', ...args]);
  sandbox.setSearchMode = mode => calls.push(['search', mode]);
  await sandbox.saveLoginQmkgCacheDirectory();
  assert.deepEqual(plain(calls.find(call => call[0] === 'configure')), ['configure', '/api/qmkg/config', { cacheDir: 'D:\\WeSingCache' }, 'login-qmkg-cache-dir']);
  sandbox.openQmkgAccompanimentSearch();
  assert.deepEqual(plain(calls.find(call => call[0] === 'search')), ['search', 'qmkg']);
});
