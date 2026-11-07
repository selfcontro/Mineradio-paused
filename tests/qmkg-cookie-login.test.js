'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createQmkgClient } = require('../qmkg-api');

// Every identifier and key in this file is synthetic. No test uses local
// account logs, a network service, or an OS credential store.
const ROOT = 'C:\\FixtureMineradio';
const CONFIG = ROOT + '\\qmkg-settings.json';
const CREDENTIALS = ROOT + '\\qmkg-credentials.json';
const CACHE = 'C:\\FixtureWeSingCache';
const UID = '0001234567890123456789012345';
const OPENID = 'fixture-kg-openid';
const KEY_A = 'fixture-cookie-openkey-a';
const KEY_B = 'fixture-cookie-openkey-b';
const NATIVE_KEY = 'fixture-native-another-account-key';

function cookie(key = KEY_A) {
  return 'ver=2.21.176;qua=fixture-client-qua;uid=' + UID
    + ';muid=fixture-public-ui-identity;opentype=1;udid=fixture-device;openid=' + OPENID
    + ';openkey=' + key;
}

function mediaResult() {
  return { code: 0, subcode: 0, data: { 'GetSongUrl|96|1': {
    track_url: 'https://bsy.tsmusic.kg.qq.com/fixture-accompaniment.m4a?vkey=fixture-media-token',
    song_url: 'https://bsy.tsmusic.kg.qq.com/fixture-original.m4a', interval: 180,
  } } };
}

function fixture() {
  const files = new Map();
  const reads = [];
  const writes = [];
  const listings = [];
  const calls = [];
  const encoded = [];
  const decoded = [];
  const fileKey = filename => path.win32.normalize(filename).toLowerCase();
  const missing = () => Object.assign(new Error('fixture file missing'), { code: 'ENOENT' });
  function put(filename, data, modified = 1) {
    files.set(fileKey(filename), { bytes: Buffer.isBuffer(data) ? data : Buffer.from(data), modified });
  }
  function exists(filename) { return files.has(fileKey(filename)); }
  const io = {
    async readFile(filename, encoding) {
      reads.push(filename);
      const value = files.get(fileKey(filename));
      if (!value) throw missing();
      return encoding ? value.bytes.toString(encoding) : Buffer.from(value.bytes);
    },
    async readdir(directory) {
      listings.push(directory);
      const prefix = fileKey(directory).replace(/\\$/, '') + '\\';
      const entries = [...files.keys()].filter(filename => filename.startsWith(prefix)
        && !filename.slice(prefix.length).includes('\\'));
      if (!entries.length) throw missing();
      return entries.map(filename => ({ name: path.win32.basename(filename), isFile: () => true, isDirectory: () => false }));
    },
    async stat(filename) {
      const value = files.get(fileKey(filename));
      if (!value) throw missing();
      return { size: value.bytes.length, mtimeMs: value.modified, isFile: () => true, isDirectory: () => false };
    },
    async mkdir() {},
    async chmod() {},
    async writeFile(filename, data) { writes.push({ filename, data: String(data) }); put(filename, data); },
    async rename(from, to) {
      const value = files.get(fileKey(from));
      if (!value) throw missing();
      files.set(fileKey(to), value);
      files.delete(fileKey(from));
    },
    async unlink(filename) { files.delete(fileKey(filename)); },
    async rm(filename) { files.delete(fileKey(filename)); },
  };
  const codec = {
    encode(value) {
      encoded.push(value);
      return { fixture: 1, payload: Buffer.from('fixture-sealed:' + value).toString('base64') };
    },
    decode(value) {
      decoded.push(value);
      if (!value || value.fixture !== 1 || typeof value.payload !== 'string') throw new Error('fixture codec rejected envelope');
      const text = Buffer.from(value.payload, 'base64').toString('utf8');
      if (!text.startsWith('fixture-sealed:')) throw new Error('fixture codec rejected payload');
      return text.slice('fixture-sealed:'.length);
    },
  };
  let handler = () => mediaResult();
  const fetch = async (target, init) => {
    const call = { url: new URL(target), init };
    calls.push(call);
    if (call.url.pathname.endsWith('/fcg_login_info')) {
      return new Response('MusicJsonCallback(' + JSON.stringify({ code: 0, subcode: 0,
        data: { nick: 'Fixture singer', login_uid: 'fixture-public-ui-identity' } }) + ');',
      { headers: { 'Content-Type': 'application/x-javascript;charset=utf-8' } });
    }
    const result = await handler(call);
    if (result instanceof Response) return result;
    return new Response(typeof result === 'string' ? result : JSON.stringify(result),
      { headers: { 'Content-Type': 'application/json;charset=utf-8' } });
  };
  put(CONFIG, JSON.stringify({ cacheDir: CACHE }));
  const createClient = (options = {}) => createQmkgClient({ fs: io, fetch, platform: 'win32', env: {},
    clock: () => 123456789, configFile: CONFIG, cookieFile: CREDENTIALS,
    credentialCodec: codec, validationSongId: 'fixtureMid', ...options });
  const h = { io, codec, files, reads, writes, listings, calls, encoded, decoded, put, exists, fileKey, createClient,
    setHandler(next) { handler = next; },
    setNative() {
      put(path.win32.join(CACHE, 'Log', 'WeSing', 'fixture.log'),
        Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('strCookieHeader = Cookie: '
          + cookie(NATIVE_KEY).replace('uid=' + UID + ';', 'uid=fixture-another-native-uid;') + '\r\n', 'utf16le')]));
    },
    stored() { return files.get(fileKey(CREDENTIALS))?.bytes.toString('utf8') || ''; },
    proxyCalls() { return calls.filter(call => call.url.searchParams.get('cmd') === 'GetSongUrl|96|1'); },
  };
  h.client = createClient();
  return h;
}

function safeError(error) {
  assert.match(String(error.code), /^QMKG_[A-Z_]+$/);
  assert.doesNotMatch(String(error), /fixture-cookie-openkey|fixture-kg-openid|fixture-media-token/);
  return true;
}

test('Cookie import requires the actual HTTP uid and never substitutes the public muid', async () => {
  const h = fixture();
  for (const input of [
    '', 'muid=fixture-public-ui-identity;openid=' + OPENID + ';openkey=' + KEY_A,
    cookie().replace('openid=' + OPENID, 'openid='),
    cookie().replace('openkey=' + KEY_A, 'openkey='),
    cookie() + ';openkey=fixture-duplicate-key',
    cookie() + '\r\nX-Injected: bad',
  ]) await assert.rejects(h.client.importCookie(input, { source: 'cookie' }), safeError);
  assert.equal(h.calls.length, 0);
  assert.equal(h.encoded.length, 0);
  assert.equal(h.exists(CREDENTIALS), false);
  assert.equal((await h.client.getStatus()).sessionReady, false);
});

test('a web session is validated for accompaniment with only whitelisted fields before being persisted', async () => {
  const h = fixture();
  h.setHandler(({ url, init }) => {
    assert.equal(url.searchParams.get('t_ksong_mid'), 'fixtureMid');
    assert.match(init.headers.cookie, new RegExp('(?:^|;)\\s*uid=' + UID + '(?:;|$)'));
    assert.match(init.headers.cookie, /muid=fixture-public-ui-identity/);
    assert.doesNotMatch(init.headers.cookie, /qrsig|pay_token|skey|p_skey|unrelated/);
    assert.doesNotMatch(url.toString(), /fixture-cookie-openkey|fixture-kg-openid/);
    return mediaResult();
  });
  const status = await h.client.importCookie(cookie() + ';qrsig=fixture-qr;pay_token=fixture-payment;'
    + 'skey=fixture-qq-key;p_skey=fixture-qq-pkey;unrelated=fixture-extra', { source: 'web' });
  assert.equal(status.loggedIn, true);
  assert.equal(status.sessionReady, true);
  assert.equal(status.authValidated, true);
  assert.equal(h.proxyCalls().length, 1);
  assert.equal(h.encoded.length, 1);
  const fields = value => Object.fromEntries(value.split(';').map(part => {
    const split = part.indexOf('=');
    return [part.slice(0, split).trim(), part.slice(split + 1).trim()];
  }));
  assert.deepEqual(fields(h.encoded[0]), fields(cookie()));
  assert.equal(h.exists(CREDENTIALS), true);
  assert.doesNotMatch(h.stored(), /fixture-cookie-openkey|fixture-kg-openid|fixture-payment|fixture-media-token/);
  assert.doesNotMatch(JSON.stringify(status), /fixture-cookie-openkey|fixture-kg-openid|fixture-media-token/);
  assert.deepEqual(h.listings, [], 'web login must not read the native client account');
});

test('restarting restores the codec-backed imported session without scanning another local account', async () => {
  const h = fixture();
  h.setNative();
  await h.client.importCookie(cookie(), { source: 'cookie' });
  const restored = h.createClient();
  const status = await restored.getStatus();
  assert.equal(status.loggedIn, true);
  assert.equal(status.sessionReady, true);
  assert.ok(h.decoded.length > 0);
  h.setHandler(({ init }) => {
    assert.match(init.headers.cookie, /openkey=fixture-cookie-openkey-a/);
    assert.doesNotMatch(init.headers.cookie, /fixture-native-another-account/);
    return mediaResult();
  });
  assert.equal((await restored.getSongUrl('fixtureMid')).playable, true);
  assert.deepEqual(h.listings, []);
});

test('a rejected import cannot save itself or replace a previously validated account', async () => {
  const h = fixture();
  await h.client.importCookie(cookie(), { source: 'cookie' });
  const storedBefore = h.stored();
  const encodedBefore = h.encoded.length;
  h.setHandler(({ init }) => init.headers.cookie.includes(KEY_B)
    ? { code: 1, subcode: -10003, message: 'upstream-private-' + KEY_B } : mediaResult());
  await assert.rejects(h.client.importCookie(cookie(KEY_B), { source: 'web' }), safeError);
  assert.equal(h.stored(), storedBefore);
  assert.equal(h.encoded.length, encodedBefore);
  assert.equal((await h.client.getStatus()).sessionReady, true);
  assert.equal((await h.client.getSongUrl('fixtureMid')).playable, true);
  assert.match(h.proxyCalls().at(-1).init.headers.cookie, /openkey=fixture-cookie-openkey-a/);
});

test('a failed credential save leaves the previously validated account and saved credential intact', async () => {
  const h = fixture();
  await h.client.importCookie(cookie(), { source: 'cookie' });
  const storedBefore = h.stored();
  const originalRename = h.io.rename;
  h.io.rename = async (from, to) => {
    if (to === CREDENTIALS) throw Object.assign(new Error('fixture denied ' + KEY_B), { code: 'EACCES' });
    return originalRename(from, to);
  };
  await assert.rejects(h.client.importCookie(cookie(KEY_B), { source: 'cookie' }), safeError);
  assert.equal(h.stored(), storedBefore);
  assert.equal((await h.client.getStatus()).sessionReady, true);
  assert.equal((await h.client.getSongUrl('fixtureMid')).playable, true);
  assert.match(h.proxyCalls().at(-1).init.headers.cookie, /openkey=fixture-cookie-openkey-a/);
});

test('logout stays disconnected across playback and restart until an explicit native refresh', async () => {
  const h = fixture();
  h.setNative();
  await h.client.importCookie(cookie(), { source: 'cookie' });
  const loggedOut = await h.client.clearSession();
  assert.equal(loggedOut.loggedIn, false);
  assert.equal(loggedOut.sessionReady, false);
  assert.equal(h.exists(CREDENTIALS), false);
  assert.equal((await h.client.getSongUrl('fixtureMid')).playable, false);
  const restored = h.createClient();
  assert.equal((await restored.getStatus()).sessionReady, false);
  assert.equal((await restored.getSongUrl('fixtureMid')).playable, false);
  assert.deepEqual(h.listings, []);
  const detected = await restored.getStatus({ refresh: true });
  assert.equal(detected.sessionReady, true);
  assert.ok(h.listings.length > 0);
  assert.equal((await restored.getSongUrl('fixtureMid')).playable, true);
  assert.match(h.proxyCalls().at(-1).init.headers.cookie, /openkey=fixture-native-another-account-key/);
});

test('an expired imported account never silently changes to a native-client account', async () => {
  const h = fixture();
  h.setNative();
  await h.client.importCookie(cookie(), { source: 'web' });
  h.setHandler(({ init }) => init.headers.cookie.includes(KEY_A)
    ? { code: -10003, subcode: -10003 } : mediaResult());
  const expired = await h.client.getSongUrl('fixtureMid');
  assert.equal(expired.playable, false);
  assert.equal(expired.reauthRequired, true);
  assert.equal((await h.client.getStatus()).sessionReady, false);
  assert.equal((await h.client.getSongUrl('fixtureMid')).playable, false);
  assert.deepEqual(h.listings, []);
  assert.ok(h.proxyCalls().every(call => !call.init.headers.cookie.includes(NATIVE_KEY)));
});

test('logout invalidates an in-flight web import before it can restore or persist the account', async () => {
  const h = fixture();
  h.setNative();
  let releaseValidation;
  let started;
  const validationStarted = new Promise(resolve => { started = resolve; });
  const deferred = new Promise(resolve => { releaseValidation = resolve; });
  h.setHandler(async () => { started(); await deferred; return mediaResult(); });
  const importing = h.client.importCookie(cookie(), { source: 'web' });
  // Attach the rejection handler before releasing the deliberately stalled request.
  const rejected = assert.rejects(importing, safeError);
  await validationStarted;
  await h.client.clearSession();
  releaseValidation();
  await rejected;
  assert.equal((await h.client.getStatus()).sessionReady, false);
  assert.equal(h.exists(CREDENTIALS), false);
  assert.equal((await h.client.getSongUrl('fixtureMid')).playable, false);
  assert.deepEqual(h.listings, []);
});

test('logout also cancels a native refresh queued behind a delayed preference write', async () => {
  const h = fixture();
  h.setNative();
  h.put(CONFIG, JSON.stringify({ cacheDir: CACHE, nativeSessionEnabled: false }));
  await h.client.getStatus();
  let startWrite;
  let releaseWrite;
  let startListing;
  let releaseListing;
  const writeStarted = new Promise(resolve => { startWrite = resolve; });
  const writeGate = new Promise(resolve => { releaseWrite = resolve; });
  const listingStarted = new Promise(resolve => { startListing = resolve; });
  const listingGate = new Promise(resolve => { releaseListing = resolve; });
  const originalWrite = h.io.writeFile;
  const originalListing = h.io.readdir;
  let delayed = false;
  h.io.writeFile = async (filename, value, options) => {
    if (!delayed && filename.startsWith(CONFIG + '.tmp-')) {
      delayed = true;
      startWrite();
      await writeGate;
    }
    return originalWrite(filename, value, options);
  };
  h.io.readdir = async (...args) => {
    startListing();
    await listingGate;
    return originalListing(...args);
  };
  const refreshing = h.client.getStatus({ refresh: true });
  // A cancelled stale refresh may reject or resolve with a disconnected status.
  const settledRefresh = refreshing.catch(error => { safeError(error); });
  await writeStarted;
  const clearing = h.client.clearSession();
  releaseWrite();
  await Promise.race([listingStarted, settledRefresh]);
  await clearing;
  releaseListing();
  await settledRefresh;
  assert.equal((await h.client.getStatus()).sessionReady, false);
  assert.equal((await h.client.getSongUrl('fixtureMid')).playable, false);
  assert.equal(h.exists(CREDENTIALS), false);
});
