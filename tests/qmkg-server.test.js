'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const http = require('node:http');

test('local accompaniment API routes preserve provider data and hide credentials on failure', async (t) => {
  const calls = [];
  let failPlayback = false;
  const client = {
    getStatus: async (options) => { calls.push(['status', options]); return { provider: 'qmkg', loggedIn: false, checkedAt: 0 }; },
    configure: async (options) => { calls.push(['configure', options]); return { provider: 'qmkg', cacheDir: options.cacheDir }; },
    importCookie: async (cookie, options) => { calls.push(['import', cookie, options]); return { provider: 'qmkg', loggedIn: true, authValidated: true }; },
    clearSession: async () => { calls.push(['logout']); return { provider: 'qmkg', loggedIn: false, sessionReady: false }; },
    search: async (keywords, options) => { calls.push(['search', keywords, options]); return { provider: 'qmkg', songs: [{ id: 'abc123', provider: 'qmkg', accompaniment: true }], hasMore: false }; },
    getSongInfo: async (id) => ({ provider: 'qmkg', song: { id } }),
    getLyric: async () => ({ provider: 'qmkg', lyric: '[00:01.00]同步歌词' }),
    getSongUrl: async (id) => {
      calls.push(['url', id]);
      if (failPlayback) throw Object.assign(new Error('openkey=PRIVATE_SECRET; https://cdn.example/?vkey=PRIVATE_SECRET'), { code: 'QMKG_SESSION_EXPIRED' });
      return { provider: 'qmkg', source: 'qmkg-accompaniment', playbackMode: 'accompaniment', url: 'https://example.com/audio.m4a', playable: true };
    },
  };
  const modulePath = require.resolve('../qmkg-api');
  const saved = require.cache[modulePath];
  require.cache[modulePath] = { id: modulePath, filename: modulePath, loaded: true, exports: { createQmkgClient: () => client } };
  process.env.HOST = '127.0.0.1';
  process.env.PORT = '0';
  const server = require('../server');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    if (saved) require.cache[modulePath] = saved;
    else delete require.cache[modulePath];
  });
  if (!server.listening) await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const json = async (route, options) => {
    const response = await fetch(base + route, options);
    return { status: response.status, body: await response.json() };
  };
  const rawStatus = (headers) => new Promise((resolve, reject) => {
    const req = http.get(base + '/api/qmkg/status', { headers }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    req.on('error', reject);
  });
  const status = await json('/api/qmkg/status');
  assert.equal(status.body.provider, 'qmkg');
  assert.deepEqual(calls[0], ['status', undefined]);
  const localResponse = await fetch(base + '/api/qmkg/status');
  assert.equal(localResponse.headers.get('access-control-allow-origin'), null);
  assert.equal((await json('/api/qmkg/song/url?id=abc123', { headers: { Origin: 'https://unrelated.example' } })).status, 403);
  assert.equal(await rawStatus({ Host: 'unrelated.example' }), 403);
  assert.equal(await rawStatus({ 'Sec-Fetch-Site': 'cross-site' }), 403);
  assert.equal((await json('/api/qmkg/status', { headers: { Origin: base } })).status, 200);
  const post = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' };
  assert.equal((await json('/api/qmkg/login/cookie')).status, 405);
  assert.equal((await json('/api/qmkg/login/cookie', { ...post, body: JSON.stringify({ cookie: 123 }) })).status, 400);
  assert.equal((await json('/api/qmkg/login/cookie', { ...post, headers: { ...post.headers, Origin: 'https://unrelated.example' }, body: JSON.stringify({ cookie: 'fixture' }) })).status, 403);
  const imported = await json('/api/qmkg/login/cookie', { ...post, body: JSON.stringify({ cookie: 'uid=fixture;openid=fixture;openkey=fixture' }) });
  assert.equal(imported.body.authValidated, true);
  assert.deepEqual(calls.at(-1), ['import', 'uid=fixture;openid=fixture;openkey=fixture', { source: 'cookie' }]);
  assert.equal((await json('/api/qmkg/logout')).status, 405);
  assert.equal((await json('/api/qmkg/logout', post)).body.loggedIn, false);
  assert.deepEqual(calls.at(-1), ['logout']);
  await json('/api/qmkg/session/refresh', post);
  assert.deepEqual(calls.at(-1), ['status', { refresh: true }]);
  assert.equal((await json('/api/qmkg/session/refresh')).status, 405);
  assert.equal((await json('/api/qmkg/config', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 403);
  assert.equal((await json('/api/qmkg/config', { ...post, headers: { ...post.headers, Origin: 'https://unrelated.example' } })).status, 403);
  assert.equal((await json('/api/qmkg/config', { ...post, body: JSON.stringify({ cacheDir: 123 }) })).status, 400);
  await json('/api/qmkg/config', { ...post, body: JSON.stringify({ cacheDir: 'D:\\WeSingCache' }) });
  assert.ok(calls.some((entry) => entry[0] === 'configure' && entry[1].cacheDir === 'D:\\WeSingCache'));
  const search = await json('/api/qmkg/search?keywords=test&limit=999&offset=-5');
  assert.equal(search.body.songs[0].provider, 'qmkg');
  assert.deepEqual(calls.find((entry) => entry[0] === 'search'), ['search', 'test', { limit: 50, offset: 0 }]);
  assert.equal((await json('/api/qmkg/song/url?id=..%2Fsecret')).status, 400);
  assert.equal((await json('/api/qmkg/song/url?id=abc123')).body.playbackMode, 'accompaniment');
  assert.match((await json('/api/qmkg/lyric?id=abc123')).body.lyric, /\[00:01.00\]/);
  assert.equal((await json('/api/qmkg/song/detail?id=abc123')).body.song.id, 'abc123');
  assert.equal((await json('/api/qmkg/unknown')).status, 404);
  failPlayback = true;
  const failure = await json('/api/qmkg/song/url?id=abc123');
  assert.equal(failure.status, 401);
  assert.equal(failure.body.reauthRequired, true);
  assert.doesNotMatch(JSON.stringify(failure.body), /PRIVATE_SECRET|openkey|vkey|cdn\.example/);
  assert.equal((await json('/api/platform/capabilities')).body.qmkg.accompaniment, true);
});
