const fs = require('fs');
const path = require('path');
const cookie = fs.readFileSync(path.join(__dirname, '..', '.cookie'), 'utf8').trim();
const post = (p, b) =>
  fetch('http://127.0.0.1:3000' + p + '?_t=' + Date.now() + Math.random(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...b, cookie, timestamp: Date.now() }),
  }).then((r) => r.json());

(async () => {
  const cases = ['海阔天空 Beyond', '富士山下 陈奕迅', '晴天 周杰伦'];
  for (const kw of cases) {
    const s = await post('/cloudsearch', { keywords: kw, type: 1, limit: 1 });
    const song = (s.result && s.result.songs || [])[0];
    if (!song) continue;

    for (const ep of ['/lyric', '/lyric/new']) {
      const j = await post(ep, { id: song.id, cp: false });
      const keys = Object.keys(j).filter((k) => k !== 'code');
      console.log(`\n=== ${song.name} ${ep} ===`);
      console.log('字段:', keys.join(', '));
      for (const k of keys) {
        const v = j[k];
        const text = typeof v === 'string' ? v : (v && v.lyric) || '';
        if (text && typeof text === 'string') {
          const head = text.split('\n').slice(0, 2).join(' | ').slice(0, 120);
          console.log(`  ${k}: ${head}`);
        }
      }
    }
  }
})();
