'use strict';
const { _electron: electron } = require(process.env.PLAYWRIGHT_NODE_DIR || 'playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

const reportDir = path.resolve('cloud-results');
const interactiveLogin = process.env.QMKG_CLOUD_AUTH_TEST === '1';
const report = { platform: process.platform, osRelease: os.release(), commit: process.env.GITHUB_SHA || '', checks: {}, authenticatedPlaybackTested: false };
let app;
let mainPage;
let qaUserData;
let phase = 'prepare-clean-profile';
async function run() {
  assert.equal(process.platform, 'win32');
  await fs.mkdir(reportDir, { recursive: true });
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'qmkg-cloud-clean-'));
  qaUserData = userData;
  await fs.writeFile(path.join(userData, 'cache-settings.json'), JSON.stringify({ rootPath: path.join(userData, 'cache') }));
  await fs.writeFile(path.join(userData, '.qmkg-settings.json'), JSON.stringify({ cacheDir: '', nativeSessionEnabled: false }));
  // Skip only the local first-run easter egg; no provider account is preloaded.
  await fs.writeFile(path.join(userData, 'login-easter-egg.json'), JSON.stringify({ schema: 1, gateVersion: 'world-peace-v1', cookieResetVersion: 'world-peace-v1', resetComplete: true, unlocked: true }));
  phase = 'launch-installed-app';
  app = await electron.launch({
    executablePath: process.env.QMKG_INSTALLED_EXE,
    args: ['--mute-audio', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--autoplay-policy=no-user-gesture-required'],
    env: { ...process.env, MINERADIO_STARTUP_QA_HIDDEN: '1', MINERADIO_STARTUP_QA_USER_DATA: userData, MINERADIO_RUNTIME_NAME: 'MineradioCloud222-' + Date.now(), MINERADIO_STARTUP_QA_EXIT_MS: '0', MINERADIO_IGNORE_GPU_BLOCKLIST: '1', QMKG_CACHE_DIR: '' },
    timeout: 60000,
  });
  const page = await app.firstWindow();
  mainPage = page;
  const errors = [];
  report.rendererErrors = errors;
  report.requestedSoftwareRendering = true;
  report.graphics = await app.evaluate(({ app }) => ({ angle: app.commandLine.getSwitchValue('use-angle'), features: app.getGPUFeatureStatus() }));
  page.on('pageerror', error => errors.push(error.message.replace(/https?:\/\/\S+/g, '[url]').slice(0, 300)));
  await page.waitForFunction(() => document.body && location.hostname === '127.0.0.1' && window.desktopWindow && typeof window.desktopWindow.openQmkgMusicLogin === 'function', null, { timeout: 45000 });
  try { await page.waitForFunction(() => document.body.classList.contains('simple-mode'), null, { timeout: 15000 }); } catch (_) {}
  const uiReady = await page.evaluate(() => document.body.classList.contains('simple-mode'));
  report.checks.mainUiReady = uiReady;
  const identity = await app.evaluate(async ({ app, session }) => ({ version: app.getVersion(), userData: app.getPath('userData'), sessionData: app.getPath('sessionData'), cookies: (await session.fromPartition('persist:mineradio-qmkg-login').cookies.get({ url: 'https://kg.qq.com/' })).length }));
  assert.equal(identity.version, '2.2.2');
  assert.equal(identity.userData.toLowerCase(), userData.toLowerCase());
  assert.ok(identity.sessionData.toLowerCase().startsWith(path.join(userData, 'cache').toLowerCase()));
  assert.equal(identity.cookies, 0);
  report.checks.cleanStartup = true;
  phase = 'anonymous-search-and-no-login-playback';
  const api = await page.evaluate(async () => {
    const status = await (await fetch('/api/qmkg/status')).json();
    const response = await fetch('/api/qmkg/search?keywords=' + encodeURIComponent('晴天') + '&limit=1');
    const search = await response.json();
    const id = search.songs && search.songs[0] && search.songs[0].id;
    if (!id) return { loggedIn: status.loggedIn, search: false, searchHttp: response.status, searchKeys: Object.keys(search), searchTotal: search.total, searchRows: Array.isArray(search.songs) ? search.songs.length : null, searchError: String(search.error || search.message || search.code || 'No songs returned').replace(/https?:\/\/\S+/g, '[url]').slice(0, 300) };
    const lyric = await (await fetch('/api/qmkg/lyric?id=' + encodeURIComponent(id))).json();
    const media = await (await fetch('/api/qmkg/song/url?id=' + encodeURIComponent(id))).json();
    const after = await (await fetch('/api/qmkg/status')).json();
    return { loggedIn: status.loggedIn, search: true, timedLyrics: /\[\d+:\d+/.test(lyric.lyric || ''), blockedWithoutLogin: media.playable === false, nativeNotRead: after.checkedAt === 0 };
  });
  Object.assign(report.checks, api);
  const apiPassed = api.loggedIn === false && ['search', 'timedLyrics', 'blockedWithoutLogin', 'nativeNotRead'].every(key => api[key] === true);
  phase = 'shared-login-ui';
  if (uiReady) {
    await page.evaluate(async () => { dismissSplash({ instant: true }); if (typeof closeVisualGuide === 'function') closeVisualGuide(true); await showLoginModal({ provider: 'qmkg' }); });
    await page.waitForTimeout(800);
    assert.equal(await page.locator('#login-mode-official').isVisible(), true);
    assert.equal(await page.locator('#login-mode-cookie').isVisible(), true);
  }
  await page.screenshot({ path: path.join(reportDir, 'platform-panel.png') });
  report.checks.sharedLoginUi = uiReady;
  phase = 'official-anonymous-qr';
  const windowPromise = app.waitForEvent('window', { timeout: 45000 });
  const loginResult = page.evaluate(() => window.desktopWindow.openQmkgMusicLogin({ forceReauth: true }));
  loginResult.catch(() => {});
  const login = await windowPromise;
  await login.waitForFunction(() => { const canvas = document.querySelector('.j_login_img canvas'); return canvas && canvas.width > 0 && canvas.height > 0; }, null, { timeout: 45000 });
  const qr = await login.evaluate(() => {
    const canvas = document.querySelector('.j_login_img canvas');
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let low = 255, high = 0;
    for (let i = 0; i < pixels.length; i += 4) { low = Math.min(low, pixels[i]); high = Math.max(high, pixels[i]); }
    return { officialHost: location.hostname === 'kg.qq.com', hasQrPixels: high > low, mobileScanText: /全民K歌手机版扫描二维码/.test(document.querySelector('.j_login_wrap').innerText) };
  });
  for (const value of Object.values(qr)) assert.equal(value, true);
  Object.assign(report.checks, qr);
  if (interactiveLogin) {
    phase = 'waiting-for-mobile-confirmation';
    // Only the short-lived official challenge is transferred for the user's scan.
    // Account Cookies, browser profiles and signed media URLs remain on this VM.
    await fs.mkdir('cloud-qr', { recursive: true });
    await login.locator('.j_login_img canvas').screenshot({ path: 'cloud-qr/official-login.png' });
    await fs.writeFile('cloud-qr/ready.json', JSON.stringify({ createdAt: new Date().toISOString() }));
    const auth = await loginResult;
    report.login = { ok: auth && auth.ok === true, source: auth && auth.source, authValidated: auth && auth.authValidated === true, error: auth && auth.error };
    assert.equal(report.login.ok, true, 'Official scan did not complete');
    assert.equal(report.login.source, 'web');
    assert.equal(report.login.authValidated, true);
    phase = 'authenticated-accompaniment-and-lyrics';
    const proof = await page.evaluate(async () => {
      const search = await (await fetch('/api/qmkg/search?keywords=' + encodeURIComponent('晴天') + '&limit=5')).json();
      let selected;
      for (const song of search.songs || []) {
        const media = await (await fetch('/api/qmkg/song/url?id=' + encodeURIComponent(song.id))).json();
        const lyric = await (await fetch('/api/qmkg/lyric?id=' + encodeURIComponent(song.id))).json();
        if (!media.playable || !media.url || !/\[\d+:\d+/.test(lyric.lyric || '')) continue;
        const response = await fetch('/api/audio?url=' + encodeURIComponent(media.url), { headers: { Range: 'bytes=0-1023' } });
        const bytes = new Uint8Array(await response.arrayBuffer());
        selected = { song, accompaniment: media.accompaniment === true && media.playbackMode === 'accompaniment',
          range206: response.status === 206, mp4: String.fromCharCode(...bytes.slice(4, 8)) === 'ftyp' };
        break;
      }
      if (!selected) return { playable: false };
      closeLoginModal();
      fx.particleLyrics = true;
      playQueue = [selected.song]; currentIdx = -1;
      await playQueueAt(0);
      return { playable: true, accompaniment: selected.accompaniment, range206: selected.range206, mp4: selected.mp4 };
    });
    for (const key of ['playable', 'accompaniment', 'range206', 'mp4']) assert.equal(proof[key], true, key);
    await page.waitForFunction(() => audio && !audio.paused && !audio.error && audio.readyState >= 3 && audio.currentTime > 0.5 && lyricsLines.length >= 4, null, { timeout: 45000 });
    const startTime = await page.evaluate(() => audio.currentTime);
    await page.waitForTimeout(2500);
    proof.clockAdvances = await page.evaluate(start => audio.currentTime > start + 1 && !audio.paused && !audio.error, startTime);
    assert.equal(proof.clockAdvances, true);
    const targets = await page.evaluate(() => lyricsLines.map((line, index) => ({ index, seconds: line.t - getAdjustedLyricPlaybackTime(0) + 0.3 }))
      .filter(line => line.index > 0 && line.seconds > 1 && line.seconds < audio.duration - 2).slice(0, 3));
    assert.ok(targets.length >= 2);
    const indices = [];
    for (const target of [targets[0], targets[2] || targets[1]]) {
      await page.evaluate(seconds => { audio.currentTime = seconds; }, target.seconds);
      await page.waitForFunction(index => stageLyrics.currentIdx === index && !!stageLyrics.current && audio && !audio.paused, target.index, { timeout: 20000 });
      indices.push(await page.evaluate(() => stageLyrics.currentIdx));
    }
    proof.lyricFollowsSeek = indices[0] !== indices[1];
    assert.equal(proof.lyricFollowsSeek, true);
    Object.assign(report.checks, proof);
    report.authenticatedPlaybackTested = true;
    report.limit = 'Authenticated cloud playback verifies media decoding/playback clock and lyric rendering; no microphone recording or physical speaker listening test.';
  } else {
    await login.close();
    const cancelled = await loginResult;
    assert.notEqual(cancelled && cancelled.ok, true);
    report.limit = 'Anonymous cloud verification only; authenticated cloud playback needs a separate phone confirmation and was not tested.';
  }
  report.checks.rendererWithoutErrors = errors.length === 0;
  report.functionalIntegrationPassed = apiPassed;
  report.passed = uiReady && apiPassed && errors.length === 0;
  if (!report.passed) { report.failedPhase = !apiPassed ? 'anonymous-search-and-no-login-playback' : 'main-ui-graphics'; process.exitCode = 1; }
}

run().catch(error => {
  report.passed = false;
  report.failedPhase = phase;
  report.error = String(error.message || error).replace(/https?:\/\/\S+/g, '[url]').slice(0, 400);
  process.exitCode = 1;
}).finally(async () => {
  if (!report.passed && mainPage && !mainPage.isClosed()) {
    try {
      report.document = await mainPage.evaluate(() => ({ origin: location.origin, pathname: location.pathname, readyState: document.readyState, bodyClass: document.body && document.body.className, scriptCount: document.scripts.length, title: document.title, loginFunction: typeof openQmkgWebLogin }));
      await mainPage.screenshot({ path: path.join(reportDir, 'failed-window.png') });
    } catch (_) {}
    try {
      const state = JSON.parse(await fs.readFile(path.join(qaUserData, 'startup-state.json'), 'utf8'));
      report.startup = { phase: state.phase, navigationReadyPhase: state.navigationReadyPhase || '', lastNavigationError: String(state.lastNavigationError || '').replace(/https?:\/\/\S+/g, '[url]').slice(0, 300) };
    } catch (_) {}
  }
  if (app) {
    const closingApp = app;
    const killTimer = setTimeout(() => { try { closingApp.process().kill(); } catch (_) {} }, 10000);
    try { await closingApp.close().catch(() => {}); } finally { clearTimeout(killTimer); }
  }
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(path.join(reportDir, 'cloud-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  await fs.writeFile(path.join(reportDir, 'finished.json'), JSON.stringify({ exitCode: process.exitCode || 0 }));
});
