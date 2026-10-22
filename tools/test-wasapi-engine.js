/**
 * 端到端验证 WASAPI 共享：连引擎 WS，发 load{mode:'wasapi'}
 */
const fs = require('fs');
const WebSocket = require('ws');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const cookie = fs.readFileSync(path.join(ROOT, '.cookie'), 'utf8').trim();
const API = 'http://127.0.0.1:3000';

async function pickTrack() {
  const qs = new URLSearchParams({
    keywords: '周杰伦',
    type: '1',
    limit: '3',
    cookie,
    timestamp: String(Date.now()),
  });
  const s = await (await fetch(`${API}/cloudsearch?${qs}`)).json();
  const song = s.result.songs[0];
  const uq = new URLSearchParams({ id: song.id, level: 'lossless', cookie, timestamp: String(Date.now()) });
  const u = await (await fetch(`${API}/song/url/v1?${uq}`)).json();
  return { name: song.name, url: (u.data[0] || {}).url, id: song.id };
}

(async () => {
  const t = await pickTrack();
  console.log('测试曲目:', t.name, '| url:', !!t.url);
  if (!t.url) { console.log('拿不到直链，放弃'); process.exit(1); }

  const ws = new WebSocket('ws://127.0.0.1:47800');
  let done = false;

  ws.on('open', () => {
    console.log('WS 已连');
    ws.send(JSON.stringify({ cmd: 'load', source: t.url, trackId: t.id, mode: 'wasapi', deviceIndex: 2 }));
  });

  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.ev === 'hello' || m.ev === 'pong') return;
    console.log('←', JSON.stringify(m).slice(0, 260));
    if (m.ev === 'ack' && m.cmd === 'load') {
      if (!m.ok) { done = true; ws.close(); process.exit(1); }
      // 起播并观察 4 秒
      ws.send(JSON.stringify({ cmd: 'play' }));
      let n = 0;
      const iv = setInterval(() => {
        ws.send(JSON.stringify({ cmd: 'state' }));
        if (++n >= 4) { clearInterval(iv); ws.close(); process.exit(0); }
      }, 1000);
    }
    if (m.ev === 'state' && m.state) {
      console.log(`   state=${m.state.state} pos=${(m.state.pos || 0).toFixed(2)}s dur=${(m.state.dur || 0).toFixed(1)}s`);
    }
  });

  ws.on('error', (e) => { console.log('WS ERR', e.message); process.exit(1); });
  setTimeout(() => { if (!done) { console.log('超时'); process.exit(1); } }, 20000);
})();
