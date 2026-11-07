'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const moduleRoot = path.join(__dirname, '..', 'public', 'js', 'modules');
const files = {
  search: '05-playback/07-search.js', quality: '05-playback/00-api-quality-output.js',
  queue: '05-playback/09-queue-snapshot-autoplay.js', playback: '05-playback/13-playback-start-audio.js',
  fallback: '05-playback/11-provider-fallback.js', lyrics: '06-lyrics/00-lyrics-fetch-parse.js',
  account: '08-account/01-login-modal-utils.js', details: '05-playback/06-track-detail-lyrics-actions.js',
  cover: '05-playback/01-cover-custom-map.js', beat: '03-beat/00-tempo-worker-cache-prefetch.js',
  controls: '05-playback/14-player-controls.js', stats: '05-playback/02-listen-stats.js', home: '05-playback/05-home-actions.js'
};
const source = Object.fromEntries(Object.entries(files).map(([key, file]) => [key, fs.readFileSync(path.join(moduleRoot, file), 'utf8')]));
function load(sandbox, groups) {
  vm.createContext(sandbox);
  for (const [file, names] of Object.entries(groups)) {
    vm.runInContext(names.map(name => namedFunctionSource(source[file], name)).join('\n'), sandbox, { filename: files[file] });
  }
  return sandbox;
}
function plain(value) { return JSON.parse(JSON.stringify(value)); }
function song(id = 'abc123') { return { id, ksongMid: id, name: '晴天', artist: '周杰伦', provider: 'qmkg', source: 'qmkg', duration: 269000, playbackMode: 'accompaniment', accompaniment: true }; }
function media() { return { url: 'https://example.invalid/accompaniment.m4a', source: 'qmkg-accompaniment', provider: 'qmkg', playbackMode: 'accompaniment', accompaniment: true, level: 'standard', quality: '伴奏' }; }

test('accompaniment search stays separate, paginates anonymously and preserves distinct arrangements', async () => {
  const calls = [];
  const sandbox = load({
    qmkgLoginStatus: { loggedIn: false }, MUSIC_SEARCH_PROVIDER_ORDER: ['netease', 'qq', 'kugou', 'qishui'],
    MUSIC_SEARCH_MAX_RESULTS: 180,
    platformStatus: () => ({ loggedIn: false }),
    mergeSongSearchResults() { throw new Error('accompaniment must not use the ordinary aggregate'); },
    async apiJson(url) { calls.push(url); return { songs: [song(calls.length === 1 ? 'v1' : 'v2')], hasMore: calls.length === 1, nextOffset: calls.length, limit: 18 }; }
  }, { search: ['songProviderKey', 'searchProviderStatus', 'searchProviderCanSearch', 'searchModeProvider', 'activeSearchProvidersForMode', 'searchProviderUrl', 'searchProviderPagesHaveMore', 'fetchMusicSearchResults', 'searchCanonicalSongKey', 'mergeUniqueSearchSongPools'] });
  assert.deepEqual(plain(sandbox.activeSearchProvidersForMode('song')), ['netease', 'qq', 'kugou', 'qishui']);
  assert.deepEqual(plain(sandbox.activeSearchProvidersForMode('qmkg')), ['qmkg']);
  const first = await sandbox.fetchMusicSearchResults('晴天', 'qmkg');
  const next = await sandbox.fetchMusicSearchResults('晴天', 'qmkg', first.providerPages);
  assert.equal(first.songs[0].provider, 'qmkg');
  assert.equal(first.hasMore, true);
  assert.equal(next.hasMore, false);
  assert.equal(sandbox.mergeUniqueSearchSongPools(first.songs, next.songs).length, 2);
  assert.ok(calls.every(url => url.startsWith('/api/qmkg/search?keywords=')));
  assert.match(calls[1], /&offset=1$/);
});

test('queue, cover and restore identities preserve accompaniment without persisting playback URLs', () => {
  const sandbox = load({}, { search: ['songProviderKey', 'songSourceTagHtml'], queue: ['queueItemKey', 'playbackRestoreSongSnapshot'], cover: ['songCustomCoverKey'] });
  const item = Object.assign(song(), { resolvedPlaybackProvider: 'netease', url: 'https://secret.invalid/signed', cookie: 'do-not-store' });
  assert.equal(sandbox.songProviderKey(item), 'qmkg');
  assert.equal(sandbox.queueItemKey(item), 'qmkg:abc123');
  assert.equal(sandbox.songCustomCoverKey(item), 'qmkg:abc123');
  assert.notEqual(sandbox.queueItemKey(item), sandbox.queueItemKey({ id: item.id, provider: 'netease' }));
  const restored = sandbox.playbackRestoreSongSnapshot(item);
  assert.equal(restored.ksongMid, 'abc123');
  assert.equal(restored.accompaniment, true);
  assert.equal(restored.playbackMode, 'accompaniment');
  assert.equal(restored.url, undefined);
  assert.equal(restored.cookie, undefined);
  assert.match(sandbox.songSourceTagHtml(item, { switcher: true }), /tag-source qmkg/);
  assert.doesNotMatch(sandbox.songSourceTagHtml(item, { switcher: true }), /onclick|button/);
});

test('URL resolver and beat preload require verified accompaniment markers; quality is fixed', async () => {
  const calls = [];
  let response = media();
  const sandbox = load({ apiJson: async url => { calls.push(url); return response; } }, {
    search: ['songProviderKey'],
    quality: ['normalizePlaybackProvider', 'normalizePlaybackQualityForProvider', 'playbackQualityLabel', 'playbackQualityShortLabel', 'requireQmkgAccompanimentPlaybackData'],
    playback: ['resolveAlbumGaplessPlaybackData'], beat: ['fetchBeatPrefetchAudioUrl']
  });
  assert.equal(sandbox.normalizePlaybackProvider('qmkg'), 'qmkg');
  assert.equal(sandbox.normalizePlaybackQualityForProvider('hires', 'qmkg'), 'standard');
  assert.equal(sandbox.playbackQualityLabel('hires', 'qmkg'), '伴奏');
  assert.equal(sandbox.playbackQualityShortLabel('hires', 'qmkg'), '伴奏');
  assert.equal((await sandbox.resolveAlbumGaplessPlaybackData(song())).source, 'qmkg-accompaniment');
  assert.match(await sandbox.fetchBeatPrefetchAudioUrl(song()), /^\/api\/audio\?url=/);
  for (const override of [
    { source: 'qmkg-original' }, { provider: 'netease' }, { playbackMode: 'original' },
    { accompaniment: false }, { level: 'hires' }, { quality: '原唱' }, { trial: true }
  ]) {
    response = Object.assign(media(), override);
    assert.equal((await sandbox.resolveAlbumGaplessPlaybackData(song())).url, null);
    assert.equal(await sandbox.fetchBeatPrefetchAudioUrl(song()), null);
  }
  assert.ok(calls.every(url => url === '/api/qmkg/song/url?id=abc123'));
});

test('lyrics use K-song identity and do not search NetEase translation fallback', () => {
  const sandbox = load({}, { search: ['songProviderKey'], lyrics: ['lyricEndpointForSong', 'persistentLyricCacheKey', 'shouldFetchNeteaseLyricTranslationFallback'] });
  assert.equal(sandbox.lyricEndpointForSong(song('a/b')), '/api/qmkg/lyric?id=a%2Fb');
  assert.notEqual(sandbox.persistentLyricCacheKey(song()), sandbox.persistentLyricCacheKey({ id: 'abc123', provider: 'netease' }));
  assert.equal(sandbox.shouldFetchNeteaseLyricTranslationFallback(song(), { usableLyric: true, translationLines: [] }), false);
});

test('manual and automatic source switching never replace accompaniment with vocals', async () => {
  const notices = [];
  const sandbox = load({
    playQueue: [song()], currentIdx: 0,
    apiJson() { throw new Error('must not query other providers'); },
    showToast: text => notices.push(text)
  }, {
    search: ['songProviderKey', 'currentControlSong', 'findControlSourceMatchResult', 'toggleControlSourceSwitcher', 'switchCurrentSongSource'],
    quality: ['normalizePlaybackProvider'],
    fallback: ['alternatePlaybackProviders', 'searchAlternatePlatformSong', 'tryAutoPlaybackFallback', 'playbackRestrictionRawCategory', 'playbackRestrictionNotice']
  });
  assert.deepEqual(plain(sandbox.alternatePlaybackProviders(song())), []);
  assert.equal(await sandbox.searchAlternatePlatformSong(song(), 'netease'), null);
  assert.equal(await sandbox.tryAutoPlaybackFallback(song(), { reason: 'login_required' }, 0, 1, {}), null);
  await sandbox.switchCurrentSongSource('netease');
  sandbox.toggleControlSourceSwitcher();
  assert.equal(sandbox.playQueue[0].provider, 'qmkg');
  assert.equal(notices.length, 2);
  const notice = sandbox.playbackRestrictionNotice(song(), { reason: 'login_required' });
  assert.equal(notice.action, 'qmkg_connection');
  assert.doesNotMatch(notice.body, /降低音质|其它音源|正在打开/);
});

test('ordinary login, artist, comments and cloud actions cannot route K-song IDs to NetEase', async () => {
  const notices = [];
  const sandbox = load({
    qmkgLoginStatus: { provider: 'qmkg', loggedIn: true }, SONG_ACCOUNT_ACTION_ADAPTERS: {},
    apiJson() { throw new Error('unexpected provider API'); },
    showLoginModal() { throw new Error('unexpected ordinary account login'); },
    showToast: text => notices.push(text)
  }, {
    search: ['songProviderKey'], account: ['platformMeta', 'platformStatus'],
    details: ['songAccountProvider', 'songAccountAdapter', 'songAccountUnsupportedMessage', 'ensureLoggedInForAction', 'openArtistDetailForSong', 'resolveArtistSongForDetail', 'detailCommentsConfig', 'albumDetailUrlForSong', 'toggleLikeSong']
  });
  assert.equal(sandbox.platformMeta('qmkg').label, '全民 K 歌');
  assert.equal(sandbox.platformStatus('qmkg').provider, 'qmkg');
  assert.equal(sandbox.songAccountProvider(song()), 'qmkg');
  assert.equal(sandbox.detailCommentsConfig(song()), null);
  assert.equal(sandbox.albumDetailUrlForSong(song()), '');
  assert.equal(sandbox.ensureLoggedInForAction('qmkg'), false);
  sandbox.openArtistDetailForSong(song());
  assert.equal(await sandbox.resolveArtistSongForDetail(song(), '周杰伦'), null);
  await sandbox.toggleLikeSong(song());
  assert.ok(notices.length >= 3);
});

function element(value = '') {
  return { value, dataset: {}, hidden: true, textContent: '', disabled: false, classList: { toggle() {} } };
}
test('cached status is read separately from explicit local-session refresh/config and never sends credentials', async () => {
  const elements = Object.fromEntries(['qmkg-connection', 'qmkg-connection-status', 'qmkg-connection-message', 'qmkg-cache-dir', 'qmkg-refresh-btn', 'qmkg-save-btn'].map(id => [id, element()]));
  const calls = [];
  const sandbox = load({
    searchMode: 'qmkg', qmkgLoginStatus: {}, qmkgConnectionBusy: false, qmkgStatusRequestSeq: 0,
    document: { getElementById: id => elements[id], activeElement: null },
    apiJson: async (url, options) => { calls.push({ url, options }); return { provider: 'qmkg', source: 'windows-wesing-log', playbackKeyReady: true, authValidated: false, cacheDir: 'D:\\WeSingCache', message: '已发现本机会话' }; }
  }, { search: ['normalizeQmkgLoginStatus', 'renderQmkgConnection', 'loadQmkgConnectionStatus', 'updateQmkgConnection', 'refreshQmkgConnection', 'saveQmkgCacheDirectory'] });
  sandbox.renderQmkgConnection();
  assert.equal(calls.length, 0);
  await sandbox.loadQmkgConnectionStatus();
  assert.equal(calls[0].url, '/api/qmkg/status');
  assert.equal(calls[0].options, undefined);
  assert.equal(elements['qmkg-connection'].hidden, false);
  assert.equal(elements['qmkg-connection-status'].textContent, '已发现本机登录会话');
  elements['qmkg-cache-dir'].value = 'D:\\My Cache';
  elements['qmkg-cache-dir'].dataset.edited = 'true';
  sandbox.renderQmkgConnection();
  assert.equal(elements['qmkg-cache-dir'].value, 'D:\\My Cache');
  await sandbox.saveQmkgCacheDirectory();
  await sandbox.refreshQmkgConnection();
  assert.equal(calls[1].url, '/api/qmkg/config');
  assert.equal(calls[1].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[1].options.body), { cacheDir: 'D:\\My Cache' });
  assert.equal(calls[2].url, '/api/qmkg/session/refresh');
  assert.deepEqual(JSON.parse(calls[2].options.body), {});
  assert.doesNotMatch(JSON.stringify(calls), /cookie|openid|openkey|credential/i);
  sandbox.searchMode = 'song';
  sandbox.renderQmkgConnection();
  assert.equal(elements['qmkg-connection'].hidden, true);
});

test('startup accompaniment failure keeps its queue item and never loads home originals', () => {
  const sandbox = load({
    playQueue: [song(), { id: 1, provider: 'netease' }], currentIdx: 0,
    isQueueItemRecentlyPlaybackFailed: () => true,
    nextUnblockedQueueIndex() { throw new Error('must not skip accompaniment'); },
    clearStartupAutoplayRetryTimer() {}, forcePlaybackControlsInteractive() {}, showRestoredPlaybackControls() {},
    restoreHomeAfterStartupAutoplayFallback() { throw new Error('must preserve accompaniment queue'); }
  }, { search: ['songProviderKey'], queue: ['startupAutoplayNextPlayableIndex', 'tryStartupAutoplayHomeFallback', 'finishStartupAutoplayJob'] });
  assert.equal(sandbox.startupAutoplayNextPlayableIndex(), 0);
  assert.equal(sandbox.tryStartupAutoplayHomeFallback(1), false);
  sandbox.finishStartupAutoplayJob(false);
  assert.equal(sandbox.currentIdx, 0);
  assert.equal(sandbox.playQueue[0].provider, 'qmkg');
});

function playbackSandbox(response) {
  const notices = [];
  const calls = [];
  const noop = () => {};
  const sandbox = {
    console, playQueue: [song()], currentIdx: 0, audio: null, playMode: 'list', trackSwitchToken: 0,
    localBeatAnalysis: { active: false }, beatMapToken: 0, firstPlayDone: true, pendingPlaybackResumeAt: 0, miniQueueOpen: false,
    document: { getElementById: () => null },
    safePlaybackStep: () => null, albumGaplessSameAlbumCover: () => false,
    markRenderInteraction: noop, cancelBeatAnalysisTimer: noop, cancelBeatPrefetchTimer: noop, clearAlbumGaplessPreload: noop,
    closeGsapModal: noop, safeRenderQueuePanel: noop, suppressShelfPreviewForPlaybackSwitch: noop,
    pauseCurrentAudioForTrackSwitch: noop, switchPlaybackVisualToEmily: noop, updateCustomCoverButton: noop,
    getProviderPlaybackQuality: () => 'standard', playbackQualityCapValue: () => '', playbackQualityAboveCap: () => false,
    hideLoading: noop, forcePlaybackControlsInteractive: noop,
    handlePlaybackUnavailable: (_song, data) => notices.push(data),
    apiJson: async url => { calls.push(url); return response; },
    isPlaybackRecursionError: () => false,
    showToast: text => notices.push(text), playbackFailureToastText: err => { throw err; }
  };
  load(sandbox, { search: ['songProviderKey'], quality: ['normalizePlaybackProvider', 'normalizePlaybackQualityForProvider', 'requireQmkgAccompanimentPlaybackData'], fallback: ['tryAutoPlaybackFallback'], playback: ['playQueueAt'] });
  return { sandbox, calls, notices };
}
test('actual playback rejects original-vocal URLs including pre-resolved data before constructing audio', async () => {
  const original = Object.assign(media(), { playbackMode: 'original', accompaniment: false });
  const direct = playbackSandbox(original);
  assert.equal(await direct.sandbox.playQueueAt(0, { manual: true }), false);
  assert.deepEqual(direct.calls, ['/api/qmkg/song/url?id=abc123']);
  assert.equal(direct.notices[0].reason, 'accompaniment_required');
  assert.equal(direct.sandbox.audio, null);
  const preloaded = playbackSandbox(null);
  assert.equal(await preloaded.sandbox.playQueueAt(0, { manual: true, preResolvedPlaybackData: original }), false);
  assert.deepEqual(preloaded.calls, []);
  assert.equal(preloaded.notices[0].reason, 'accompaniment_required');
  assert.equal(preloaded.sandbox.audio, null);
});

test('resume recovery obtains a fresh accompaniment URL and still rejects an original-vocal response', async () => {
  const recovery = playbackSandbox(Object.assign(media(), { playbackMode: 'original' }));
  const sandbox = recovery.sandbox;
  Object.assign(sandbox, {
    performance: { now: () => 5000 },
    playbackResumeRecovery: { freshUrlSongKey: 'qmkg:abc123', pending: false, lastAttemptAt: 0, freshUrlAttemptCount: 0, serial: 0 },
    playbackFreshUrlRecoverySongKey: () => 'qmkg:abc123',
    playbackStallRecoveryTransaction: () => ({}),
    clearPlaybackResumeWatchdogs() {}, currentResumeSeconds: () => 42,
    sourceFallbackRecoveryIdentityActive: () => false
  });
  vm.runInContext(['canRefreshCurrentPlaybackUrlForResume', 'recoverCurrentTrackPlaybackFromFreshUrl'].map(name => namedFunctionSource(source.controls, name)).join('\n'), sandbox);
  assert.equal(sandbox.canRefreshCurrentPlaybackUrlForResume(song()), true);
  assert.equal(await sandbox.recoverCurrentTrackPlaybackFromFreshUrl('long-pause', { silent: true }), false);
  assert.deepEqual(recovery.calls, ['/api/qmkg/song/url?id=abc123']);
  assert.equal(recovery.notices[0].reason, 'accompaniment_required');
  assert.equal(sandbox.audio, null);
  assert.equal(sandbox.playQueue[0].provider, 'qmkg');
});

test('local listening history keeps accompaniment identity and never reports it to a cloud provider', () => {
  const sandbox = load({
    fetch() { throw new Error('accompaniment must not report cloud listening'); },
    songCoverSrc: () => '', songSourceLabel: () => '全民 K 歌纯伴奏'
  }, {
    search: ['songProviderKey'], queue: ['queueItemKey'],
    stats: ['listenSongSnapshot', 'listenReportProvider', 'reportListenSession'], home: ['songFromListenRecord']
  });
  const snapshot = sandbox.listenSongSnapshot(song());
  assert.equal(snapshot.accompaniment, true);
  assert.equal(snapshot.playbackMode, 'accompaniment');
  sandbox.reportListenSession({ key: 'qmkg:abc123', listenMs: 50000 }, { song: snapshot }, 269000);
  const restored = sandbox.songFromListenRecord(snapshot);
  assert.equal(restored.provider, 'qmkg');
  assert.equal(restored.ksongMid, 'abc123');
  assert.equal(restored.playbackMode, 'accompaniment');
  assert.equal(restored.duration, 269000);
});

function namedFunctionSource(source, name) {
  const declaration = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  assert.ok(declaration, `missing ${name}()`);
  const bodyStart = source.indexOf('{', declaration.index + declaration[0].length);
  let depth = 0;
  let quote = '';
  let regex = false;
  let regexClass = false;
  let lineComment = false;
  let blockComment = false;
  let escaped = false;
  for (let index = bodyStart; index < source.length; index += 1) {
    const character = source[index];
    const nextCharacter = source[index + 1];
    if (lineComment) {
      if (character === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === '*' && nextCharacter === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (regex) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '[') regexClass = true;
      else if (character === ']') regexClass = false;
      else if (character === '/' && !regexClass) regex = false;
      continue;
    }
    if (character === '/' && nextCharacter === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === '/' && nextCharacter === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === '/') {
      let previousIndex = index - 1;
      while (previousIndex >= bodyStart && /\s/.test(source[previousIndex])) previousIndex -= 1;
      const previous = source[previousIndex] || '';
      if (!previous || /[=(,:;!&|?{}\[]/.test(previous)) {
        regex = true;
        regexClass = false;
        continue;
      }
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      continue;
    }
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(declaration.index, index + 1);
    }
  }
  throw new Error(`unterminated ${name}()`);
}
