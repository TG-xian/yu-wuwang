/**
 * 引擎 WS 控制链路测试：load → play → state → stop
 * 用法: node tools/engine-test.js [秒数]
 */
const WebSocket = require('ws');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const url = fs.readFileSync(path.join(ROOT, '.test-url'), 'utf8').trim();
const seconds = Number(process.argv[2] || 6);

const ws = new WebSocket('ws://127.0.0.1:47800');
let ticks = 0;

ws.on('open', () => {
  console.log('[ui] connected, sending load…');
  ws.send(JSON.stringify({ cmd: 'load', source: url, reqId: 1 }));
});

ws.on('message', (buf) => {
  const m = JSON.parse(buf.toString());
  if (m.ev === 'ready') {
    console.log('[ui] engine ready', m.version, 'caps.asio=', m.caps && m.caps.asio);
    return;
  }
  if (m.ev === 'ack') {
    if (m.cmd === 'load') {
      if (m.ok) {
        console.log(`[ui] load ok · ${m.info.freq}Hz/${m.info.bits}bit/${m.info.chans}ch · 设备率 ${m.deviceRate} · ${m.mode}`);
        console.log('[ui] sending play…');
        ws.send(JSON.stringify({ cmd: 'play', reqId: 2 }));
      } else {
        console.log('[ui] load FAILED:', m.error);
        process.exit(1);
      }
    } else if (m.cmd !== 'state') {
      console.log(`[ui] ack ${m.cmd} ok=${m.ok}${m.error ? ' err=' + m.error : ''}`);
    }
    return;
  }
  if (m.ev === 'state' && m.fmt) {
    ticks++;
    if (ticks % 2 === 1) {
      console.log(`[state] ${m.state} pos=${(m.pos || 0).toFixed(1)}s/${(m.dur || 0).toFixed(0)}s ` +
                  `fmt=${m.fmt.rate}Hz/${m.fmt.bits}bit bitperfect=${m.out && m.out.bitperfect}`);
    }
  }
});

setTimeout(() => {
  console.log('[ui] sending stop…');
  ws.send(JSON.stringify({ cmd: 'stop' }));
  setTimeout(() => { ws.close(); process.exit(0); }, 700);
}, seconds * 1000);
