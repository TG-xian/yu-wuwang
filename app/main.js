/**
 * 豫 · 无妄 — Electron 主进程
 * M1：窗口 + 拉起引擎 + WS 握手 + 崩溃自动重启（最多 3 次）
 */
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, dialog } = require('electron');
const { spawn, execFile } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const WebSocket = require('ws');

const ENGINE_PORT = Number(process.env.YW_ENGINE_PORT || 47800);
const API_PORT = Number(process.env.YW_API_PORT || 3000);
const API_DIR = path.join(__dirname, '..', 'node_modules', 'NeteaseCloudMusicApi');
// 登录态：开发时放项目根，打包后放 %APPDATA%（安装目录可能只读，且升级会覆盖）
const COOKIE_PATH = () => (app.isPackaged
  ? path.join(app.getPath('userData'), '.cookie')
  : path.join(__dirname, '..', '.cookie'));
let apiProc = null;
const ENGINE_ENTRY = path.join(__dirname, '..', 'engine', 'index.js');
const MAX_RESTART = 3;

let win = null;
let engineProc = null;
let engineWs = null;
let restarts = 0;
let shuttingDown = false;

/** 清掉占着引擎端口的残留进程（上次异常退出时常见） */
function killPortOccupant(port) {
  try {
    const { execSync } = require('node:child_process');
    const out = execSync(`netstat -ano -p tcp`, { encoding: 'utf8', windowsHide: true });
    const pids = new Set();
    for (const line of out.split('\n')) {
      if (!line.includes(`:${port} `) || !line.includes('LISTENING')) continue;
      const parts = line.trim().split(/\s+/);
      const pid = parts[parts.length - 1];
      if (/^\d+$/.test(pid)) pids.add(pid);
    }
    for (const pid of pids) {
      try {
        process.kill(Number(pid));
        console.log(`[engine] 清理占用 ${port} 的残留进程 pid=${pid}`);
      } catch (e) {
        console.warn(`[engine] 清理 pid=${pid} 失败: ${e.message}`);
      }
    }
  } catch {}
}

/** 用 Electron 自带二进制当 Node 跑引擎，打包后无需系统 node */
function startEngine() {
  killPortOccupant(ENGINE_PORT);
  engineProc = spawn(process.execPath, [ENGINE_ENTRY], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', YW_ENGINE_PORT: String(ENGINE_PORT) }
  });
  engineProc.stdout.on('data', (d) => console.log('[engine]', String(d).trim()));
  engineProc.stderr.on('data', (d) => console.error('[engine!]', String(d).trim()));
  engineProc.on('exit', (code, sig) => {
    engineWs = null;
    console.log(`[engine] exited code=${code} sig=${sig}`);
    if (shuttingDown) return;
    if (restarts < MAX_RESTART) {
      restarts += 1;
      console.log(`[engine] restart ${restarts}/${MAX_RESTART}`);
      setTimeout(connectWithRetry, 700);
    } else {
      push('engine-failed', { reason: 'exceeded restarts' });
    }
  });
}

function push(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/** 引擎可能还没起监听，所以要重试 */
function connectWithRetry(attempt = 0) {
  const ws = new WebSocket(`ws://127.0.0.1:${ENGINE_PORT}`);
  ws.on('open', () => {
    engineWs = ws;
    restarts = 0;
    push('engine-status', { state: 'connected' });
    // 握手：发一次 ping，量往返
    ws.send(JSON.stringify({ cmd: 'ping', t: Date.now() }));
  });
  ws.on('message', (buf) => {
    let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
    if (msg.ev === 'ready') {
      console.log('[main] handshake ok', msg);
      push('engine-status', { state: 'ready', info: msg });
    } else if (msg.ev === 'pong') {
      push('engine-status', { state: 'pong', rtt: Date.now() - msg.echo });
    }
  });
  ws.on('error', () => {
    if (attempt < 12) setTimeout(() => connectWithRetry(attempt + 1), 400);
    else push('engine-failed', { reason: 'ws unreachable' });
  });
}

/**
 * 拉起取流服务（NeteaseCloudMusicApi）。
 * 之前靠手动开终端，一旦终端关掉整个应用就废了；这里随应用启停。
 */
function startApiServer() {
  const http = require('node:http');

  const probe = () => new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: API_PORT, path: '/', timeout: 1200 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });

  return new Promise((resolve) => {
    probe().then((alive) => {
      if (alive) {
        console.log(`[api] 已有服务在 ${API_PORT} 端口，复用`);
        resolve(true);
        return;
      }
      const entry = path.join(API_DIR, 'app.js');
      if (!fs.existsSync(entry)) {
        console.warn(`[api] 找不到 ${entry}，请先在项目里 npm install`);
        resolve(false);
        return;
      }

      // 用 Electron 自带二进制当 Node 跑：打包后目标机器不需要装 node
      apiProc = spawn(process.execPath, [entry], {
        cwd: API_DIR,
        env: { ...process.env, PORT: String(API_PORT), ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      apiProc.stdout.on('data', (d) => {
        const s = d.toString().trim();
        if (s) console.log('[api]', s);
      });
      apiProc.stderr.on('data', (d) => console.log('[api:err]', d.toString().trim()));
      apiProc.on('exit', (code) => console.log(`[api] 退出 code=${code}`));
      console.log(`[api] 取流服务已拉起 pid=${apiProc.pid} port=${API_PORT}`);

      // 等它真正能响应再放行：首次启动要注册匿名设备，约 5~10 秒
      let tries = 0;
      const timer = setInterval(async () => {
        tries += 1;
        if (await probe()) {
          clearInterval(timer);
          console.log('[api] 服务就绪');
          resolve(true);
        } else if (tries >= 40) {
          clearInterval(timer);
          console.warn('[api] 启动超时（20 秒），界面可能登录失败');
          resolve(false);
        }
      }, 500);
    });
  });
}

function stopApiServer() {
  if (!apiProc) return;
  try { apiProc.kill(); } catch {}
  apiProc = null;
}

let tray = null;

/** 托盘：关窗口不退出，缩到托盘里继续放 */
function createTray(win) {
  const ico = path.join(__dirname, '..', 'assets', 'icon.ico');
  const png = path.join(__dirname, '..', 'assets', 'icon-32.png');
  let img = nativeImage.createFromPath(ico);
  if (img.isEmpty()) img = nativeImage.createFromPath(png);
  if (img.isEmpty()) {
    console.warn('[tray] 图标缺失，跳过托盘');
    return;
  }

  // macOS 菜单栏图标必须是「模板图」：Electron 只取 alpha 通道当蒙版，
  // 不设的话彩色图标会在深色菜单栏里变成一块灰/彩色方块。
  // （Windows 托盘用原色 .ico，这里保持不动。）
  if (process.platform === 'darwin') img.setTemplateImage(true);

  tray = new Tray(img);
  tray.setToolTip('豫 · 无妄');

  const send = (cmd) => {
    try { win.webContents.send('tray-cmd', cmd); } catch {}
  };

  // 托盘菜单可重建：清空缓存后要刷新占用显示
  tray.buildMenu = () => {
    let cs = { count: 0, bytes: 0 };
    try { cs = bili.cacheStats(); } catch {}
    const mb = (cs.bytes / 1048576).toFixed(0);
    console.log(`[tray] 菜单重建 · B 站缓存 ${cs.count} 个 ${mb}MB`);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示主界面', click: () => { win.show(); win.focus(); } },
      { type: 'separator' },
      { label: '播放 / 暂停', click: () => send('toggle') },
      { label: '上一曲', click: () => send('prev') },
      { label: '下一曲', click: () => send('next') },
      { type: 'separator' },
      { label: `B 站缓存：${cs.count} 个 · ${mb} MB`, enabled: false },
      {
        label: '清空 B 站缓存',
        enabled: cs.count > 0,
        click: () => {
          let r = { removed: 0 };
          try { r = bili.pruneCache({ maxBytes: 0 }); } catch (e) { console.warn('[bili] 清空缓存失败:', e.message); }
          console.log(`[bili] 手动清空缓存：删 ${r.removed} 个`);
          tray.buildMenu();
        },
      },
      { type: 'separator' },
      { label: '退出', click: () => { app.isQuitting = true; app.quit(); } },
    ]));
  };
  tray.buildMenu();

  tray.on('click', () => {
    if (win.isVisible() && !win.isMinimized()) win.hide();
    else { win.show(); win.focus(); }
  });
  console.log('[tray] 已就绪');
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#0A0A0B',
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    show: false,
    frame: false,          // 去掉系统标题栏，用应用自己的顶栏
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  // 无边框窗口的自定义按钮（最小化 / 最大化 / 关闭）
  ipcMain.on('win:min', () => { if (win) win.minimize(); });
  ipcMain.on('win:max', () => {
    if (!win) return;
    if (win.isMaximized()) win.unmaximize(); else win.maximize();
  });
  ipcMain.on('win:close', () => { if (win) win.close(); });   // 走 close 事件 → 收进托盘

  // 最大化状态变化时通知渲染层换图标（□ ↔ 双框）
  win.on('maximize', () => win.webContents.send('win:maxed', true));
  win.on('unmaximize', () => win.webContents.send('win:maxed', false));

  // 把渲染进程的 console 转到主进程 stdout，便于无头验证
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 0) console.log('[renderer]', message);
  });

  win.loadFile(path.join(__dirname, 'renderer', 'main.html'));
  win.once('ready-to-show', () => {
    win.show();
    createTray(win);
  });

  // 关窗口 = 收进托盘（不退出）；真正退出走托盘菜单或 app.isQuitting
  win.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      win.hide();
      console.log('[tray] 窗口收进托盘');
    }
  });

  win.on('closed', () => { win = null; });
}

app.whenReady().then(async () => {
  await startApiServer();    // 先等取流服务能响应，否则渲染进程首次拉账号必失败
  createWindow();
  startEngine();
  setTimeout(() => connectWithRetry(), 500);
  try {
    const r = bili.pruneCache();
    console.log(`[bili] 缓存清理：删 ${r.removed} 个，剩 ${r.kept} 个 ${(r.bytes / 1048576).toFixed(0)}MB`);
  } catch (e) {
    console.warn('[bili] 缓存清理失败:', e.message);
  }
});

app.on('window-all-closed', () => {
  // 有托盘时窗口隐藏不退出，真正退出由托盘菜单或 app.quit() 触发
  if (process.platform !== 'darwin' && app.isQuitting) app.quit();
});

app.on('before-quit', () => {
  shuttingDown = true;
  stopApiServer();
  // 通知引擎退出：引擎收到 shutdown 会 engine.shutdown() → BASS_Free()，
  // mac 上 BASS_Free 才会释放 CoreAudio hog（否则退出后整机可能一直没声音）。
  try { engineWs && engineWs.send(JSON.stringify({ cmd: 'shutdown' })); } catch {}
  console.log('[quit] 已向引擎发送 shutdown（释放独占设备）');
  // 给引擎 500ms 释放设备，再强杀
  setTimeout(() => {
    if (engineProc && !engineProc.killed) { try { engineProc.kill(); } catch {} }
  }, 500);
});

app.on('will-quit', () => {
  // 兜底：退出时的 500ms 定时器经常来不及跑完进程就没了，
  // 子进程一旦变成孤儿会一直占着独占设备（mac 上 hog 不放 = 整机没声音）。
  // 进程被系统回收时 CoreAudio/WASAPI 会自动释放设备，所以这里同步补一刀。
  shuttingDown = true;
  if (engineProc && !engineProc.killed) {
    console.log('[quit] 兜底：强杀引擎进程，确保独占设备释放');
    try { engineProc.kill(); } catch {}
  }
});

// 本地音乐扫描（渲染进程无 fs 权限，由主进程代劳）
const AUDIO_EXT = new Set(['.flac', '.wav', '.mp3', '.m4a', '.ape', '.ogg', '.dsf', '.dff', '.aiff']);

/* ────────── 本地库目录管理 ────────── */

const LIB_PATH = () => path.join(app.getPath('userData'), 'library.json');
const CACHE_PATH = () => path.join(app.getPath('userData'), 'library-cache.json');

function readJsonFile(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function writeJsonFile(p, value) {
  try { fs.writeFileSync(p, JSON.stringify(value, null, 2), 'utf8'); } catch (e) { console.warn('[lib]', e.message); }
}

/** 读库目录配置；首次启动默认用系统「音乐」文件夹，不再硬编码开发机路径 */
function getLibrary() {
  const lib = readJsonFile(LIB_PATH(), null);
  if (lib && Array.isArray(lib.dirs)) return lib;

  const def = app.getPath('music');
  const init = { dirs: fs.existsSync(def) ? [def] : [] };
  writeJsonFile(LIB_PATH(), init);
  console.log(`[lib] 初始化库目录: ${init.dirs.join(', ') || '(空)'}`);
  return init;
}

function saveLibrary(lib) {
  writeJsonFile(LIB_PATH(), { dirs: lib.dirs });
  return lib;
}

/** 播放列表扩展名 */
const PLAYLIST_EXT = new Set(['.m3u', '.m3u8', '.pls']);

/**
 * 解析 m3u/m3u8 → 曲目的绝对路径数组。
 * - 忽略 #EXTINF / #EXTM3U 等指令行与空行
 * - 相对路径按 m3u 所在目录解析
 * - 跳过 http/https 流（本地播放器不该去拉流）
 * - 不存在的文件直接丢弃，由调用方统计缺失数
 */
function parseM3uFile(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const base = path.dirname(file);
  const out = [];
  const seen = new Set();

  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(line)) continue;   // http/https/file 之外一律跳过

    if (line.startsWith('file:///')) {
      try { line = decodeURIComponent(line.slice(8)); } catch {}
    }
    line = line.replace(/\//g, path.sep);

    const abs = path.isAbsolute(line) ? line : path.resolve(base, line);
    if (seen.has(abs)) continue;
    seen.add(abs);
    if (fs.existsSync(abs)) out.push(abs);
  }
  return out;
}

function scanDir(root, out, lists = null, depth = 0) {
  if (depth > 3) return;
  let ents;
  try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      if (!e.name.startsWith('.')) scanDir(full, out, lists, depth + 1);
    } else {
      const ext = path.extname(e.name).toLowerCase();
      if (PLAYLIST_EXT.has(ext)) {
        if (lists) lists.push({ path: full, name: path.basename(e.name, ext) });
        continue;
      }
      if (!AUDIO_EXT.has(ext)) continue;
      try {
        const st = fs.statSync(full);
        out.push({
          path: full,
          name: path.basename(e.name, ext),
          ext: ext.slice(1),
          size: st.size,
          mtime: st.mtimeMs,
        });
      } catch {}
    }
  }
}

/**
 * 读音频元数据（ffprobe）。
 * 时长/采样率/位深/标签，外加内嵌封面（有才提取，缓存到 userData/covers）。
 */
function probeAudio(file) {
  return new Promise((resolve) => {
    execFile('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration:format_tags=title,artist,album,date',
      '-show_entries', 'stream=codec_name,sample_rate,channels,bits_per_raw_sample,bits_per_sample',
      '-of', 'json', file,
    ], { timeout: 10000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        const j = JSON.parse(stdout);
        const st = (j.streams || [])[0] || {};
        const fmt = j.format || {};
        const tags = fmt.tags || {};
        resolve({
          dur: Number(fmt.duration) || 0,
          codec: st.codec_name || '',
          freq: Number(st.sample_rate) || 0,
          chans: Number(st.channels) || 0,
          bits: Number(st.bits_per_raw_sample || st.bits_per_sample) || 0,
          title: tags.title || '',
          artist: tags.artist || '',
          album: tags.album || '',
        });
      } catch { resolve(null); }
    });
  });
}

/** 提取内嵌封面到缓存目录（同一文件只提一次） */
function extractCover(file) {
  const dir = path.join(app.getPath('userData'), 'covers');
  return new Promise((resolve) => {
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    const hash = crypto.createHash('md5').update(file).digest('hex').slice(0, 16);
    const out = path.join(dir, `${hash}.jpg`);
    if (fs.existsSync(out) && fs.statSync(out).size > 1024) return resolve(out);
    execFile('ffmpeg', ['-y', '-v', 'error', '-i', file, '-an', '-vcodec', 'mjpeg', '-frames:v', '1', out],
      { timeout: 20000, windowsHide: true }, (err) => {
        resolve(!err && fs.existsSync(out) && fs.statSync(out).size > 1024 ? out : null);
      });
  });
}

/** 并发限流 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

ipcMain.handle('local:scan', async (_e, opts = {}) => {
  const lib = getLibrary();
  const roots = opts.dir ? [opts.dir] : lib.dirs;

  // 收集文件（去重：同一文件被多个目录覆盖只算一次）
  const seen = new Set();
  const files = [];
  const lists = [];
  for (const r of roots) {
    if (!r || !fs.existsSync(r)) continue;
    const batch = [];
    scanDir(r, batch, lists);
    for (const f of batch) {
      if (seen.has(f.path)) continue;
      seen.add(f.path);
      files.push(f);
    }
  }

  // 解析播放列表：只保留至少有一个有效条目的
  const playlists = lists
    .map((pl) => {
      const paths = parseM3uFile(pl.path);
      return { path: pl.path, name: pl.name, paths, count: paths.length };
    })
    .filter((pl) => pl.count > 0);

  // 元数据缓存：路径 + mtime 都没变就复用，避免每次重跑 ffprobe
  const cache = opts.force ? {} : readJsonFile(CACHE_PATH(), {});
  const nextCache = {};
  let hit = 0;

  const enriched = await mapLimit(files, 4, async (f) => {
    const cached = cache[f.path];
    const unchanged = cached && cached.mtime === f.mtime && cached.meta;

    if (unchanged) {
      hit += 1;
      nextCache[f.path] = cached;
      return { ...f, meta: cached.meta, cover: cached.cover || null };
    }

    const meta = await probeAudio(f.path);
    let cover = null;
    if (meta) cover = await extractCover(f.path);
    nextCache[f.path] = { mtime: f.mtime, meta, cover };
    return { ...f, meta, cover };
  });

  writeJsonFile(CACHE_PATH(), nextCache);

  const withMeta = enriched.filter((f) => f.meta).length;
  console.log(
    `[local] ${roots.length} 个目录 · ${files.length} 个文件 · 缓存命中 ${hit} · ` +
    `元数据 ${withMeta}/${files.length} · 封面 ${enriched.filter((f) => f.cover).length} 个` +
    (playlists.length ? ` · 播放列表 ${playlists.length} 个` : '')
  );
  return { files: enriched, dirs: roots, playlists };
});

/* ────────── 库目录增删 ────────── */

ipcMain.handle('library:get', () => getLibrary());

ipcMain.handle('library:add', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择音乐文件夹',
    properties: ['openDirectory', 'multiSelections'],
  });
  if (r.canceled || !r.filePaths.length) return { ok: false, dirs: getLibrary().dirs };

  const lib = getLibrary();
  const added = [];
  for (const p of r.filePaths) {
    if (!lib.dirs.includes(p)) { lib.dirs.push(p); added.push(p); }
  }
  saveLibrary(lib);
  console.log(`[lib] 添加 ${added.length} 个目录，现有 ${lib.dirs.length} 个`);
  return { ok: true, added, dirs: lib.dirs };
});

/** 拖拽加入：路径由渲染层解析后传进来 */
ipcMain.handle('library:add-path', (_e, paths) => {
  const lib = getLibrary();
  const added = [];
  for (const p of Array.isArray(paths) ? paths : [paths]) {
    const dir = String(p || '');
    if (!dir || !fs.existsSync(dir)) continue;
    let stat;
    try { stat = fs.statSync(dir); } catch { continue; }
    if (!stat.isDirectory()) continue;
    if (!lib.dirs.includes(dir)) { lib.dirs.push(dir); added.push(dir); }
  }
  saveLibrary(lib);
  if (added.length) console.log(`[lib] 拖入 ${added.length} 个目录`);
  return { ok: added.length > 0, added, dirs: lib.dirs };
});

ipcMain.handle('library:remove', (_e, dir) => {
  const lib = getLibrary();
  const before = lib.dirs.length;
  lib.dirs = lib.dirs.filter((d) => d !== dir);
  saveLibrary(lib);
  console.log(`[lib] 移除目录，${before} → ${lib.dirs.length}`);
  return { ok: true, dirs: lib.dirs };
});

// 取流服务的登录态：由主进程读文件，渲染层只拿到值，不落 localStorage
// 扫码成功后把 cookie 落盘（渲染进程无 fs 权限）
ipcMain.handle('login:save-cookie', (_e, cookie) => {
  try {
    const val = String(cookie || '').trim();
    if (!/MUSIC_U=/.test(val)) return { ok: false, error: 'cookie 里没有 MUSIC_U' };
    fs.writeFileSync(COOKIE_PATH(), val, 'utf8');
    console.log(`[login] cookie 已保存 ${val.length} 字节`);
    return { ok: true, length: val.length };
  } catch (e) {
    console.warn('[login] 保存失败:', e.message);
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('api:cookie', () => {
  try {
    return fs.readFileSync(COOKIE_PATH(), 'utf8').trim();
  } catch {
    return '';
  }
});

/* ────────── B 站音源 ──────────
   接口全在主进程发：要带 Referer，且渲染层 CSP 只放行本机端口。
   SESSDATA 只在主进程内流转，渲染层拿不到明文。 */
const bili = require('./bili/api.js');

/** 统一包一层：错误转成 { ok:false } 回渲染层，避免 invoke 抛出的错误信息被 Electron 改写 */
function biliHandle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (e) {
      console.warn(`[bili] ${channel} 失败 [${e.code || '-'}] ${e.message}`);
      return { ok: false, code: e.code || '', error: e.message };
    }
  });
}

const biliSessdata = () => (bili.loadSession() || {}).SESSDATA || '';

biliHandle('bili:ranking', () => bili.ranking());
biliHandle('bili:user-videos', ({ mid, page } = {}) => bili.userVideos(mid, { page }));
biliHandle('bili:user-profile', ({ mid } = {}) => bili.userProfile(mid));
biliHandle('bili:season', ({ bvid } = {}) => bili.seasonInfo(bvid));
biliHandle('bili:recommend', ({ count } = {}) => bili.recommendRegion({ count }));

biliHandle('bili:search-video', ({ keyword, page } = {}) => bili.searchVideo(keyword, { page }));
biliHandle('bili:search-user', ({ keyword, page } = {}) => bili.searchUser(keyword, { page }));

/** 收原始输入（BV 号或链接），顺带解析 ?p= */
biliHandle('bili:info', async (input) => {
  const bvid = bili.parseInput(input);
  if (!bvid) throw Object.assign(new Error('没认出 BV 号，请粘贴 BV 号或视频链接'), { code: 'BAD_INPUT' });
  const info = await bili.getInfo(bvid);
  return { ...info, page: bili.parsePage(input) };
});

/** 下载到本地缓存后返回文件路径：BASS 直接开 B 站 URL 约四成报 err=41，本地文件没问题 */
biliHandle('bili:playurl', async ({ bvid, cid, page, force } = {}) => {
  const t0 = Date.now();
  const d = await bili.downloadAudio(bvid, { sessdata: biliSessdata(), cid, page, force: !!force });
  console.log(`[bili] 取流 ${bvid} cid=${d.cid} 档位=${d.qualityId} ${(d.bytes / 1048576).toFixed(1)}MB `
    + `${d.fromCache ? '命中缓存' : `下载 ${Date.now() - t0}ms`}`);
  return d;
});

/** 歌词匹配：网易云 + LRCLIB 打分选优；匹配不到是正常结果（data.ok=false），不算 IPC 失败 */
const biliLyrics = require('./bili/lyrics.js');
biliHandle('bili:lyrics', async ({ bvid, page, title, artist, durationSec } = {}) => {
  const t0 = Date.now();
  const r = await biliLyrics.match({ bvid, page, title, artist, durationSec });
  console.log(r.ok
    ? `[bili] 歌词 ${bvid} → ${r.source}「${r.songTitle}」${r.songArtist} 分数=${r.score} ${r.fromCache ? '命中缓存' : `${Date.now() - t0}ms`}`
    : `[bili] 歌词 ${bvid} 未匹配：${r.reason}`);
  return r;
});

biliHandle('bili:qr-generate', () => bili.qrGenerate());

/** 成功时在主进程直接存盘，cookie 不回传渲染层 */
biliHandle('bili:qr-poll', async (key) => {
  const r = await bili.qrPoll(key);
  if (r.status !== 'ok') return r;
  const saved = bili.saveSession(r.cookie);
  console.log(`[bili] 扫码登录成功 persisted=${saved.persisted}${saved.error ? ' · ' + saved.error : ''}`);
  return { status: 'ok', persisted: saved.persisted, note: saved.error || '' };
});

biliHandle('bili:session-get', async () => {
  const sess = bili.loadSession();
  if (!sess || !sess.SESSDATA) return { loggedIn: false, hasSessdata: false };
  try {
    const n = await bili.nav(sess.SESSDATA);
    return { loggedIn: n.isLogin, hasSessdata: true, member: n.vip, uname: n.uname };
  } catch {
    // 网络失败不等于登出：保留登录态，只是会员信息未知
    return { loggedIn: true, hasSessdata: true, member: null };
  }
});

/** 手动粘贴的兜底：允许整段 cookie 或只有值 */
biliHandle('bili:session-save', (text) => {
  const s = String(text || '').trim();
  const m = s.match(/SESSDATA=([^;\s]+)/);
  const r = bili.saveSession({ SESSDATA: m ? m[1] : s });
  if (!r.ok) throw Object.assign(new Error(r.error), { code: 'BAD_SESSDATA' });
  return r;
});

biliHandle('bili:session-clear', () => bili.clearSession());

ipcMain.handle('engine:status', () => ({
  connected: !!engineWs,
  pid: engineProc ? engineProc.pid : null
}));
