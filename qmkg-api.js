'use strict';

// Protocol reference: DBeidachazi/KGSing (MIT), and a read-only Windows WeSing
// interoperability check. Account fields come only from the user's official
// web login, an explicitly imported Cookie, or the optional Windows client.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const PROXY_URL = 'https://node.kg.qq.com/webapp/proxy';
const LYRIC_URL = 'https://node.kg.qq.com/cgi/fcgi-bin/fcg_lyric';
const COOKIE_FIELDS = new Set(['ver', 'qua', 'uid', 'muid', 'opentype', 'udid', 'openid', 'openkey']);
const MAX_LOG_BYTES = 2 * 1024 * 1024;
const MAX_LOG_FILES = 6;
const MESSAGES = Object.freeze({
  QMKG_SESSION_MISSING: '请在 Windows 全民 K 歌中登录并打开一首歌曲，再点击检测连接。',
  QMKG_SESSION_EXPIRED: '全民 K 歌会话已失效，请在官方客户端重新登录并打开歌曲，再检测连接。',
  QMKG_PLATFORM_UNSUPPORTED: '当前仅支持读取 Windows 全民 K 歌客户端的会话。',
  QMKG_INVALID_CACHE_DIR: '请输入本机全民 K 歌缓存目录的绝对路径。',
  QMKG_CONFIG_INVALID: '全民 K 歌路径配置无法读取，请重新设置缓存目录。',
  QMKG_CONFIG_WRITE_FAILED: '全民 K 歌路径配置保存失败。',
  QMKG_REQUEST_TIMEOUT: '全民 K 歌请求超时，请稍后重试。',
  QMKG_NETWORK_ERROR: '无法连接全民 K 歌，请稍后重试。',
  QMKG_HTTP_ERROR: '全民 K 歌暂时未接受该请求，请稍后重试。',
  QMKG_INVALID_RESPONSE: '全民 K 歌返回的数据格式暂不受支持。',
  QMKG_REMOTE_ERROR: '全民 K 歌未返回可用结果，请稍后重试。',
  QMKG_NO_ACCOMPANIMENT: '当前歌曲没有返回可用伴奏，请选择其他歌曲。',
  QMKG_INVALID_MEDIA_URL: '全民 K 歌返回的伴奏地址暂不受支持。',
  QMKG_TRACK_ID_INVALID: '全民 K 歌歌曲标识无效。',
  QMKG_SEARCH_INVALID: '请输入有效的歌曲名或歌手名。',
  QMKG_COOKIE_INVALID: '全民 K 歌 Cookie 不完整，需要 uid、openid 和 openkey。请从官方网页登录会话重新导入。',
  QMKG_COOKIE_STORAGE_FAILED: '全民 K 歌登录状态保存失败，请重试。',
  QMKG_OPERATION_CANCELLED: '登录操作已取消，请重新操作。',
});

function failure(code) {
  const error = new Error(MESSAGES[code] || MESSAGES.QMKG_REMOTE_ERROR);
  error.code = code;
  return error;
}

function csrfToken(openkey) {
  let value = 5381;
  for (let index = 0; index < openkey.length; index++) value += (value << 5) + openkey.charCodeAt(index);
  return value & 2147483647;
}

function parseCookie(text) {
  if (typeof text !== 'string' || text.length > 32768 || /[\r\n\x00]/.test(text)) return null;
  text = text.replace(/^\s*Cookie:\s*/i, '');
  const fields = {};
  for (const part of text.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!COOKIE_FIELDS.has(name)) continue;
    if (Object.hasOwn(fields, name) || /[\x00-\x1f\x7f;]/.test(value)) return null;
    fields[name] = value;
  }
  if (!fields.uid || !fields.openid || !fields.openkey) return null;
  const cookie = Object.entries(fields).map(([key, value]) => key + '=' + value).join(';');
  return { cookie, openkey: fields.openkey, fingerprint: crypto.createHash('sha256').update(cookie).digest('hex') };
}

function latestCookieRecord(text) {
  // Do not combine individual fields from different requests or use the UI's
  // strLoginUID: that identity can differ from the actual HTTP cookie uid.
  const pattern = /\bstrCookieHeader\s*=\s*(?:Cookie:\s*)?([^\r\n]*)/gi;
  let latest = null;
  for (const match of text.matchAll(pattern)) latest = match;
  if (!latest) return null;
  return { session: parseCookie(latest[1]) };
}

function decodeLog(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.toString('utf16le');
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const copy = Buffer.from(bytes.subarray(2, bytes.length - (bytes.length % 2)));
    return copy.swap16().toString('utf16le');
  }
  let zeroes = 0;
  const sample = Math.min(bytes.length, 1024);
  for (let i = 1; i < sample; i += 2) if (bytes[i] === 0) zeroes++;
  return bytes.toString(zeroes > sample / 8 ? 'utf16le' : 'utf8');
}

function normalizeSong(song, fallbackId) {
  const id = String(song.strKSongMid || fallbackId || '');
  const albumId = String(song.strAlbumMid || '');
  // Search uses seconds (iPlayinterval); ksonginfo.get uses milliseconds
  // (iDuration). The two protocol records must not share a unit conversion.
  const duration = song.iPlayinterval !== undefined && song.iPlayinterval !== null
    ? Math.max(0, Number(song.iPlayinterval) || 0) * 1000
    : Math.max(0, Number(song.iDuration) || 0);
  return {
    provider: 'qmkg', id, ksongMid: id, providerSongId: id,
    name: String(song.strSongName || song.strKSongName || ''),
    artist: String(song.strSingerName || ''),
    album: String(song.strAlbumName || ''), albumId,
    cover: String(song.strCoverUrl || (/^[A-Za-z0-9]+$/.test(albumId)
      ? 'https://y.gtimg.cn/music/photo_new/T002R300x300M000' + albumId + '.jpg' : '')),
    duration,
    accompaniment: true, playbackMode: 'accompaniment',
  };
}

function trackId(value) {
  const id = String(value || '').trim();
  if (!/^[A-Za-z0-9]{1,80}$/.test(id)) throw failure('QMKG_TRACK_ID_INVALID');
  return id;
}

function createQmkgClient(options = {}) {
  const io = options.fs || fs;
  const fetchImpl = options.fetch || globalThis.fetch;
  const clock = options.clock || Date.now;
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const paths = platform === 'win32' ? path.win32 : path;
  const configFile = options.configFile || env.QMKG_CONFIG_FILE || '';
  const cookieFile = options.cookieFile || env.QMKG_COOKIE_FILE || '';
  const credentialCodec = options.credentialCodec || {
    encode: value => ({ encoding: 'local', value }),
    decode: value => value && value.encoding === 'local' ? value.value : '',
  };
  const timeoutMs = Math.max(1, Number(options.timeoutMs) || 12000);
  let configuredCacheDir = '';
  let configLoaded;
  let configError = '';
  let activeCacheDir = '';
  let session = null;
  let sessionError = '';
  let authValidated = false;
  let checkedAt = 0;
  let refreshPending = null;
  let credentialLoaded;
  let nativeSessionEnabled = true;
  let sessionSource = 'none';
  let profile = {};
  let authGeneration = 0;
  let persistenceQueue = Promise.resolve();
  let validationSongId = options.validationSongId || '';
  const rejectedSessions = new Set();

  function normalizeDirectory(raw) {
    const value = String(raw == null ? '' : raw).trim();
    if (!value) return '';
    if (/[\x00-\x1f\x7f]/.test(value) || /^[\\/]{2}/.test(value) || !paths.isAbsolute(value)) {
      throw failure('QMKG_INVALID_CACHE_DIR');
    }
    // Accept a pasted Log/WeSing directory, but retain only the cache root.
    return paths.normalize(value).replace(/[\\/]Log(?:[\\/]WeSing)?[\\/]*$/i, '');
  }

  async function loadConfig() {
    if (!configLoaded) configLoaded = (async () => {
      if (configFile) {
        try {
          const text = await io.readFile(configFile, 'utf8');
          if (text.length > 16384) throw failure('QMKG_CONFIG_INVALID');
          const config = JSON.parse(text);
          configuredCacheDir = normalizeDirectory(config.cacheDir);
          nativeSessionEnabled = config.nativeSessionEnabled !== false;
        } catch (error) {
          if (error.code !== 'ENOENT') configError = 'QMKG_CONFIG_INVALID';
        }
      }
      if (env.QMKG_CACHE_DIR) {
        try { configuredCacheDir = normalizeDirectory(env.QMKG_CACHE_DIR); }
        catch (_) { configError = 'QMKG_INVALID_CACHE_DIR'; }
      }
    })();
    await configLoaded;
  }

  async function atomicJson(filename, value, code) {
    if (!filename) return;
    const temporary = filename + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
    try {
      await io.mkdir(paths.dirname(filename), { recursive: true });
      await io.writeFile(temporary, JSON.stringify(value) + '\n', { encoding: 'utf8', mode: 0o600 });
      await io.rename(temporary, filename);
    } catch (_) {
      try { await io.unlink(temporary); } catch (_) {}
      throw failure(code);
    }
  }

  function serializePersistence(operation) {
    const result = persistenceQueue.then(operation, operation);
    persistenceQueue = result.catch(() => {});
    return result;
  }

  function cleanProfile(value) {
    value = value && typeof value === 'object' ? value : {};
    let avatar = '';
    try {
      const url = new URL(String(value.avatar || value.head || ''));
      if (url.protocol === 'https:' && /(^|\.)(qq\.com|qpic\.cn|qlogo\.cn)$/i.test(url.hostname) && !url.username && !url.password) avatar = url.href;
    } catch (_) {}
    return {
      nickname: String(value.nick || value.nickname || '').replace(/[\x00-\x1f]/g, '').slice(0, 100),
      userId: String(value.login_uid || value.userId || '').replace(/[\x00-\x1f]/g, '').slice(0, 128),
      avatar,
    };
  }

  async function loadCredential() {
    if (!credentialLoaded) credentialLoaded = (async () => {
      if (!cookieFile) return;
      const generation = authGeneration;
      try {
        const text = await io.readFile(cookieFile, 'utf8');
        // A damaged imported account must never fall back to a different
        // account from native logs, even if its preferences file was lost.
        if (generation === authGeneration) nativeSessionEnabled = false;
        if (text.length > 65536) throw failure('QMKG_COOKIE_INVALID');
        const saved = JSON.parse(text);
        if (saved.version !== 1) throw failure('QMKG_COOKIE_INVALID');
        const decoded = await credentialCodec.decode(saved.credential);
        const parsed = parseCookie(decoded);
        if (!parsed) throw failure('QMKG_COOKIE_INVALID');
        if (generation !== authGeneration || session) return;
        session = parsed;
        sessionSource = saved.source === 'web' ? 'web' : 'cookie';
        profile = cleanProfile(saved.profile);
        nativeSessionEnabled = false;
        authValidated = false;
        sessionError = '';
      } catch (error) {
        if (generation === authGeneration && error.code !== 'ENOENT') sessionError = 'QMKG_COOKIE_INVALID';
      }
    })();
    await credentialLoaded;
  }

  async function saveNativePreference(enabled) {
    const config = { cacheDir: configuredCacheDir };
    if (!enabled) config.nativeSessionEnabled = false;
    await atomicJson(configFile, config, 'QMKG_CONFIG_WRITE_FAILED');
    nativeSessionEnabled = enabled;
  }

  function candidateRoots() {
    if (configuredCacheDir) return [configuredCacheDir];
    const roots = [];
    if (env.APPDATA) {
      roots.push(paths.join(env.APPDATA, 'Tencent', 'WeSing', 'WeSingCache'));
      roots.push(paths.join(env.APPDATA, 'Tencent', 'WeSing'));
    }
    if (platform === 'win32') {
      roots.push('D:\\WeSingCache');
      for (let letter = 67; letter <= 90; letter++) roots.push(String.fromCharCode(letter) + ':\\WeSingCache');
    }
    return [...new Set(roots.map(root => paths.normalize(root)))];
  }

  async function readLogTail(filename, size) {
    if (size <= MAX_LOG_BYTES) return io.readFile(filename);
    if (typeof io.open !== 'function') return null;
    const handle = await io.open(filename, 'r');
    try {
      // An even offset preserves the alignment of UTF-16 client logs.
      const start = Math.floor(Math.max(0, size - MAX_LOG_BYTES) / 2) * 2;
      const bytes = Buffer.alloc(Math.min(MAX_LOG_BYTES + 2, size - start));
      const result = await handle.read(bytes, 0, bytes.length, start);
      return bytes.subarray(0, result.bytesRead);
    } finally { await handle.close(); }
  }

  async function discoverSession() {
    await loadConfig();
    const generation = authGeneration;
    if (platform !== 'win32') {
      session = null;
      sessionError = 'QMKG_PLATFORM_UNSUPPORTED';
      checkedAt = clock();
      return;
    }
    if (configError) {
      session = null;
      sessionError = configError;
      authValidated = false;
      checkedAt = clock();
      return;
    }
    const files = [];
    for (const root of candidateRoots()) {
      const directory = paths.join(root, 'Log', 'WeSing');
      let entries;
      try { entries = await io.readdir(directory, { withFileTypes: true }); }
      catch (_) { continue; }
      if (!activeCacheDir) activeCacheDir = root;
      for (const entry of entries.slice(0, 2000)) {
        if (!entry.isFile() || !/\.log$/i.test(entry.name)) continue;
        const filename = paths.join(directory, entry.name);
        try {
          const info = await io.stat(filename);
          if (info.isFile() && info.size > 0) files.push({ filename, root, size: info.size, modified: info.mtimeMs });
        } catch (_) { /* A live client can rotate a log between listing and stat. */ }
      }
    }
    files.sort((a, b) => b.modified - a.modified || b.filename.localeCompare(a.filename));
    let record = null;
    for (const file of files.slice(0, MAX_LOG_FILES)) {
      try {
        const bytes = await readLogTail(file.filename, file.size);
        if (!bytes) continue;
        const parsed = latestCookieRecord(decodeLog(bytes));
        if (parsed) {
          record = parsed;
          activeCacheDir = file.root;
          break;
        }
      } catch (_) { /* Locked or removed logs must not expose local paths/errors. */ }
    }
    const next = record && record.session;
    if (generation !== authGeneration) return;
    const unchanged = !!(session && next && session.fingerprint === next.fingerprint);
    if (next && !rejectedSessions.has(next.fingerprint)) {
      session = next;
      sessionSource = 'windows-wesing-log';
      profile = {};
      sessionError = '';
      if (!unchanged) authValidated = false;
    } else {
      session = null;
      sessionSource = 'none';
      profile = {};
      authValidated = false;
      sessionError = next && rejectedSessions.has(next.fingerprint) ? 'QMKG_SESSION_EXPIRED' : 'QMKG_SESSION_MISSING';
    }
    checkedAt = clock();
  }

  async function refreshSession() {
    if (!refreshPending) refreshPending = discoverSession().finally(() => { refreshPending = null; });
    await refreshPending;
  }

  function status() {
    const available = !!session;
    const error = available ? '' : (sessionError || configError);
    return {
      provider: 'qmkg', source: available ? sessionSource : 'none',
      nickname: available ? profile.nickname || '全民 K 歌' : '全民 K 歌',
      userId: available ? profile.userId || '' : '', avatar: available ? profile.avatar || '' : '',
      configured: !!configuredCacheDir,
      cacheDir: configuredCacheDir || activeCacheDir || '',
      connectionAvailable: available, loggedIn: available,
      playbackKeyReady: available, sessionReady: available, authValidated,
      reauthRequired: error === 'QMKG_SESSION_EXPIRED',
      checkedAt, error: error || '',
      message: error ? MESSAGES[error] : available
        ? (authValidated ? '已验证全民 K 歌伴奏连接。' : '已读取本地会话，播放时将验证连接。')
        : '请扫码登录全民 K 歌，或导入官方登录 Cookie。',
    };
  }

  async function getStatus({ refresh = false } = {}) {
    await loadConfig();
    await loadCredential();
    if (refresh) {
      const generation = ++authGeneration;
      await serializePersistence(async () => {
        if (generation !== authGeneration) return;
        if (cookieFile) { try { await io.unlink(cookieFile); } catch (error) { if (error.code !== 'ENOENT') throw failure('QMKG_COOKIE_STORAGE_FAILED'); } }
        await saveNativePreference(true);
      });
      if (generation !== authGeneration) return status();
      session = null;
      sessionSource = 'none';
      profile = {};
      authValidated = false;
      await refreshSession();
    }
    return status();
  }

  async function configure({ cacheDir } = {}) {
    await loadConfig();
    await loadCredential();
    const value = normalizeDirectory(cacheDir);
    const generation = ++authGeneration;
    // Finish an existing detection before changing roots. Its result must not
    // become the account for a different directory selected by the user.
    if (refreshPending) await refreshPending;
    await serializePersistence(async () => {
      if (generation !== authGeneration) return;
      await atomicJson(configFile, { cacheDir: value }, 'QMKG_CONFIG_WRITE_FAILED');
      if (generation !== authGeneration) return;
      configuredCacheDir = value;
      nativeSessionEnabled = true;
      if (cookieFile) { try { await io.unlink(cookieFile); } catch (error) { if (error.code !== 'ENOENT') throw failure('QMKG_COOKIE_STORAGE_FAILED'); } }
    });
    if (generation !== authGeneration) return status();
    activeCacheDir = '';
    configError = '';
    session = null;
    authValidated = false;
    sessionError = '';
    await refreshSession();
    return status();
  }

  function songUrlDescriptor(id) {
    return { ns: 'mini_kg_song', ns_inbuf: 'proto_mini_kg_song', cmd: 'GetSongUrl|96|1',
      data: { ksong_mid: id }, mapExt: { l5api: { modid: 1209409, cmd: 65536 },
        wnsConfig: { appid: 1000557 }, dcapi: { interfaceId: 114300187 } } };
  }

  async function importCookie(raw, { source = 'cookie' } = {}) {
    const candidate = parseCookie(raw);
    if (!candidate) throw failure('QMKG_COOKIE_INVALID');
    await loadConfig();
    await loadCredential();
    const generation = ++authGeneration;
    if (!validationSongId) {
      const found = await search('晴天', { limit: 1 });
      validationSongId = found.songs[0] && found.songs[0].id || '';
      if (!validationSongId) throw failure('QMKG_REMOTE_ERROR');
    }
    // A successful web login alone does not prove accompaniment authorization.
    // Validate this exact credential against the protected accompaniment command.
    await proxy(songUrlDescriptor(trackId(validationSongId)), candidate);
    if (generation !== authGeneration) throw failure('QMKG_OPERATION_CANCELLED');
    let nextProfile = {};
    try { nextProfile = await fetchLoginProfile(candidate); } catch (_) { /* Profile display is optional. */ }
    if (generation !== authGeneration) throw failure('QMKG_OPERATION_CANCELLED');
    return serializePersistence(async () => {
      if (generation !== authGeneration) throw failure('QMKG_OPERATION_CANCELLED');
      const nextSource = source === 'web' ? 'web' : 'cookie';
      await saveNativePreference(false);
      configError = '';
      if (cookieFile) {
        let credential;
        try { credential = await credentialCodec.encode(candidate.cookie); }
        catch (_) { throw failure('QMKG_COOKIE_STORAGE_FAILED'); }
        await atomicJson(cookieFile, { version: 1, source: nextSource, credential, profile: nextProfile }, 'QMKG_COOKIE_STORAGE_FAILED');
      }
      if (generation !== authGeneration) throw failure('QMKG_OPERATION_CANCELLED');
      session = candidate;
      sessionSource = nextSource;
      profile = nextProfile;
      nativeSessionEnabled = false;
      authValidated = true;
      sessionError = '';
      checkedAt = clock();
      rejectedSessions.delete(candidate.fingerprint);
      return status();
    });
  }

  async function clearSession() {
    const generation = ++authGeneration;
    session = null;
    sessionSource = 'none';
    profile = {};
    nativeSessionEnabled = false;
    authValidated = false;
    sessionError = '';
    await loadConfig();
    await loadCredential();
    session = null;
    nativeSessionEnabled = false;
    return serializePersistence(async () => {
      if (cookieFile) { try { await io.unlink(cookieFile); } catch (error) { if (error.code !== 'ENOENT') throw failure('QMKG_COOKIE_STORAGE_FAILED'); } }
      await saveNativePreference(false);
      if (generation === authGeneration) { sessionSource = 'none'; profile = {}; authValidated = false; }
      return status();
    });
  }

  async function fetchLoginProfile(credential) {
    const url = new URL('https://node.kg.qq.com/cgi/fcgi-bin/fcg_login_info');
    url.searchParams.set('g_tk_openkey', String(csrfToken(credential.openkey)));
    const text = await requestText(url, { cookie: credential.cookie }, 4000, true);
    const match = text.match(/^\s*MusicJsonCallback\(([\s\S]*)\)\s*;?\s*$/);
    if (!match) return {};
    let body;
    try { body = JSON.parse(match[1]); } catch (_) { return {}; }
    return body && body.code === 0 && (!body.subcode || body.subcode === 0) ? cleanProfile(body.data) : {};
  }

  async function requestText(url, headers = {}, requestTimeoutMs = timeoutMs, legacyCharset = false) {
    const controller = new AbortController();
    let timer;
    const timedOut = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(failure('QMKG_REQUEST_TIMEOUT'));
        controller.abort();
      }, requestTimeoutMs);
    });
    try {
      return await Promise.race([(async () => {
        let response;
        try {
          response = await fetchImpl(url, { method: 'GET', headers, redirect: 'error', signal: controller.signal });
        } catch (_) { throw failure('QMKG_NETWORK_ERROR'); }
        if (response.status === 401) throw failure('QMKG_SESSION_EXPIRED');
        if (!response.ok) throw failure('QMKG_HTTP_ERROR');
        let text;
        try {
          if (legacyCharset && typeof response.arrayBuffer === 'function') {
            const contentType = response.headers && response.headers.get('content-type') || '';
            text = new TextDecoder(/charset\s*=\s*["']?utf-?8/i.test(contentType) ? 'utf-8' : 'gbk').decode(await response.arrayBuffer());
          } else text = await response.text();
        }
        catch (_) { throw failure('QMKG_INVALID_RESPONSE'); }
        if (text.length > 4 * 1024 * 1024) throw failure('QMKG_INVALID_RESPONSE');
        return text;
      })(), timedOut]);
    } finally { clearTimeout(timer); }
  }

  async function proxy(descriptor, credential) {
    const url = new URL(PROXY_URL);
    const parameters = {
      ns: descriptor.ns, ns_inbuf: descriptor.ns_inbuf || '', cmd: descriptor.cmd,
      mapExt: Buffer.from(encodeURIComponent(JSON.stringify(descriptor.mapExt))).toString('base64'),
      g_tk_openkey: csrfToken(credential ? credential.openkey : ''),
    };
    for (const [key, value] of Object.entries(descriptor.data)) {
      parameters['t_' + key] = value && typeof value === 'object' ? JSON.stringify(value) : String(value);
    }
    for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, String(value));
    const text = await requestText(url, {
      accept: 'application/json, text/plain, */*',
      cookie: credential ? credential.cookie : 'qua=V1_KMP_KG_5.0.0_001_APP_A;uid=10000;opentype=1;openid=;openkey=',
    });
    let body;
    try { body = JSON.parse(text); } catch (_) { throw failure('QMKG_INVALID_RESPONSE'); }
    if (body && (body.code === -10003 || body.subcode === -10003)) throw failure('QMKG_SESSION_EXPIRED');
    if (!body || body.code !== 0 || (body.subcode !== undefined && body.subcode !== 0)) throw failure('QMKG_REMOTE_ERROR');
    const data = body.data;
    return data && typeof data === 'object' && Object.hasOwn(data, descriptor.cmd) ? data[descriptor.cmd] : data || {};
  }

  async function search(keywords, { limit = 20, offset = 0, searchId } = {}) {
    const query = String(keywords || '').trim();
    if (!query || query.length > 200 || /[\x00-\x1f]/.test(query)) throw failure('QMKG_SEARCH_INVALID');
    limit = Math.max(1, Math.min(50, Math.floor(Number(limit) || 20)));
    offset = Math.max(0, Math.min(1000000, Math.floor(Number(offset) || 0)));
    // The service can filter records after pagination (for example by region).
    // Tiny upstream pages may be empty despite a nonzero total. Keep a stable
    // upstream window and return a cursor that skips filtered slots, not merely
    // offset + the number of surviving records.
    const pageSize = 50;
    const page = Math.floor(offset / pageSize) + 1;
    searchId = String(searchId || crypto.randomUUID()).slice(0, 128);
    const fetchPage = curpage => proxy({
      ns: 'search', cmd: 'search.search',
      data: { s_key: query, curpage, numperpage: pageSize, searchid: searchId, amend: 0 },
      mapExt: { cmdName: 'Search', dcapi: { interfaceId: 114000434 } },
    });
    const songs = [];
    let total = 0, nextOffset = offset, exhausted = false;
    let currentPage = page, rowIndex = offset % pageSize;
    // Bound sparse-page traversal so an unavailable catalogue cannot loop forever.
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await fetchPage(currentPage);
      total = Math.max(total, Number(result.totalnum) || 0);
      if (result.searchid) searchId = String(result.searchid).slice(0, 128);
      const rows = Array.isArray(result.v_song) ? result.v_song : [];
      while (rowIndex < rows.length && songs.length < limit) {
        const song = normalizeSong(rows[rowIndex++]);
        if (song.id) songs.push(song);
      }
      nextOffset = rowIndex >= rows.length ? currentPage * pageSize : (currentPage - 1) * pageSize + rowIndex;
      exhausted = total > 0 ? nextOffset >= total : rows.length < pageSize;
      if (songs.length >= limit || exhausted) break;
      currentPage++;
      rowIndex = 0;
    }
    return { provider: 'qmkg', songs, total, offset, limit, page, nextOffset,
      hasMore: !exhausted, searchId };
  }

  async function getSongInfo(value) {
    const id = trackId(value);
    const result = await proxy({
      ns: 'proto_ksonginfo', cmd: 'ksonginfo.get',
      data: { strKSongMid: id, mapContent: { emContentType: 0 }, iHitedSong: 1 },
      mapExt: { file: 'proto_ksonginfoJce', cmdName: 'GetKSongInfoReq',
        wnsConfig: { appid: 1000557 }, l5api: { modid: 294017, cmd: 1114112 } },
    });
    return { provider: 'qmkg', song: normalizeSong(result, id) };
  }

  function unavailable(id, code) {
    return { provider: 'qmkg', source: 'qmkg-accompaniment', id, url: '',
      playable: false, trial: false, accompaniment: true, playbackMode: 'accompaniment', quality: '伴奏', level: 'standard',
      error: code, message: MESSAGES[code], reauthRequired: code === 'QMKG_SESSION_EXPIRED' };
  }

  async function getSongUrl(value) {
    const id = trackId(value);
    await loadConfig();
    await loadCredential();
    if (!session && nativeSessionEnabled) await refreshSession();
    if (!session) return unavailable(id, sessionError || 'QMKG_SESSION_MISSING');
    const descriptor = songUrlDescriptor(id);
    const generation = authGeneration;
    let media;
    for (let attempt = 0; attempt < 2; attempt++) {
      const credential = session;
      if (!credential || generation !== authGeneration) return unavailable(id, 'QMKG_SESSION_MISSING');
      const nativeCredential = sessionSource === 'windows-wesing-log';
      try {
        media = await proxy(descriptor, credential);
        if (generation !== authGeneration) return unavailable(id, 'QMKG_SESSION_MISSING');
        if (session && session.fingerprint === credential.fingerprint) authValidated = true;
        break;
      } catch (error) {
        if (error.code !== 'QMKG_SESSION_EXPIRED') throw error;
        if (generation !== authGeneration) return unavailable(id, 'QMKG_SESSION_MISSING');
        rejectedSessions.add(credential.fingerprint);
        if (rejectedSessions.size > 32) rejectedSessions.delete(rejectedSessions.values().next().value);
        if (session && session.fingerprint === credential.fingerprint) session = null;
        authValidated = false;
        sessionError = 'QMKG_SESSION_EXPIRED';
        if (!nativeCredential) {
          sessionSource = 'none';
          profile = {};
          await serializePersistence(async () => {
            if (generation !== authGeneration) return;
            if (cookieFile) { try { await io.unlink(cookieFile); } catch (_) {} }
          });
          return unavailable(id, 'QMKG_SESSION_EXPIRED');
        }
        if (attempt === 0 && nativeSessionEnabled) {
          await refreshSession();
          if (session && session.fingerprint !== credential.fingerprint) continue;
        }
        sessionError = 'QMKG_SESSION_EXPIRED';
        return unavailable(id, 'QMKG_SESSION_EXPIRED');
      }
    }
    // song_url is the original vocal recording. It is never an accompaniment fallback.
    if (!media || typeof media.track_url !== 'string' || !media.track_url) return unavailable(id, 'QMKG_NO_ACCOMPANIMENT');
    let audioUrl;
    try { audioUrl = new URL(media.track_url); } catch (_) { return unavailable(id, 'QMKG_INVALID_MEDIA_URL'); }
    if (audioUrl.protocol !== 'https:' || !/(^|\.)qq\.com$/i.test(audioUrl.hostname)
      || audioUrl.username || audioUrl.password || audioUrl.port) return unavailable(id, 'QMKG_INVALID_MEDIA_URL');
    return { provider: 'qmkg', source: 'qmkg-accompaniment', id, url: audioUrl.toString(),
      playable: true, trial: false, accompaniment: true, playbackMode: 'accompaniment', quality: '伴奏', level: 'standard',
      duration: Math.max(0, Number(media.interval) || 0) * 1000 };
  }

  async function getLyric(value) {
    const id = trackId(value);
    const url = new URL(LYRIC_URL);
    url.searchParams.set('ksongmid', id);
    url.searchParams.set('outCharset', 'utf-8');
    const text = await requestText(url);
    const match = text.match(/^\s*MusicJsonCallback\(([\s\S]*)\)\s*;?\s*$/);
    if (!match) throw failure('QMKG_INVALID_RESPONSE');
    let body;
    try { body = JSON.parse(match[1]); } catch (_) { throw failure('QMKG_INVALID_RESPONSE'); }
    if (!body || body.code !== 0 || (body.subcode !== undefined && body.subcode !== 0)) throw failure('QMKG_REMOTE_ERROR');
    const lyric = body.data && typeof body.data.lyric === 'string' ? body.data.lyric : '';
    return { provider: 'qmkg', id, lyric, lrc: lyric, adjustment: Number(body.data && body.data.adjust) || 0 };
  }

  return { getStatus, configure, search, getSongInfo, getSongUrl, getLyric, importCookie, clearSession };
}

module.exports = { createQmkgClient };
