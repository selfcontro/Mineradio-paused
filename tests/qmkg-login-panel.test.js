'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const moduleRoot = path.join(__dirname, '..', 'public', 'js', 'modules', '08-account');
const sources = ['01-login-modal-utils.js', '03-login-modal-flows.js'].map(file => ({
  file, content: fs.readFileSync(path.join(moduleRoot, file), 'utf8'),
}));

function panel() {
  const calls = [];
  const storage = new Map();
  const sandbox = {
    loginProvider: 'netease', activeAccountProvider: 'netease',
    neteaseManualCookieOpen: false, qqManualCookieOpen: false, kugouManualCookieOpen: false,
    qishuiManualCookieOpen: false,
    qmkgLoginStatus: { provider: 'qmkg', loggedIn: false, sessionReady: false, playbackKeyReady: false },
    qmkgConnectionBusy: false,
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    document: { getElementById: () => null, querySelector: () => null },
    window: {},
    showToast: message => calls.push(['toast', message]),
    hasPlatformLogin: () => false,
    loadQmkgConnectionStatus: async () => { calls.push(['cached-status']); },
    refreshQmkgConnection: async () => { calls.push(['detect-session']); return { provider: 'qmkg' }; },
    apiJson: async () => { throw new Error('an accompaniment panel action must not call another account API'); },
  };
  vm.createContext(sandbox);
  for (const source of sources) vm.runInContext(source.content, sandbox, { filename: source.file });
  sandbox.updateLoginProviderUi = () => calls.push(['render']);
  sandbox.stopQrPoll = () => calls.push(['stop-poll']);
  sandbox.markLoginNodeConnecting = () => calls.push(['connect-animation']);
  return { sandbox, calls, storage };
}

function plain(value) { return JSON.parse(JSON.stringify(value)); }
function events(calls, name) { return calls.filter(call => call[0] === name); }

test('early search initialization can call the hoisted panel renderer before account module state exists', () => {
  let initializing = true;
  let domReads = 0;
  const sandbox = {
    document: {
      getElementById() {
        domReads++;
        if (initializing) throw new Error('account DOM must not be accessed before account module initialization');
        return null;
      },
    },
  };
  vm.createContext(sandbox);
  // The loader concatenates modules. Function declarations are available while
  // the earlier search module runs, but account-module var assignments are not.
  const bundle = 'renderLoginQmkgConnection();\n' + sources.map(source => source.content).join('\n');
  assert.doesNotThrow(() => vm.runInContext(bundle, sandbox, { filename: 'search-before-account-bundle.js' }));
  assert.equal(domReads, 0);
  assert.deepEqual(plain(sandbox.ACCOUNT_PROVIDER_KEYS), ['netease', 'qq', 'kugou', 'qishui']);
  assert.deepEqual(plain(sandbox.loginWorkflowProviderOrder()), ['netease', 'qq', 'kugou', 'qishui', 'qmkg']);
  assert.deepEqual(plain(sandbox.loginWorkflowVerifiedSession), {});
  initializing = false;
  sandbox.renderLoginQmkgConnection();
  assert.equal(domReads, 1);
});

test('the connection graph adds accompaniment without changing ordinary account ordering or login modes', () => {
  const { sandbox, storage } = panel();
  const ordinary = ['netease', 'qq', 'kugou', 'qishui'];
  storage.set('mineradio-account-provider-order-v1', JSON.stringify(['qq', 'netease', 'qishui', 'kugou']));
  assert.deepEqual(plain(sandbox.ACCOUNT_PROVIDER_KEYS), ordinary);
  assert.deepEqual(plain(sandbox.accountProviderOrder()), ['qq', 'netease', 'qishui', 'kugou']);
  assert.deepEqual(plain(sandbox.loginWorkflowProviderOrder()), ['qq', 'netease', 'qishui', 'kugou', 'qmkg']);
  assert.equal(sandbox.normalizeLoginProviderKey('qmkg'), 'qmkg');
  assert.equal(sandbox.loginProviderSupportsCookieMode('qmkg'), false);
  assert.equal(sandbox.loginProviderOfficialModeText('qmkg').title, '客户端');
  sandbox.setManualCookieOpenForProvider('qmkg', true);
  assert.equal(sandbox.isManualCookieOpenForProvider('qmkg'), false);
  assert.equal(sandbox.neteaseManualCookieOpen, false);
  assert.equal(sandbox.qqManualCookieOpen, false);
});

test('a detected accompaniment connection disappears when its current session expires', () => {
  const { sandbox } = panel();
  const paths = [];
  const mrPort = { getBoundingClientRect: () => ({ left: 200, top: 50, width: 10, height: 10 }) };
  const sourcePort = { getBoundingClientRect: () => ({ left: 20, top: 50, width: 10, height: 10 }) };
  const graph = {
    clientWidth: 300, clientHeight: 150,
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    querySelector: selector => selector.includes('mr-target') ? mrPort : sourcePort,
  };
  const svg = { setAttribute() {}, firstChild: null };
  sandbox.document.getElementById = id => id === 'login-node-graph' ? graph : id === 'login-workflow-svg' ? svg : null;
  sandbox.appendWorkflowPath = (target, from, to) => paths.push({ target, from, to });
  sandbox.loginWorkflowVerifiedSession.qmkg = true;
  sandbox.qmkgLoginStatus = { provider: 'qmkg', sessionReady: true, playbackKeyReady: true };
  assert.equal(sandbox.hasLoginWorkflowConnection('qmkg'), true);
  sandbox.renderLoginWorkflowEdges();
  assert.equal(paths.length, 1);
  paths.length = 0;
  sandbox.qmkgLoginStatus = { provider: 'qmkg', sessionReady: false, playbackKeyReady: false, reauthRequired: true };
  assert.equal(sandbox.hasLoginWorkflowConnection('qmkg'), false);
  sandbox.renderLoginWorkflowEdges();
  assert.equal(paths.length, 0);
  sandbox.markLoginWorkflowConnected('qmkg');
  assert.equal(sandbox.hasLoginWorkflowConnection('qmkg'), false);
});

test('selecting the accompaniment node only reads cached status; connecting explicitly detects the client session', async () => {
  const { sandbox, calls } = panel();
  sandbox.selectLoginProviderNode('qmkg');
  assert.equal(sandbox.loginProvider, 'qmkg');
  assert.equal(events(calls, 'cached-status').length, 1);
  assert.equal(events(calls, 'detect-session').length, 0);
  await sandbox.connectLoginMode('official');
  assert.equal(events(calls, 'detect-session').length, 1);
  assert.equal(sandbox.pendingCookieExportProvider, '');
  assert.equal(sandbox.loginWorkflowVerifiedSession.qmkg, undefined);
});

test('shared login entry points route accompaniment to client detection and never generate other-platform QR codes', async () => {
  const { sandbox, calls } = panel();
  sandbox.loginProvider = 'qmkg';
  await sandbox.refreshQr();
  await sandbox.openProviderWebLogin();
  assert.equal(events(calls, 'detect-session').length, 2);
  assert.equal(sandbox.pendingCookieExportProvider, '');
});

test('accompaniment refuses Cookie import and export even when shared handlers are invoked directly', async () => {
  const { sandbox, calls } = panel();
  sandbox.loginProvider = 'qmkg';
  sandbox.selectLoginMode('cookie');
  await sandbox.connectLoginMode('cookie');
  await sandbox.submitQQCookieLogin();
  sandbox.offerLoginCookieExport('qmkg', { loggedIn: true });
  assert.equal(events(calls, 'detect-session').length, 0);
  assert.equal(sandbox.pendingCookieExportProvider, '');
  assert.equal(sandbox.loginWorkflowVerifiedSession.qmkg, undefined);
  assert.equal(sandbox.neteaseManualCookieOpen, false);
  assert.equal(sandbox.qqManualCookieOpen, false);
  assert.equal(sandbox.kugouManualCookieOpen, false);
});

test('panel settings submit only the cache directory and its search shortcut selects accompaniment', async () => {
  const { sandbox, calls } = panel();
  sandbox.loginProvider = 'qmkg';
  const cacheInput = { value: '  D:\\WeSingCache  ' };
  const searchInput = { focus: () => calls.push(['focus-search']) };
  sandbox.document.getElementById = id => id === 'login-qmkg-cache-dir' ? cacheInput : id === 'search-input' ? searchInput : null;
  sandbox.updateQmkgConnection = async (...args) => calls.push(['configure', ...args]);
  sandbox.setSearchMode = mode => calls.push(['search-mode', mode]);
  sandbox.setTimeout = callback => { callback(); return 1; };
  await sandbox.saveLoginQmkgCacheDirectory();
  assert.deepEqual(plain(events(calls, 'configure')[0]), ['configure', '/api/qmkg/config', { cacheDir: 'D:\\WeSingCache' }, 'login-qmkg-cache-dir']);
  sandbox.openQmkgAccompanimentSearch();
  assert.deepEqual(plain(events(calls, 'search-mode')), [['search-mode', 'qmkg']]);
  assert.equal(events(calls, 'focus-search').length, 1);
  assert.equal(events(calls, 'detect-session').length, 0);
});
