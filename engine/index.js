/**
 * 豫 · 无妄 — 播放引擎（独立进程）
 * M1 目标：只做 WS 服务 + 心跳握手，不碰音频、不碰网络。
 */
const { WebSocketServer } = require('ws');
const { AudioEngine } = require('./audio');

const PORT = Number(process.env.YW_ENGINE_PORT || 47800);
const VERSION = '0.1.0';
const engine = new AudioEngine();

const wss = new WebSocketServer({ host: '127.0.0.1', port: PORT });

wss.on('listening', () => {
  // 这行是 M1 的验收标志
  console.log(`[engine] ready pid=${process.pid} port=${PORT}`);
});

wss.on('error', (err) => {
  console.error(`[engine] fatal: ${err.code || err.message}`);
  process.exit(err.code === 'EADDRINUSE' ? 2 : 1);
});

wss.on('connection', (ws) => {
  console.log('[engine] ui connected');
  ws.send(JSON.stringify({
    ev: 'ready',
    engine: 'bass',
    version: VERSION,
    pid: process.pid,
    // 独占方式按平台不同：Windows 走 ASIO 插件，macOS 走 CoreAudio hog mode。
    // 两者都不重采样，但机制完全不一样，上层提示文案要分开。
    caps: {
      exclusive: process.platform === 'win32' ? 'asio' : process.platform === 'darwin' ? 'hog' : 'none',
      asio: process.platform === 'win32',      // 保留旧字段，渲染层还在读
      native: false
    }
  }));

  ws.on('message', (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }

    if (msg.cmd === 'ping') {
      ws.send(JSON.stringify({ ev: 'pong', t: Date.now(), echo: msg.t }));
      return;
    }
    if (msg.cmd === 'shutdown') {
      engine.shutdown();
      ws.send(JSON.stringify({ ev: 'bye' }));
      setTimeout(() => process.exit(0), 60);
      return;
    }

    // ── 播放控制 ──
    let r;
    switch (msg.cmd) {
      case 'load':      r = engine.load(msg.source, { deviceIndex: msg.deviceIndex, mode: msg.mode }); break;
      case 'play':      r = engine.play(); break;
      case 'pause':     r = engine.pause(); break;
      case 'resume':    r = engine.resume(); break;
      case 'stop':      r = engine.stop(); break;
      case 'seek':      r = engine.seek(Number(msg.seconds) || 0); break;
      case 'volume':    r = engine.setVolume(msg.value); break;
      case 'state':     r = { ok: true, ...engine.snapshot() }; break;
      default:
        ws.send(JSON.stringify({ ev: 'error', code: 'UNKNOWN_CMD', cmd: msg.cmd }));
        return;
    }
    ws.send(JSON.stringify({ ev: 'ack', cmd: msg.cmd, reqId: msg.reqId, ...r }));
  });

  // 状态推送：500ms 一帧，UI 只负责画
  const ticker = setInterval(() => {
    if (ws.readyState !== 1) return;
    try { ws.send(JSON.stringify({ ev: 'state', ...engine.snapshot() })); } catch {}
  }, 500);

  ws.on('close', () => {
    clearInterval(ticker);
    console.log('[engine] ui disconnected');
  });
});

// 退出前必须做的事（M2 起：释放 ASIO 设备）都挂这里
function cleanup() {
  try { engine.shutdown(); } catch {}
  try { wss.close(); } catch {}
}
process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });
