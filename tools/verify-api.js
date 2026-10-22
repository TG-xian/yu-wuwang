/**
 * M3 前提验证（不播放、不碰声卡）
 *  1. cookie 是否有效
 *  2. 搜索是否通
 *  3. level=lossless 到底返回什么：flac 还是被降级成 mp3
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const BASE = 'http://127.0.0.1:3000';
const cookie = fs.readFileSync(path.join(ROOT, '.cookie'), 'utf8').trim();

function url(p) {
  const sep = p.includes('?') ? '&' : '?';
  return `${BASE}${p}${sep}cookie=${encodeURIComponent(cookie)}&timestamp=${Date.now()}`;
}
const getJson = async (p) => {
  const res = await fetch(url(p), { signal: AbortSignal.timeout(15000) });
  return res.json();
};

(async () => {
  // 1) 账号
  const acc = await getJson('/user/account');
  const p = acc.profile || {};
  console.log('=== 账号 ===');
  console.log(`  ${p.nickname || '(无)'}  uid=${p.userId || '-'}  vipType=${p.vipType}  code=${acc.code}`);

  // 2) 搜索
  const kw = '周杰伦';
  const s = await getJson(`/cloudsearch?keywords=${encodeURIComponent(kw)}&type=1&limit=6`);
  const songs = (s.result && s.result.songs) || [];
  console.log(`\n=== 搜索「${kw}」 ===`);
  console.log(`  返回 ${songs.length} 条 / 共 ${s.result ? s.result.songCount : '?'} 条`);

  // 3) 逐首取地址
  console.log('\n=== level=lossless 实际返回 ===');
  for (const t of songs.slice(0, 5)) {
    const j = await getJson(`/song/url/v1?id=${t.id}&level=lossless`);
    const d = (j.data && j.data[0]) || {};
    const ext = (d.url || '').split('?')[0].split('.').pop();
    const ok = d.type === 'flac' || ext === 'flac';
    console.log(`  ${ok ? '✅' : '⚠️ '} ${String(t.name).slice(0, 22).padEnd(22)} fee=${t.fee} type=${d.type || '-'} br=${d.br || 0} size=${Math.round((d.size || 0) / 1024 / 1024 * 10) / 10}MB`);
    if (!ok) console.log(`       └ ${d.url ? '降级为 ' + (d.type || ext) : '无地址（无版权/下架）'}`);
  }
})().catch((e) => console.error('ERR', e.message));
