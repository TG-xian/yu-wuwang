/**
 * 二维码状态监听：持续轮询 /login/qr/check，一旦 803 立刻保存 cookie
 * 原因：NeteaseCloudMusicApi 无状态，MUSIC_U 只在 803 那次响应里出现
 * 用法（后台跑）: node tools/qr-watch.js
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const BASE = process.env.YW_API_BASE || 'http://127.0.0.1:3000';
const MAX_TRIES = 150; // 2s × 150 = 5 分钟

const key = fs.readFileSync(path.join(ROOT, '.qr-key'), 'utf8').trim();
const log = (m) => console.log(`[watch] ${m}`);

let tries = 0;

async function tick() {
  tries++;
  try {
    const res = await fetch(`${BASE}/login/qr/check?key=${encodeURIComponent(key)}&timestamp=${Date.now()}`,
      { signal: AbortSignal.timeout(8000) });
    const j = await res.json();

    if (j.code === 803) {
      if (j.cookie && /MUSIC_U=/.test(j.cookie)) {
        fs.writeFileSync(path.join(ROOT, '.cookie'), j.cookie);
        log(`LOGIN_OK cookie=${j.cookie.length} 字节 含 MUSIC_U`);
      } else {
        log(`LOGIN_OK 但 cookie 不含 MUSIC_U（${(j.cookie || '').length} 字节）`);
      }
      process.exit(0);
    }
    if (j.code === 800) { log('QR_EXPIRED'); process.exit(1); }
    if (tries % 5 === 0) log(`waiting code=${j.code} tries=${tries}`);
  } catch (e) {
    log('ERR ' + e.message);
  }
  if (tries >= MAX_TRIES) { log('TIMEOUT'); process.exit(2); }
  setTimeout(tick, 2000);
}

log(`start, key=${key.slice(0, 8)}…`);
tick();
