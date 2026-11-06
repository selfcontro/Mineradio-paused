'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createQmkgClient } = require('../qmkg-api');

const CACHE = 'C:\\FixtureCache';
const CONFIG = 'C:\\FixtureMineradio\\qmkg.json';
const UID = '004567890123456789012345';
const KEY_A = 'fixture-openkey-a';
const KEY_B = 'fixture-openkey-b';
const cookie = (key = KEY_A) => 'ver=2.21.170;qua=fixture-pc-qua;uid=' + UID
  + ';muid=ui-identity-must-not-replace-uid;opentype=1;udid=fixture-device;openid=fixture-openid;openkey=' + key;
const logRecord = (key = KEY_A) => 'SetWebCookie strLoginUID = 99999\r\nstrCookieHeader = Cookie: ' + cookie(key) + '\r\n';

function harness(options = {}) {
  const files = new Map();
  const key = name => path.win32.normalize(name).toLowerCase();
  const reads = [];
  const listings = [];
  const writes = [];
  const calls = [];
  let handler = () => ({ code: 0, subcode: 0, data: {} });
  function put(filename, data, modified = 1) {
    files.set(key(filename), { data: Buffer.isBuffer(data) ? data : Buffer.from(data), modified });
  }
  function notFound() { const error = new Error('fixture missing file'); error.code = 'ENOENT'; return error; }
  const io = {
    async readFile(filename, encoding) {
      reads.push(filename);
      const file = files.get(key(filename));
      if (!file) throw notFound();
      return encoding ? file.data.toString(encoding) : Buffer.from(file.data);
    },
    async readdir(directory) {
      listings.push(directory);
      const prefix = key(directory).replace(/\\$/, '') + '\\';
      const entries = [...files.keys()].filter(filename => filename.startsWith(prefix)
        && !filename.slice(prefix.length).includes('\\'));
      if (!entries.length) throw notFound();
      return entries.map(filename => ({ name: path.win32.basename(filename), isFile: () => true }));
    },
    async stat(filename) {
      const file = files.get(key(filename));
      if (!file) throw notFound();
      return { size: file.data.length, mtimeMs: file.modified, isFile: () => true };
    },
    async mkdir() {},
    async writeFile(filename, data) { writes.push({ filename, data }); put(filename, data); },
    async rename(from, to) {
      const source = files.get(key(from));
      if (!source) throw notFound();
      files.set(key(to), source);
      files.delete(key(from));
    },
    async unlink(filename) { files.delete(key(filename)); },
  };
  if (options.config !== false) put(CONFIG, JSON.stringify({ cacheDir: options.cacheDir || CACHE }));
  const fetch = async (target, init) => {
    const call = { url: new URL(target), init };
    calls.push(call);
    const result = await handler(call);
    if (result && result.response) return result.response;
    const status = result && result.http || 200;
    return { ok: status >= 200 && status < 300, status,
      async text() { return typeof result === 'string' ? result : JSON.stringify(result); } };
  };
  const client = createQmkgClient({ fs: io, fetch, platform: 'win32', env: {},
    configFile: CONFIG, clock: () => 123456789, ...options.clientOptions });
  return { client, files, reads, listings, writes, calls, put,
    setHandler(next) { handler = next; },
    setLog(text, modified = 1, name = 'client.log', root = CACHE, utf16 = false) {
      const bytes = utf16 ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]) : text;
      put(path.win32.join(root, 'Log', 'WeSing', name), bytes, modified);
    },
  };
}

function mediaResult(extra = {}) {
  return { code: 0, subcode: 0, data: { 'GetSongUrl|96|1': {
    track_url: 'https://dl.stream.qqmusic.qq.com/fixture-accompaniment.m4a?vkey=fixture-signed-value',
    song_url: 'https://dl.stream.qqmusic.qq.com/original-vocals.m4a', interval: 180, ...extra,
  } } };
}

test('ordinary status reads configuration without accessing official client logs', async () => {
  const h = harness();
  h.setLog(logRecord());
  const state = await h.client.getStatus();
  assert.equal(state.configured, true);
  assert.equal(state.cacheDir, CACHE);
  assert.equal(state.sessionReady, false);
  assert.equal(state.checkedAt, 0);
  assert.deepEqual(h.listings, []);
  assert.deepEqual(h.reads, [CONFIG]);
  assert.equal(h.calls.length, 0);
});

test('search maps offset to page, normalizes milliseconds and never discovers an account', async () => {
  const h = harness();
  h.setHandler(({ url, init }) => {
    assert.equal(url.hostname, 'node.kg.qq.com');
    assert.equal(url.searchParams.get('cmd'), 'search.search');
    assert.equal(url.searchParams.get('t_curpage'), '3');
    assert.equal(url.searchParams.get('t_numperpage'), '5');
    assert.equal(url.searchParams.get('t_s_key'), '测试歌曲');
    assert.equal(init.redirect, 'error', 'account headers must not follow HTTP redirects');
    assert(!init.headers.cookie.includes(KEY_A));
    return { code: 0, data: { 'search.search': { totalnum: 12, v_song: [
      { strKSongMid: 'fixtureMid', strSongName: '测试', strSingerName: '歌手', iPlayinterval: 181, strAlbumMid: 'album01' },
    ] } } };
  });
  const result = await h.client.search('测试歌曲', { limit: 5, offset: 10 });
  assert.equal(result.songs[0].duration, 181000);
  assert.equal(result.songs[0].provider, 'qmkg');
  assert.equal(result.songs[0].accompaniment, true);
  assert.equal(result.songs[0].playbackMode, 'accompaniment');
  assert.equal(result.nextOffset, 11);
  assert.equal(result.hasMore, true);
  assert.deepEqual(h.listings, []);
  assert.deepEqual(h.reads, []);
});

test('song details use the song-info command without session discovery', async () => {
  const h = harness();
  h.setHandler(({ url }) => {
    assert.equal(url.searchParams.get('cmd'), 'ksonginfo.get');
    assert.equal(url.searchParams.get('t_strKSongMid'), 'fixtureMid');
    assert.deepEqual(JSON.parse(url.searchParams.get('t_mapContent')), { emContentType: 0 });
    return { code: 0, data: { 'ksonginfo.get': { strKSongName: '详情', strSingerName: '歌手', iDuration: 314000 } } };
  });
  const result = await h.client.getSongInfo('fixtureMid');
  assert.equal(result.song.id, 'fixtureMid');
  assert.equal(result.song.name, '详情');
  assert.equal(result.song.duration, 314000, 'the real song-info response already expresses iDuration in milliseconds');
  assert.deepEqual(h.reads, []);
});

test('non-aligned offsets return the correct slice across adjacent upstream pages', async () => {
  const h = harness();
  h.setHandler(({ url }) => {
    const page = Number(url.searchParams.get('t_curpage'));
    return { code: 0, data: { 'search.search': { totalnum: 6,
      v_song: [0, 1].map(index => ({ strKSongMid: 'mid' + ((page - 1) * 2 + index) })),
    } } };
  });
  const result = await h.client.search('offset', { limit: 2, offset: 3 });
  assert.deepEqual(result.songs.map(song => song.id), ['mid3', 'mid4']);
  assert.deepEqual(h.calls.map(call => call.url.searchParams.get('t_curpage')), ['2', '3']);
  assert.equal(result.nextOffset, 5);
});

test('UTF-16 request logs preserve the HTTP uid exactly and discard unrelated cookies', async () => {
  const h = harness();
  h.setLog(logRecord() + 'strCookieHeader = Cookie: ' + cookie(KEY_B) + ';unknown=do-not-forward\r\n', 1, 'client.log', CACHE, true);
  h.setHandler(({ url, init }) => {
    assert.equal(url.searchParams.get('cmd'), 'GetSongUrl|96|1');
    assert.equal(url.searchParams.get('t_ksong_mid'), 'fixtureMid');
    assert(init.headers.cookie.includes('uid=' + UID + ';'));
    assert(!init.headers.cookie.includes('uid=99999'));
    assert(init.headers.cookie.includes('openkey=' + KEY_B));
    assert(!init.headers.cookie.includes('unknown='));
    let hash = 5381;
    for (const char of KEY_B) hash += (hash << 5) + char.charCodeAt(0);
    assert.equal(url.searchParams.get('g_tk_openkey'), String(hash & 2147483647));
    assert(!url.toString().includes(KEY_B), 'raw account credentials belong in the cookie header only');
    return mediaResult();
  });
  const result = await h.client.getSongUrl('fixtureMid');
  assert.equal(result.playable, true);
  assert.equal(result.source, 'qmkg-accompaniment');
  assert.equal(result.playbackMode, 'accompaniment');
  assert(!result.url.includes('original-vocals'));
  const state = await h.client.getStatus();
  assert.equal(state.authValidated, true);
  assert.equal(state.playbackKeyReady, true);
  const serialized = JSON.stringify(state);
  for (const value of [KEY_A, KEY_B, UID, 'fixture-openid', 'strCookieHeader']) assert(!serialized.includes(value));
});

test('rotation discovers the newest request log and accepts a pasted log-directory path', async () => {
  const h = harness();
  h.setLog(logRecord(KEY_A), 1, 'older.log');
  h.setLog(logRecord(KEY_B), 2, 'newer.log');
  h.setHandler(({ init }) => {
    assert(init.headers.cookie.includes(KEY_B));
    return mediaResult();
  });
  const state = await h.client.configure({ cacheDir: CACHE + '\\Log\\WeSing' });
  assert.equal(state.cacheDir, CACHE);
  assert.equal(state.authValidated, false);
  assert.equal(state.sessionReady, true);
  assert.equal(h.writes.length, 1);
  assert.deepEqual(JSON.parse(h.writes[0].data), { cacheDir: CACHE });
  await h.client.getSongUrl('fixtureMid');
});

test('a newest empty header invalidates the account instead of reviving an older session', async () => {
  const h = harness();
  h.setLog(logRecord(KEY_A), 1, 'old.log');
  h.setLog(logRecord(KEY_B) + 'strCookieHeader = Cookie: uid=;openid=;openkey=\r\n', 2, 'new.log');
  const result = await h.client.getSongUrl('fixtureMid');
  assert.equal(result.playable, false);
  assert.equal(result.error, 'QMKG_SESSION_MISSING');
  assert.equal(h.calls.length, 0);
});

test('original vocals are never used when the accompaniment is unavailable', async () => {
  const h = harness();
  h.setLog(logRecord());
  h.setHandler(() => mediaResult({ track_url: '' }));
  const result = await h.client.getSongUrl('fixtureMid');
  assert.equal(result.playable, false);
  assert.equal(result.url, '');
  assert.equal(result.error, 'QMKG_NO_ACCOMPANIMENT');
  assert.equal(result.playbackMode, 'accompaniment');
  assert(!JSON.stringify(result).includes('original-vocals'));
});

test('expired sessions are reread once and retried only when the official client rotated its key', async () => {
  const h = harness();
  h.setLog(logRecord(KEY_A));
  h.setHandler(({ init }) => {
    if (h.calls.length === 1) {
      assert(init.headers.cookie.includes(KEY_A));
      h.setLog(logRecord(KEY_B), 2);
      return { code: 1, subcode: -10003, message: 'private upstream detail ' + KEY_A };
    }
    assert(init.headers.cookie.includes(KEY_B));
    return mediaResult();
  });
  const result = await h.client.getSongUrl('fixtureMid');
  assert.equal(result.playable, true);
  assert.equal(h.calls.length, 2);
  assert.equal((await h.client.getStatus()).authValidated, true);
});

test('unchanged rejected credentials are not retried or revived by a manual refresh', async () => {
  const h = harness();
  h.setLog(logRecord());
  h.setHandler(() => ({ code: 1, subcode: -10003 }));
  const result = await h.client.getSongUrl('fixtureMid');
  assert.equal(result.reauthRequired, true);
  assert.equal(h.calls.length, 1);
  const state = await h.client.getStatus({ refresh: true });
  assert.equal(state.reauthRequired, true);
  assert.equal(state.sessionReady, false);
  await h.client.getSongUrl('fixtureMid');
  assert.equal(h.calls.length, 1);
});

test('rejected-session status stays expired when rereading a just-cleared client header', async () => {
  const h = harness();
  h.setLog(logRecord());
  h.setHandler(() => {
    h.setLog('strCookieHeader = Cookie: uid=;openid=;openkey=\r\n', 2);
    return { code: 1, subcode: -10003 };
  });
  const result = await h.client.getSongUrl('fixtureMid');
  assert.equal(result.reauthRequired, true);
  assert.equal((await h.client.getStatus()).reauthRequired, true);
  assert.equal(h.calls.length, 1);
});

test('explicit custom paths do not silently fall back to another local account', async () => {
  const h = harness({ cacheDir: 'E:\\CustomCache' });
  h.setLog(logRecord(), 1, 'client.log', 'D:\\WeSingCache');
  const result = await h.client.getSongUrl('fixtureMid');
  assert.equal(result.error, 'QMKG_SESSION_MISSING');
  assert.deepEqual(h.listings, ['E:\\CustomCache\\Log\\WeSing']);
  assert.equal(h.calls.length, 0);
});

test('automatic discovery supports the APPDATA WeSing cache directory', async () => {
  const h = harness({ config: false, clientOptions: { env: { APPDATA: 'C:\\FixtureAppData' } } });
  const root = 'C:\\FixtureAppData\\Tencent\\WeSing\\WeSingCache';
  h.setLog(logRecord(), 1, 'client.log', root);
  const state = await h.client.getStatus({ refresh: true });
  assert.equal(state.cacheDir, root);
  assert.equal(state.sessionReady, true);
});

test('invalid saved configuration never triggers unrelated default account discovery', async () => {
  const h = harness();
  h.put(CONFIG, JSON.stringify({ cacheDir: 'not-absolute' }));
  const result = await h.client.getStatus({ refresh: true });
  assert.equal(result.error, 'QMKG_CONFIG_INVALID');
  assert.equal(result.sessionReady, false);
  assert.deepEqual(h.listings, []);
});

test('lyrics parse JSONP as data and preserve the LRC and timing adjustment', async () => {
  const h = harness();
  h.setHandler(({ url, init }) => {
    assert.equal(url.pathname, '/cgi/fcgi-bin/fcg_lyric');
    assert.equal(url.searchParams.get('ksongmid'), 'fixtureMid');
    assert.equal(init.headers.cookie, undefined);
    return 'MusicJsonCallback(' + JSON.stringify({ code: 0, data: { lyric: '[00:01.00]你好', adjust: -100 } }) + ');';
  });
  const result = await h.client.getLyric('fixtureMid');
  assert.equal(result.lyric, '[00:01.00]你好');
  assert.equal(result.lrc, result.lyric);
  assert.equal(result.adjustment, -100);
  assert.deepEqual(h.reads, []);
});

test('invalid JSONP never executes code or forwards an upstream response', async () => {
  const h = harness();
  h.setHandler(() => 'MusicJsonCallback({code: 0});globalThis.fixtureSecret="' + KEY_A + '"');
  await assert.rejects(h.client.getLyric('fixtureMid'), error => {
    assert.equal(error.code, 'QMKG_INVALID_RESPONSE');
    assert(!String(error).includes(KEY_A));
    return true;
  });
  assert.equal(globalThis.fixtureSecret, undefined);
});

test('timeouts cover both network headers and a stalled response body', async () => {
  for (const stalledBody of [false, true]) {
    const h = harness({ clientOptions: { timeoutMs: 10 } });
    h.setHandler(() => stalledBody
      ? { response: { ok: true, status: 200, text: () => new Promise(() => {}) } }
      : new Promise(() => {}));
    await assert.rejects(h.client.search('timeout'), { code: 'QMKG_REQUEST_TIMEOUT' });
    assert.equal(h.calls[0].init.signal.aborted, true);
  }
});

test('network errors are replaced with fixed private-safe messages', async () => {
  const h = harness();
  h.setHandler(() => { throw new Error('request failed, cookie=' + cookie() + ', path=C:\\Private\\client.log'); });
  await assert.rejects(h.client.search('fixture'), error => {
    assert.equal(error.code, 'QMKG_NETWORK_ERROR');
    assert(!JSON.stringify({ message: error.message, cause: error.cause }).includes(KEY_A));
    assert(!String(error).includes('C:\\Private'));
    return true;
  });
});

test('unsafe cache paths and untrusted media origins are rejected', async () => {
  const h = harness();
  for (const cacheDir of ['relative', '\\\\remote\\share', 'C:\\Cache\r\nheader']) {
    await assert.rejects(h.client.configure({ cacheDir }), { code: 'QMKG_INVALID_CACHE_DIR' });
  }
  assert.equal(h.writes.length, 0);
  h.setLog(logRecord());
  h.setHandler(() => mediaResult({ track_url: 'https://qq.com.attacker.invalid/audio.m4a' }));
  const result = await h.client.getSongUrl('fixtureMid');
  assert.equal(result.error, 'QMKG_INVALID_MEDIA_URL');
  assert.equal(result.url, '');
});

test('non-Windows status stays unavailable without reading client logs', async () => {
  const h = harness({ config: false, clientOptions: { platform: 'linux' } });
  const result = await h.client.getStatus({ refresh: true });
  assert.equal(result.error, 'QMKG_PLATFORM_UNSUPPORTED');
  assert.equal(result.loggedIn, false);
  assert.deepEqual(h.listings, []);
});
