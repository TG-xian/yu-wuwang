const fs = require('fs');
const path = require('path');
const cookie = fs.readFileSync(path.join(__dirname, '..', '.cookie'), 'utf8').trim();
const post = (p, b) =>
  fetch('http://127.0.0.1:3000' + p + '?_t=' + Date.now() + Math.random(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...b, cookie, timestamp: Date.now() }),
  }).then((r) => r.json());

function parse(lrc) {
  const out = [];
  const re = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
  for (const line of String(lrc || '').split(/\r?\n/)) {
    const stamps = [];
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(line))) {
      const mm = Number(m[1]);
      const ss = Number(m[2]);
      const ms = Number((m[3] || '0').padEnd(3, '0').slice(0, 3));
      stamps.push(mm * 60 + ss + ms / 1000);
    }
    const text = line.replace(re, '').trim();
    for (const t of stamps) out.push({ t, text });
  }
  return out.sort((a, b) => a.t - b.t);
}

(async () => {
  const s = await post('/cloudsearch', { keywords: '海阔天空 Beyond', type: 1, limit: 1 });
  const id = s.result.songs[0].id;
  const j = await post('/lyric', { id });
  const lrc = parse(j.lrc.lyric);
  const roma = parse(j.romalrc.lyric);

  console.log('lrc 行数:', lrc.length, '| romalrc 行数:', roma.length);
  let hit = 0;
  for (const l of lrc) {
    const m = roma.find((r) => Math.abs(r.t - l.t) < 0.35);
    if (m && m.text) hit++;
  }
  console.log(`时间戳对齐命中: ${hit}/${lrc.length}`);
  console.log('\n前 6 行对照：');
  lrc.slice(3, 9).forEach((l) => {
    const m = roma.find((r) => Math.abs(r.t - l.t) < 0.35);
    console.log(`[${l.t.toFixed(2)}] ${(l.text || '·').slice(0, 22).padEnd(24)} → ${m ? m.text : '(无)'}`);
  });
})();
