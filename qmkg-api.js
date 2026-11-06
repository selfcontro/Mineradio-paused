'use strict';

// Protocol reference: DBeidachazi/KGSing (MIT), and a read-only Windows WeSing
// interoperability check. Account fields come only from the user's own client.
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

function latestCookieRecord(text) {
  // Do not combine individual fields from different requests or use the UI's
  // strLoginUID: that identity can differ from the actual HTTP cookie uid.
  const pattern = /\bstrCookieHeader\s*=\s*(?:Cookie:\s*)?([^\r\n]*)/gi;
  let latest = null;
  for (const match of text.matchAll(pattern)) latest = match;
  if (!latest) return null;
  const fields = {};
  for (const part of latest[1].split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (COOKIE_FIELDS.has(name)) {
      if (Object.hasOwn(fields, name) || /[\x00-\x1f\x7f;]/.test(value)) return { session: null };
      fields[name] = value;
    }
  }
  if (!fields.uid || !fields.openid || !fields.openkey) return { session: null };
  const cookie = Object.entries(fields).map(([key, value]) => key + '=' + value).join(';');
  return { session: {
    cookie,
    openkey: fields.openkey,
    fingerprint: crypto.createHash('sha256').update(cookie).digest('hex'),
  } };
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
    const unchanged = !!(session && next && session.fingerprint === next.fingerprint);
    if (next && !rejectedSessions.has(next.fingerprint)) {
      session = next;
      sessionError = '';
      if (!unchanged) authValidated = false;
    } else {
      session = null;
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
    const error = sessionError || configError;
    return {
      provider: 'qmkg', source: 'windows-wesing-log',
      configured: !!configuredCacheDir,
      cacheDir: configuredCacheDir || activeCacheDir || '',
      connectionAvailable: available, loggedIn: available,
      playbackKeyReady: available, sessionReady: available, authValidated,
      reauthRequired: error === 'QMKG_SESSION_EXPIRED',
      checkedAt, error: error || '',
      message: error ? MESSAGES[error] : available
        ? (authValidated ? '已验证全民 K 歌伴奏连接。' : '已读取本地会话，播放时将验证连接。')
        : '在官方客户端登录并打开歌曲后，点击检测连接。',
    };
  }

  async function getStatus({ refresh = false } = {}) {
    await loadConfig();
    if (refresh) await refreshSession();
    return status();
  }

  async function configure({ cacheDir } = {}) {
    await loadConfig();
    const value = normalizeDirectory(cacheDir);
    // Finish an existing detection before changing roots. Its result must not
    // become the account for a different directory selected by the user.
    if (refreshPending) await refreshPending;
    if (configFile) {
      const temporary = configFile + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
      try {
        await io.mkdir(paths.dirname(configFile), { recursive: true });
        await io.writeFile(temporary, JSON.stringify({ cacheDir: value }, null, 2) + '\n', 'utf8');
        await io.rename(temporary, configFile);
      } catch (_) {
        try { await io.unlink(temporary); } catch (_) {}
        throw failure('QMKG_CONFIG_WRITE_FAILED');
      }
    }
    configuredCacheDir = value;
    activeCacheDir = '';
    configError = '';
    session = null;
    authValidated = false;
    sessionError = '';
    await refreshSession();
    return status();
  }

  async function requestText(url, headers = {}) {
    const controller = new AbortController();
    let timer;
    const timedOut = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(failure('QMKG_REQUEST_TIMEOUT'));
        controller.abort();
      }, timeoutMs);
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
        try { text = await response.text(); }
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
    const page = Math.floor(offset / limit) + 1;
    searchId = String(searchId || crypto.randomUUID()).slice(0, 128);
    const fetchPage = curpage => proxy({
      ns: 'search', cmd: 'search.search',
      data: { s_key: query, curpage, numperpage: limit, searchid: searchId, amend: 0 },
      mapExt: { cmdName: 'Search', dcapi: { interfaceId: 114000434 } },
    });
    const result = await fetchPage(page);
    const total = Math.max(0, Number(result.totalnum) || 0);
    const skipped = offset % limit;
    let rows = Array.isArray(result.v_song) ? result.v_song : [];
    if (skipped && rows.length > skipped && (!total || page * limit < total)) {
      const following = await fetchPage(page + 1);
      rows = rows.concat(Array.isArray(following.v_song) ? following.v_song : []);
    }
    const songs = rows.slice(skipped, skipped + limit).map(song => normalizeSong(song)).filter(song => song.id);
    const nextOffset = offset + songs.length;
    return { provider: 'qmkg', songs, total, offset, limit, page, nextOffset,
      hasMore: songs.length > 0 && (total > 0 ? nextOffset < total : songs.length >= limit),
      searchId: String(result.searchid || searchId) };
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
    if (!session) await refreshSession();
    if (!session) return unavailable(id, sessionError || 'QMKG_SESSION_MISSING');
    const descriptor = {
      ns: 'mini_kg_song', ns_inbuf: 'proto_mini_kg_song', cmd: 'GetSongUrl|96|1',
      data: { ksong_mid: id },
      mapExt: { l5api: { modid: 1209409, cmd: 65536 },
        wnsConfig: { appid: 1000557 }, dcapi: { interfaceId: 114300187 } },
    };
    let media;
    for (let attempt = 0; attempt < 2; attempt++) {
      const credential = session;
      try {
        media = await proxy(descriptor, credential);
        if (session && session.fingerprint === credential.fingerprint) authValidated = true;
        break;
      } catch (error) {
        if (error.code !== 'QMKG_SESSION_EXPIRED') throw error;
        rejectedSessions.add(credential.fingerprint);
        if (rejectedSessions.size > 32) rejectedSessions.delete(rejectedSessions.values().next().value);
        if (session && session.fingerprint === credential.fingerprint) session = null;
        authValidated = false;
        sessionError = 'QMKG_SESSION_EXPIRED';
        if (attempt === 0) {
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

  return { getStatus, configure, search, getSongInfo, getSongUrl, getLyric };
}

module.exports = { createQmkgClient };
