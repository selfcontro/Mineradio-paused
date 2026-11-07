'use strict';
// Anonymous protocol diagnostics. Never load a client profile or serialize bodies/headers.
const fs = require('node:fs/promises');
const { createQmkgClient } = require('../qmkg-api');

(async () => {
  const reports = [];
  for (const [query, limit] of [['晴天', 1], ['晴天', 15], ['周杰伦', 5]]) {
    const calls = [];
    const client = createQmkgClient({ env: {}, timeoutMs: 15000, fetch: async (url, init) => {
      const response = await fetch(url, init);
      const text = await response.clone().text();
      let body;
      try { body = JSON.parse(text); } catch (_) {}
      const data = body && body.data;
      const result = data && (data['search.search'] || data);
      calls.push({ http: response.status, contentType: response.headers.get('content-type'),
        bodyKeys: body && Object.keys(body), code: body && body.code, subcode: body && body.subcode,
        dataKeys: data && typeof data === 'object' ? Object.keys(data) : [],
        resultKeys: result && typeof result === 'object' ? Object.keys(result) : [],
        total: result && result.totalnum, rows: result && Array.isArray(result.v_song) ? result.v_song.length : null,
        firstSongKeys: result && result.v_song && result.v_song[0] ? Object.keys(result.v_song[0]) : [] });
      return response;
    } });
    try {
      const result = await client.search(query, { limit });
      reports.push({ query, limit, count: result.songs.length, total: result.total, calls });
    } catch (error) { reports.push({ query, limit, error: error.code || 'PROBE_FAILED', calls }); }
  }
  await fs.mkdir('cloud-results', { recursive: true });
  await fs.writeFile('cloud-results/search-diagnostic.json', JSON.stringify(reports, null, 2));
  console.log(JSON.stringify(reports));
})();
