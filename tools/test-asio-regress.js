/**
 * ASIO 路径回归测试（自带引擎，不依赖外部进程）
 *
 * 目的：改过 engine/audio.js 的平台分支后，确认 Windows 的 ASIO 独占没被破坏。
 * 用法：node tools/test-asio-regress.js
 */
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

const PORT = Number(process.env.YW_TEST_PORT || 47811);
const ENGINE = path.join(__dirname, '..', 'engine', 'index.js');

// 自己拉起引擎，测完杀掉
const engine = spawn(process.execPath, [ENGINE], {
  env: { ...process.env, YW_ENGINE_PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
engine.stdout.on('data', (d) => console.log('[engine]', String(d).trim()));
engine.stderr.on('data', (d) => console.log('[engine!]', String(d).trim()));

let ws = null;

// 找一首本地无损
function findTrack() {
  const root = 'C:/Users/tianz/OneDrive/Music';
  const hits = [];
  (function walk(dir, depth) {
    if (depth > 3) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (/\.(flac|wav)$/i.test(e.name)) hits.push(full);
    }
  })(root, 0);
  return hits[0] || null;
}

const track = findTrack();
if (!track) { console.log('找不到本地无损文件，退出'); process.exit(1); }
console.log('测试文件:', path.basename(track));

let done = false;
const finish = (msg, code) => {
  if (done) return;
  done = true;
  console.log('\n' + msg);
  try { if (ws) ws.close(); } catch {}
  try { engine.kill(); } catch {}
  setTimeout(() => process.exit(code), 400);
};

setTimeout(() => finish('超时：引擎没响应', 1), 30000);

// 给引擎 3 秒起来再连
setTimeout(() => {
ws = new WebSocket(`ws://127.0.0.1:${PORT}`);

ws.on('open', () => {
  console.log('已连上引擎，发送 load（asio / 独占）');
  ws.send(JSON.stringify({
    cmd: 'load',
    source: track,
    deviceIndex: 0,
    mode: 'asio',
  }));
});

ws.on('message', (raw) => {
  let m;
  try { m = JSON.parse(raw.toString()); } catch { return; }

  if (m.ev === 'ready') return;

  if (m.ok !== undefined && m.ok === false) {
    finish(`load 失败: ${m.error}`, 1);
    return;
  }

  if (m.ok && m.info) {
    console.log(`load ok: ${m.info.freq}Hz / ${m.info.chans}ch / ${m.info.bits}bit`);
    console.log(`deviceRate: ${m.deviceRate}  mode: ${m.mode}`);
    console.log(`bit-perfect: ${m.deviceRate === m.info.freq ? '是（速率相符，无重采样）' : '否'}`);

    ws.send(JSON.stringify({ cmd: 'play' }));
    setTimeout(() => {
      ws.send(JSON.stringify({ cmd: 'stop' }));
      finish('ASIO 回归测试通过：load + play + stop 全链路正常', 0);
    }, 2500);
  }
});

ws.on('error', (e) => finish(`WS 连接失败: ${e.message}`, 1));
}, 3000);
