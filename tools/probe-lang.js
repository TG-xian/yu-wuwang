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
  const targets = ['海阔天空 Beyond', '晴天 周杰伦'];
  for (const kw of targets) {
    const s = await post('/cloudsearch', { keywords: kw, type: 1, limit: 1 });
    const song = (s.result && s.result.songs || [])[0];
    if (!song) { console.log(kw, '→ 无结果'); continue; }
    const d = await post('/song/detail', { ids: String(song.id) });
    const x = (d.songs || [])[0] || {};
    console.log('===', x.name, '===');
    console.log('字段:', Object.keys(x).join(','));
    console.log('alia:', JSON.stringify(x.alia), '| tns:', JSON.stringify(x.tns));
    console.log('pop:', x.pop, '| fee:', x.fee, '| dt:', x.dt);
  }
})();
