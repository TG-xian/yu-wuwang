/* 豫 · 无妄 — 界面逻辑（M4 联调版）
   数据：window.YW.api（取流服务，cookie 由主进程托管）
   音频：WS 47800 上的引擎（load/play/pause/resume/stop/seek）
*/

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const api = window.YW.api;

/* 平台判断：preload 暴露的只读 platform 字段（app/preload.js）。
   取不到就按 Windows 处理 —— 保证 Windows 现有行为不变。 */
const PLATFORM = (window.yw && window.yw.platform) || 'win32';
const IS_MAC = PLATFORM === 'darwin';

/* ────────── 主页占位数据（下一步接 /personalized 与 /recommend/songs） ────────── */
const HOME_MOCK = {
  playlists: [
    { name: '华语流行 · 副歌', count: 28, bg: '#2A2A2E' },
    { name: '深夜电台 · 独处', count: 42, bg: '#332E22' },
    { name: '民谣与诗', count: 36, bg: '#24282C' },
    { name: '合成器流行', count: 19, bg: '#2E2428' },
    { name: 'Lossless 精选', count: 51, bg: '#262B24' },
    { name: '电影原声', count: 24, bg: '#2A2620' }
  ],
  rank: [
    { i: '01', n: '豫 · 华语热歌榜', d: '↑ 3' },
    { i: '02', n: '无妄 · 无损榜', d: '—' },
    { i: '03', n: '新声榜', d: '↓ 1' }
  ]
};

/* ────────── 设置持久化（音量 / 输出设备 / 播放模式） ────────── */
const SET_KEY = 'yw.settings.v1';
const settings = Object.assign(
  IS_MAC
    // macOS 默认：CoreAudio 共享 + 系统默认设备 → 装上就有声音。
    // 老配置里的 outDevice:0 / outMode:'asio' 会在 boot() 里迁移（0 在 BASS 是 No sound）。
    ? {
        volume: 1.0, outDevice: 'default', outMode: 'shared', outLabel: '扬声器（共享）', playMode: 'list',
        exclusiveHintShown: false,   // 「独占时别的程序没声音」这句只说一次
        dismissedDevices: []         // 用户点过「忽略」的外接声卡名
      }
    : { volume: 1.0, outDevice: 0, outMode: 'asio', outLabel: 'ASIO 独占 · Donner', playMode: 'list' },
  JSON.parse(localStorage.getItem(SET_KEY) || '{}')
);
function saveSettings() {
  try { localStorage.setItem(SET_KEY, JSON.stringify(settings)); } catch {}
}

const state = {
  current: null,
  playing: false,
  pos: 0,
  dur: 0,
  view: 'home',
  loggedIn: false,
  searchList: [],
  searchData: null,
  searchTab: 'songs',
  searchKeyword: '',
  viewStack: [],     // 视图返回栈
  homePls: [],       // 推荐歌单全量
  homeShown: 0,      // 已渲染数量
  lyric: [],        // [{ t, text }]
  lyricIdx: -1,
  history: [],      // 随机模式下"上一曲"回退用的索引栈
  uid: 0,
  liked: new Set(), // 已喜欢的歌曲 id
  radioMode: false,
  radioPool: [],
  radioFetching: false,
  radioLastAt: 0,          // 节流时间戳
  engineOpen: false,
  lastLoad: null,          // 最近一次 load 参数（mac 上输出回落时重试用）
  outFallbackDone: false,  // mac 输出回落是否已试过一次（防抖，避免无限重试）
  dacHintChecked: false,   // mac 外接声卡提示只在启动后判断一次
  stallCheck: { lastPos: 0, lastAt: 0, retried: 0 },
  localSnapshot: null,     // 启动时扫描的结果，进本地页直接复用
  localTracks: null,
  localPlaylists: [],
  radioSkip: {},          // { fm: 解禁时间戳, newsong: ... }
  radioCooldownUntil: 0
};

/* ────────── 工具 ────────── */
function fmt(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/* ────────── 引擎 WS ────────── */
let eng = null;
let reqSeq = 0;

/* ────────── 唱片惯性转动 ────────── */
const discEl = document.querySelector('.disc');
let discAngle = -8, discOmega = 0, discTargetOmega = 0, discRAF = null, discLast = 0;

const DISC_MAX_OMEGA = 200;   // 360 / 1.8s ≈ 200°/s，即 33⅓ rpm
const ACCEL_TAU = 0.22;       // 起转时间常数 → 约 0.5s 到位
const DECEL_TAU = 0.55;       // 停转时间常数 → 约 1.5s 停稳（真机惯量）

function discTick(ts) {
  if (!discLast) discLast = ts;
  const dt = Math.min(0.05, (ts - discLast) / 1000);
  discLast = ts;

  const tau = discTargetOmega > discOmega ? ACCEL_TAU : DECEL_TAU;
  discOmega += (discTargetOmega - discOmega) * (1 - Math.exp(-dt / tau));

  discAngle += discOmega * dt;
  if (discAngle > 360) discAngle -= 360;
  if (discEl) discEl.style.transform = `rotate(${discAngle}deg)`;

  if (discTargetOmega === 0 && Math.abs(discOmega) < 0.6) {
    discOmega = 0; discLast = 0; discRAF = null; return;   // 停稳即退出，不空转
  }
  discRAF = requestAnimationFrame(discTick);
}

function setDiscSpin(on) {
  discTargetOmega = on ? DISC_MAX_OMEGA : 0;
  if (!discRAF) { discLast = 0; discRAF = requestAnimationFrame(discTick); }
}

function connectEngine() {
  eng = new WebSocket('ws://127.0.0.1:47800');
  eng.onopen = () => {
    state.engineOpen = true;
    console.log('[ui] engine ws open');
    if (IS_MAC) requestDevices();   // mac：连上就问一遍 CoreAudio 设备，动态生成菜单
  };
  eng.onclose = () => {
    console.warn('[ui] engine ws closed, retry in 1.5s');
    setTimeout(connectEngine, 1500);
  };
  eng.onerror = () => {};
  eng.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.ev === 'ready') { setLed(true, IS_MAC ? 'CoreAudio · 就绪' : 'ASIO · 就绪'); return; }
    if (m.ev === 'ack') {
      if (m.cmd === 'devices') { renderMacOutMenu(m.devices || []); return; }
      if (m.cmd === 'load') {
        setLoading(false);
        if (!m.ok) {
          if (!IS_MAC) setStatus('LOAD FAILED: ' + m.error);   // mac 交给 macLoadFailed 说人话
          state.playing = false;
          $('#disc').classList.remove('playing');
          if (IS_MAC) macLoadFailed(m.error);   // 设备拔了/被抢：回落「扬声器（共享）」并重试
        } else {
          const f = m.info || {};
          state.outFallbackDone = false;
          $('#pl-tag').textContent = `SQ LOSSLESS · ${(f.freq / 1000).toFixed(1)} kHz / ${f.bits} bit`;
          if (IS_MAC) {
            // 界面只说人话；err 码只在 console 里（引擎已打）
            const dn = m.deviceName || outDevName(m.device);
            showOutBadge(m.mode, dn);
            if (m.mode === 'exclusive') {
              setStatus(`独占 · ${dn} · ${(f.freq / 1000).toFixed(1)} kHz / ${f.bits} bit`);
              hintExclusiveOnce();
            } else if (m.degraded) {
              // 引擎已把独占失败降级成共享：告诉用户为什么，但不提 err 码
              setStatus('这个声卡不支持独占，已自动改用共享输出');
              showToast('这个声卡不支持独占，已自动改用共享输出', [], 9000);
              console.warn(`[out] mac 独占失败已回落共享 reason=${m.reason || '-'}`);
            } else {
              setStatus(`共享 · ${(f.freq / 1000).toFixed(1)} kHz / ${f.bits} bit`);
            }
            console.log(`[out] mac load ok mode=${m.mode} dev=${m.device} name=${dn} degraded=${!!m.degraded} reason=${m.reason || '-'}`);
          } else {
            setStatus(`ASIO · ${f.freq} Hz / ${f.bits} bit`);
          }
          engSend({ cmd: 'play' });
        }
      }
      return;
    }
    if (m.ev === 'state') applyState(m);
  };
}

/** 统一发 load：记住最后一次 load 参数，供 mac 上「输出回落」后自动重试 */
function sendLoad({ source, trackId }) {
  state.lastLoad = { source, trackId: trackId ?? null };
  state.outFallbackDone = false;
  return engSend({ cmd: 'load', source, trackId: trackId ?? null, deviceIndex: outDevice, mode: outMode });
}

function engSend(obj) {
  if (eng && eng.readyState === 1) {
    obj.reqId = ++reqSeq;
    eng.send(JSON.stringify(obj));
    return true;
  }
  return false;
}
function setStatus(txt) { $('#pl-status-txt').textContent = txt; }

/* ────────── 轻提示（仅 macOS）：独占说明 / 外接声卡 / 声卡断开 ──────────
   err 码一律只进 console.log，界面只说人话。Windows 上不显示。 */
const toastEl = $('#toast');
const toastText = $('#toast-t');
const toastAct = $('#toast-act');
let toastTimer = null;

function hideToast() {
  if (toastEl) toastEl.hidden = true;
  clearTimeout(toastTimer);
}

function showToast(text, actions = [], ms = 12000) {
  if (!IS_MAC || !toastEl) return;     // Windows：整段不执行，界面与改动前一致
  toastText.textContent = text;
  toastAct.innerHTML = '';
  for (const a of actions) {
    const b = document.createElement('button');
    b.className = 'toast-btn' + (a.sub ? ' sub' : '');
    b.textContent = a.label;
    b.addEventListener('click', () => { hideToast(); if (a.onClick) a.onClick(); });
    toastAct.appendChild(b);
  }
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  if (ms > 0) toastTimer = setTimeout(hideToast, ms);
  console.log(`[toast] ${text}`);
}

/** 独占生效时把「独占 · 设备名」摆到播放页 LED 上（用户得看得见设备被 hog 了） */
function showOutBadge(mode, devName) {
  if (!IS_MAC) return;
  if (mode === 'exclusive') setLed(true, `独占 · ${devName || '声卡'}`);
  else setLed(true, '共享 · 系统混音');
}

/** 唱臂：播放时落针在盘，暂停/取流时摆开 */
function setArm(onDisc) {
  const arm = $('#arm');
  if (arm) arm.classList.toggle('off', !onDisc);
}

/** 取流/建流期间的等待态：金环绕 + 唱臂抬起 */
function setLoading(on) {
  const deck = document.querySelector('.deck');
  if (deck) deck.classList.toggle('loading', !!on);
  if (on) setArm(false);
  else if (state.playing && !state.swapping) setArm(true);  // 换碟中由动画收尾负责落针
}
function setLed(on, label) {
  $('#pl-led').classList.toggle('on', !!on);
  if (label) $('#pl-led-l').textContent = label;
}

/* ────────── 引擎状态 → UI ────────── */
function applyState(s) {
  if (!s || !s.dur) return;
  state.pos = s.pos || 0;
  state.dur = s.dur || 0;

  const pct = Math.min(100, (state.pos / state.dur) * 100);
  $('#pb-bar i').style.width = pct + '%';
  if (!seekState.dragging) {
    $('#pl-groove i').style.width = pct + '%';
    $('#pb-bar i').style.width = pct + '%';
  }
  $('#pb-time').textContent = `${fmt(state.pos)} / ${fmt(state.dur)}`;
  $('#pl-pos').textContent = fmt(state.pos);
  $('#pl-dur').textContent = fmt(state.dur);

  updateLyric(state.pos);
  checkTrackEnd(s);
  checkStall(s);

  const playing = s.state === 'playing';
  if (playing !== state.playing) {
    state.playing = playing;
    setDiscSpin(playing);
    setArm(playing);
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    }
    const icon = playing
      ? '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>'
      : '<path d="M8 5v14l11-7z"/>';
    $('#pb-play-icon').innerHTML = icon;
    const plIcon = $('#pl-play-icon');
    if (plIcon) plIcon.innerHTML = icon;
  }
}

function loadLyricLocal() {
  state.lyric = [];
  state.lyricIdx = -1;
  $('#pl-lyric').innerHTML = '<div>— 本地文件无歌词 —</div>';
}

/* ────────── 歌词 ────────── */
async function loadLyric(id) {
  state.lyric = [];
  state.lyricIdx = -1;
  $('#pl-lyric').innerHTML = '<div>—</div>';
  try {
    const { lrc, tlyric, romalrc } = await api.lyric(id);
    // 连点切歌时，先发的歌词可能后到 —— 只认当前这首的
    if (!state.current || state.current.id !== id) return;
    const lines = api.parseLrc(lrc);

    // ① 译文：按时间戳 ±0.3s 对齐（两轨行数常常不等，不能按序硬配）
    const trans = api.parseLrc(tlyric);
    if (trans.length) {
      let ti = 0;
      let hit = 0;
      for (const l of lines) {
        while (ti < trans.length && trans[ti].t < l.t - 0.3) ti++;
        if (ti < trans.length && Math.abs(trans[ti].t - l.t) <= 0.3) {
          const txt = (trans[ti].text || '').trim();
          if (txt) { l.trans = txt; hit++; }
        }
      }
      if (hit) console.log(`[lyric] 译文对齐 ${hit}/${lines.length} 行`);
    }

    // ② 注音：直接用网易云的 romalrc 轨（粤语=粤拼 / 日语=罗马音）
    const roma = api.parseLrc(romalrc);
    if (roma.length) {
      let ri = 0;
      let hit = 0;
      for (const l of lines) {
        while (ri < roma.length && roma[ri].t < l.t - 0.35) ri++;
        if (ri < roma.length && Math.abs(roma[ri].t - l.t) <= 0.35) {
          const txt = (roma[ri].text || '').trim();
          if (txt) { l.jp = txt; hit++; }
        }
      }
      if (hit) console.log(`[lyric] 注音对齐 ${hit}/${lines.length} 行`);
    }

    state.lyric = lines;
    if (lines.length) renderLyric(lines);
  } catch (e) {
    console.warn('[lyric]', e.message);
  }
}

function renderLyric(lines) {
  $('#pl-lyric').innerHTML = lines.map((l, i) => {
    const main = `<span class="ly-main">${esc(l.text || '·')}</span>`;
    const jp = l.jp ? `<span class="ly-jp">${esc(l.jp)}</span>` : '';
    const tr = l.trans ? `<span class="ly-trans">${esc(l.trans)}</span>` : '';
    return `<div data-li="${i}">${main}${jp}${tr}</div>`;
  }).join('');
}

function updateLyric(pos) {
  const lines = state.lyric;
  if (!lines || !lines.length) return;
  let idx = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].t <= pos) idx = i; else break;
  }
  if (idx === state.lyricIdx) return;
  state.lyricIdx = idx;

  const el = $('#pl-lyric');
  const nodes = el.children;
  for (let i = 0; i < nodes.length; i++) nodes[i].classList.toggle('cur', i === idx);
  const cur = nodes[idx];
  if (cur) el.scrollTop = cur.offsetTop - el.clientHeight / 2 + cur.clientHeight / 2;
}

/* ────────── 主页 ────────── */
function renderHome() {
  const d = new Date();
  $('#home-date').textContent =
    `DISCOVER · ${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;

  $('#pl-grid').innerHTML = HOME_MOCK.playlists.map((p) => `
    <div class="pl-card">
      <div class="pl-c" style="background:${p.bg}"></div>
      <div class="pl-n">${esc(p.name)}</div>
      <div class="pl-s">${p.count} 首</div>
    </div>`).join('');

  $('#rank').innerHTML = HOME_MOCK.rank.map((r) => `
    <div class="rk"><span class="rk-i">${r.i}</span><span class="rk-n">${esc(r.n)}</span><span class="rk-d">${r.d}</span></div>`
  ).join('');
}

function fmtCount(n) {
  n = Number(n) || 0;
  return n >= 10000 ? (n / 10000).toFixed(1) + '万' : String(n);
}

/** 真实推荐歌单（/personalized）；失败则保留占位，不打断界面 */
async function loadHomeReal({ mix = false } = {}) {
  if (!state.loggedIn) return;
  try {
    const pls = await api.personalized(100);   // 接口上限 100（按天固定）
    if (mix) {
      // 刷新时换血：个性化只取前 60，其余用随机页的热门歌单补上，
      // 否则点刷新看到的永远是同一批（该接口一天内结果不变）
      const off = Math.floor(Math.random() * 600);
      const pool = await api.topPlaylist('全部', 40, off);
      const seen = new Set(pls.slice(0, 60).map((x) => x.id));
      state.homePls = pls.slice(0, 60).concat(pool.filter((x) => !seen.has(x.id)));
      console.log(`[home] 刷新混入热门 offset=${off} 共 ${state.homePls.length}`);
    } else {
      state.homePls = pls;
    }
    if (!pls.length) return;
    state.homeShown = 0;
    $('#pl-grid').innerHTML = '';
    renderHomePlaylists();   // 先铺一批
    renderHomePlaylists();   // 再铺一批：确保内容宽度超过容器，滚轮才有得滑
    console.log(`HOME_OK 推荐歌单 ${state.homePls.length} 个`);
  } catch (e) {
    console.warn('[home] personalized:', e.message);
  }

  // 排行榜：取真实榜单，可点进详情
  try {
    const tops = await api.toplist();
    const pick = tops.slice(0, 3);
    if (pick.length) {
      $('#rank').innerHTML = pick.map((t, i) => `
        <div class="rk" data-pl="${t.id}">
          <span class="rk-i">${String(i + 1).padStart(2, '0')}</span>
          <span class="rk-n">${esc(t.name)}</span>
          <span class="rk-d">${esc(t.updateFrequency || '')}</span>
        </div>`).join('');
      console.log(`HOME_RANK ${pick.length} 个榜单`);
    }
  } catch (e) {
    console.warn('[home] toplist:', e.message);
  }
}

/** 分批把推荐歌单铺进网格（每批 12 个），滚到底再要下一批 */
function renderHomePlaylists(reset = false) {
  const STEP = 14;   // 两行 × 7 列，正好铺满可视宽度
  const next = (state.homePls || []).slice(state.homeShown, state.homeShown + STEP);
  if (!next.length) return false;

  const html = next.map((p) => {
    // personalized 用 picUrl，top/playlist 用 coverImgUrl —— 两个都要认
    const cover = String(p.picUrl || p.coverImgUrl || '').replace(/^http:\/\//, 'https://');
    return `
    <div class="pl-card" data-pl="${p.id}">
      <div class="pl-c" style="background-image:url('${esc(cover)}')"></div>
      <div class="pl-n">${esc(p.name)}</div>
      <div class="pl-s">${fmtCount(p.playCount)} 次播放</div>
    </div>`;
  }).join('');

  if (reset) $('#pl-grid').innerHTML = html;
  else $('#pl-grid').insertAdjacentHTML('beforeend', html);
  state.homeShown += next.length;
  return true;
}

/* ────────── 搜索（真实数据） ────────── */
function normalize(song) {
  const artists = song.ar || song.artists || [];
  const ar = artists.map((x) => x.name).join(' / ');
  const albumObj = song.al || song.album || {};
  return {
    id: song.id,
    t: song.name,
    a: ar || '未知歌手',
    al: albumObj.name || '未知专辑',
    artistId: artists.length ? artists[0].id : 0,
    albumId: albumObj.id || 0,
    cover: String(albumObj.picUrl || albumObj.pic || '').replace(/^http:\/\//, 'https://'),
    dur: Math.round((song.dt || song.duration || 0) / 1000),
    fee: song.fee,
    sq: null
  };
}

function rowHtml(t, i, key) {
  return `
    <div class="res-row" data-key="${esc(key)}">
      <span class="res-idx">${String(i + 1).padStart(2, '0')}</span>
      <div style="flex:1;min-width:0">
        <div class="res-t">${esc(t.t)}</div>
        <div class="res-a">${esc(t.a)}${t.al ? ' — ' + esc(t.al) : ''}</div>
      </div>
      <button class="like-btn ${state.liked.has(t.id) ? 'on' : ''}" data-like="${t.id}" aria-label="喜欢">
        <svg viewBox="0 0 24 24"><path d="M12 20.4S4.6 15.7 2.7 11.4C1.3 8.2 3.2 5.1 6.5 5.1c1.9 0 3.3 1 4.1 2.2h2.8c.8-1.2 2.2-2.2 4.1-2.2 3.3 0 5.2 3.1 3.8 6.3C19.4 15.7 12 20.4 12 20.4z"/></svg>
      </button>
      <span class="res-badge ${t.sq === false ? 'bad' : ''}" data-badge="${esc(key)}">
        ${t.freq && t.bits
          ? `${(t.freq / 1000).toFixed(1)}k/${t.bits}bit`
          : t.codec && t.path
            ? t.codec
            : (t.sq === true ? 'SQ 无损' : t.sq === false ? '非无损' : '待验')}
      </span>
      <span class="res-dur">${t.dur ? fmt(t.dur) : ''}</span>
    </div>`;
}

/** 把一组曲目渲染进某个容器，并记下 key → track 的映射 */
function renderList(hostId, list, subText, subHostId) {
  state.rows = state.rows || new Map();
  state.queue = list;          // 当前列表即播放队列（上一曲/下一曲靠它）
  state.qi = -1;
  const keys = [];
  const html = list.map((t, i) => {
    const key = String(t.path || t.id);
    state.rows.set(key, t);
    keys.push(key);
    return rowHtml(t, i, key);
  }).join('');
  document.getElementById(hostId).innerHTML = html || '<div class="empty">没有内容</div>';
  if (subHostId) document.getElementById(subHostId).textContent = subText || '';
  return keys;
}

function renderTracks(list, keyword, subText) {
  renderList('search-list', list, subText || `「${keyword}」· ${list.length} 条`, 'search-sub');
}

async function doSearch(keyword) {
  switchView('search');
  state.searchKeyword = keyword;
  $('#search-sub').textContent = `搜索「${keyword}」…`;
  $('#search-list').innerHTML = '<div class="empty">搜索中…</div>';
  try {
    const r = await api.search(keyword, 1, 30);
    state.searchData = {
      songs: r.songs.map(normalize),
      artists: r.artists || [],
      albums: r.albums || [],
      playlists: r.playlists || [],
      total: r.total || 0,
    };
    // 停在其他 tab 时，新关键词要补拉那类
    if (state.searchTab !== 'songs') await fetchSearchTab(state.searchTab);
    renderSearchTab();
  } catch (e) {
    $('#search-list').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

/** 按当前 tab 渲染搜索结果 */
function renderSearchTab() {
  const d = state.searchData;
  const kw = state.searchKeyword || '';
  if (!d) return;

  const counts = {
    songs: d.songs.length,
    artists: d.artists.length,
    albums: d.albums.length,
    playlists: d.playlists.length,
  };
  $$('#search-tabs button').forEach((b) => {
    const t = b.dataset.tab;
    b.classList.toggle('on', t === state.searchTab);
    b.textContent = `${({ songs: '单曲', artists: '歌手', albums: '专辑', playlists: '歌单' })[t]} ${counts[t] || ''}`.trim();
  });

  if (state.searchTab === 'songs') {
    state.searchList = d.songs;
    renderList('search-list', d.songs, `「${kw}」· 显示 ${d.songs.length} / 共 ${d.total} 条`, 'search-sub');
    return;
  }

  const pick = state.searchTab === 'artists' ? d.artists
    : state.searchTab === 'albums' ? d.albums : d.playlists;
  if (!pick.length) {
    $('#search-list').innerHTML = '<div class="empty">这一类没有结果</div>';
    return;
  }

  const cardHtml = (item, kind) => {
    const cover = kind === 'artists'
      ? (item.picUrl || item.img1v1Url || '')
      : (item.picUrl || item.coverImgUrl || '');
    const sub = kind === 'artists' ? '歌手'
      : kind === 'albums' ? (item.artist && item.artist.name) || '专辑'
      : `${fmtCount(item.playCount)} 次播放`;
    const id = item.id;
    return `<div class="sc-card is-${kind}" data-kind="${kind}" data-id="${id}" data-name="${esc(item.name)}">
      <div class="sc-cover" style="background-image:url('${esc(String(cover).replace(/^http:\/\//, 'https://'))}')"></div>
      <div class="sc-name">${esc(item.name)}</div>
      <div class="sc-sub">${esc(sub)}</div>
    </div>`;
  };

  const kind = state.searchTab === 'artists' ? 'artist' : state.searchTab === 'albums' ? 'album' : 'playlist';
  $('#search-list').innerHTML = `<div class="sc-grid">${pick.map((x) => cardHtml(x, kind)).join('')}</div>`;
  $('#search-sub').textContent = `「${kw}」· ${counts[state.searchTab]} 个结果`;
}

/* ────────── 播放 ────────── */
let playSeq = 0;   // 播放请求代次：连点时只有最后一次有效

async function playTrack(track) {
  const mySeq = ++playSeq;

  // ── 换碟：旧碟向下抽离 → 换数据 → 新碟从下方升起落盘 ──
  const wrap = $('#disc-wrap');
  const isSwap = !!(wrap && state.current && state.current.id !== track.id);
  state.swapping = isSwap;

  if (isSwap) {
    // ① 先把唱臂抬离盘面，手才够得到碟
    setArm(false);
    await new Promise((r) => setTimeout(r, 330));

    // ② 再抽碟
    wrap.style.animation = 'disc-out .52s cubic-bezier(.55,0,.85,.35) forwards';
    await new Promise((r) => setTimeout(r, 520));

    // 关键：碟此刻在画面外，先把新封面下完，否则升起时看到的是空盘
    if (track.cover) {
      await new Promise((resolve) => {
        const im = new Image();
        const fin = () => resolve();
        im.onload = fin;
        im.onerror = fin;
        im.src = track.cover;
        setTimeout(fin, 700);   // 网络慢也别卡住，最多等 0.7s
      });
    }
  }

  // 换碟期间又点了别的歌 → 本次作废，别再改 UI / 发 load
  if (mySeq !== playSeq) return false;

  setCurrent(track);
  openPlayer();

  if (isSwap) {
    wrap.style.animation = 'disc-in .58s cubic-bezier(.2,.85,.3,1) forwards';
    setTimeout(() => {
      wrap.style.animation = '';
      state.swapping = false;
      if (state.playing) setArm(true);   // 碟落定后唱针才落下
    }, 600);
  }
  setLoading(true);
  const done = () => setLoading(false);   // 成功路径等 ack 关，失败路径立即关

  // 本地文件：直接交给引擎（路径由 BASS 按 UTF-16 打开）
  if (track.path) {
    setStatus('打开本地文件…');
    loadLyricLocal(track);
    if (!sendLoad({ source: track.path, trackId: null })) {
      setStatus('引擎未连接'); done(); return false;
    }
    pushRecent(track);
    return true;
  }

  if (!state.loggedIn) { setStatus('未登录：无法取流'); done(); return false; }
  setStatus('取流中…');

  let u;
  try {
    u = await api.songUrl(track.id, 'lossless');
  } catch (e) {
    console.warn(`[play] 取流失败 id=${track.id} 「${track.t}」: ${e.message}`);
    setStatus('取流失败: ' + e.message);
    done();
    return false;
  }

  // 无损拿不到 → 退一档到 320k；仍然播，但档位必须显式摆出来（不静默降级）
  if (!u.url) {
    try { u = await api.songUrl(track.id, 'exhigh'); } catch {}
  }
  if (!u.url) {
    console.warn(`[play] 无直链 id=${track.id} 「${track.t}」: ${u.reason || '无权限或下架'}`);
    setStatus('无法播放：' + (u.reason || '无播放权限或已下架'));
    done();
    return false;
  }

  const health = audioHealth(u);
  const tier = health.text;
  if (mySeq !== playSeq) return false;   // 取流期间被更新的请求取代

  track.sq = !!u.lossless;
  track.health = health.level;
  track.kbps = health.kbps;

  const markBad = ['lossy', 'suspect', 'dead'].includes(health.level);
  const markWarn = health.level === 'warn';

  const badge = document.querySelector(`[data-badge="${track.id}"]`);
  if (badge) {
    badge.textContent = tier;
    badge.classList.toggle('bad', markBad);
    badge.classList.toggle('warn', markWarn);
  }
  const q = $('#pb-q');
  q.textContent = tier;
  q.classList.toggle('bad', markBad);
  q.classList.toggle('warn', markWarn);
  q.title = markWarn ? '码率偏低，可能是低质量源转成的 FLAC（安静曲目也可能偏低）' : tier;

  loadLyric(track.id);

  if (!sendLoad({ source: u.url, trackId: track.id })) {
    console.warn(`[play] 引擎未连接（WS ${state.engineOpen ? 'open' : 'closed'}）`);
    setStatus('引擎未连接'); done(); return false;
  }
  console.log(`[play] load 已发 id=${track.id} 「${track.t}」 ${u.lossless ? 'SQ' : Math.round((u.br || 0) / 1000) + 'k'}`);
  pushRecent(track);
  return true;
}

function setCurrent(track) {
  state.current = track;
  state.ending = false;
  state.stallCheck = { lastPos: 0, lastAt: Date.now(), retried: 0 };
  state.dur = track.dur || 0;
  state.pos = 0;

  $('#pb-t').textContent = track.t;
  $('#pb-a').textContent = track.a;
  $('#pb-time').textContent = `0:00 / ${fmt(state.dur)}`;
  $('#pb-bar i').style.width = '0%';
  $('#pl-groove i').style.width = '0%';
  $('#pl-dur').textContent = fmt(state.dur);
  $('#pl-pos').textContent = '0:00';

  $('#pl-lyric').innerHTML = '<div>—</div>';
  state.lyric = [];
  state.lyricIdx = -1;

  // 黑胶中心封面：有图用图，没图退回金/蓝渐变
  const cov = $('#pl-cover');
  if (track.cover) { cov.src = track.cover; cov.hidden = false; }
  else { cov.removeAttribute('src'); cov.hidden = true; }

  // 底栏小封面（同一张图）
  const pbc = $('#pb-cover');
  pbc.style.backgroundImage = track.cover ? `url('${track.cover}')` : '';

  syncLikeUI(track.id);
  updateMediaSession(track);
  $('#pl-title').textContent = track.t;
  $('#pl-meta').innerHTML =
    `<span class="lnk" data-artist="${track.artistId || ''}">${esc(track.a)}</span><span class="dot">·</span>` +
    `<span class="lnk" data-album="${track.albumId || ''}">《${esc(track.al)}》</span>`;
}

/* ────────── 喜欢（扁平心形 + 拟物开关共用一套状态） ────────── */
async function toggleLike(id) {
  if (!id || !state.loggedIn) { setStatus('需要登录才能喜欢'); return; }
  const next = !state.liked.has(id);
  try {
    const ok = await api.likeSong(id, next);
    if (!ok) throw new Error('服务端拒绝');
  } catch (e) {
    setStatus('喜欢操作失败：' + e.message);
    return;
  }
  if (next) state.liked.add(id); else state.liked.delete(id);

  document.querySelectorAll(`.like-btn[data-like="${id}"]`)
    .forEach((b) => b.classList.toggle('on', next));
  if (state.current && state.current.id === id) syncLikeUI(id);
  setStatus(next ? '已加入「我喜欢的音乐」' : '已取消喜欢');
}

function syncLikeUI(id) {
  const on = !!(id && state.liked.has(id));
  const sw = $('#like-switch');
  if (sw) {
    sw.classList.toggle('on', on);
    sw.title = on ? '已喜欢（下拨取消）' : '上拨 = 喜欢';
  }
}

function togglePlay() {
  if (!state.current) return;
  engSend({ cmd: state.playing ? 'pause' : 'resume' });
}

/** 上一曲 / 下一曲：在「当前列表」内移动 */
function stepQueue(delta, { wrap = true } = {}) {
  const q = state.queue || [];
  if (!q.length || delta === 0) return;
  let n = (state.qi < 0 ? 0 : state.qi) + delta;
  n = wrap ? ((n % q.length) + q.length) % q.length : Math.max(0, Math.min(q.length - 1, n));
  state.qi = n;
  playTrack(q[n]);
}

/**
 * 切歌总入口：delta = +1 下一首 / -1 上一首
 * 随机模式下：下一首随机挑（记入历史），上一首从历史栈回退
 */
function advance(delta) {
  if (state.radioMode) { radioNext(true); return; }   // 手动切歌：不受节流
  const q = state.queue || [];
  if (!q.length) return;

  if (settings.playMode !== 'shuffle') { stepQueue(delta); return; }

  if (delta > 0) {
    state.history.push(state.qi);
    let n;
    if (q.length === 1) n = 0;
    else do { n = Math.floor(Math.random() * q.length); } while (n === state.qi);
    state.qi = n;
    playTrack(q[n]);
    return;
  }

  // 上一首：优先回历史，没有历史再随机（避免原地不动）
  if (state.history.length) {
    const n = state.history.pop();
    state.qi = n;
    playTrack(q[n]);
    return;
  }
  let n = Math.floor(Math.random() * q.length);
  if (q.length > 1 && n === state.qi) n = (n + 1) % q.length;
  state.qi = n;
  playTrack(q[n]);
}

/** 一首播完：按模式决定下一首 */
function onTrackEnd() {
  // 防抖：真播完才切，避免状态抖动导致连环切歌/连环取流
  const now = Date.now();
  if (state.lastEndAt && now - state.lastEndAt < 4000) return;
  state.lastEndAt = now;

  if (state.radioMode) { radioNext(); return; }   // 漫游优先，播完就取下一首

  const q = state.queue || [];
  if (!q.length) { setStatus('列表播完'); return; }
  if (settings.playMode === 'one') { playTrack(state.current || q[state.qi]); return; }
  advance(1);
}

/** 播放位置到达结尾 → 触发下一首（0.3s 防抖，避免连发） */
function checkTrackEnd(s) {
  if (!state.playing || !s.dur) return;
  if (s.pos < s.dur - 0.35) return;
  if (state.ending) return;
  state.ending = true;
  setTimeout(() => { state.ending = false; onTrackEnd(); }, 300);
}

/* ────────── 视图 ────────── */
function switchView(name, { push = true } = {}) {
  // 压栈的是「离开的那一页」。只有当它本身能脱离参数复原时才记，
  // playlist/artist/album 靠 id 渲染、复原不了，所以作为来源时不入栈。
  const sourceRecoverable = !['playlist', 'artist', 'album'].includes(state.view);
  if (push && sourceRecoverable && state.view && state.view !== name) {
    state.viewStack.push(state.view);
    if (state.viewStack.length > 20) state.viewStack.shift();
  }
  state.view = name;
  $$('.view').forEach((v) => v.classList.remove('on'));
  $$('#htabs button').forEach((b) => b.classList.toggle('on', b.dataset.view === name));
  $$('#sidebar .nav-i').forEach((b) => b.classList.toggle('on', b.dataset.view === name));

  // 本地库工具栏只属于本地页。必须放在这里——下面每个分支都是 `return`，
  // 写在它们后面就成了死代码，bar 会一直挂在所有页面上。
  const lb = document.getElementById('local-bar');
  if (lb) lb.hidden = name !== 'local';
  const lp = document.getElementById('local-pls');
  if (lp && name !== 'local') lp.hidden = true;

  if (name === 'home') { $('[data-page="home"]').classList.add('on'); return; }
  if (name === 'search') { $('[data-page="search"]').classList.add('on'); return; }

  $('[data-page="list"]').classList.add('on');
  if (name === 'daily') { showDaily(); return; }
  if (name === 'local') { showLocal(); return; }
  if (name === 'liked') { showLiked(); return; }
  if (name === 'radio') { showRadio(); return; }
  if (name === 'recent') { showRecent(); return; }
  if (name === 'playlist' || name === 'artist' || name === 'album') { return; }   // 内容由各自函数填

  const titles = { radio: '私人漫游', liked: '我喜欢的音乐', recent: '最近播放' };
  $('#list-title').textContent = titles[name] || name;
  $('#list-sub').textContent = '待接入';
  $('#list-body').innerHTML = '<div class="empty">这个页面还没接线</div>';
}

/* ────────── 每日推荐 ────────── */
async function showDaily() {
  $('#list-title').textContent = '每日推荐';
  $('#list-sub').textContent = '加载中…';
  $('#list-body').innerHTML = '<div class="empty">加载中…</div>';
  if (!state.loggedIn) { $('#list-body').innerHTML = '<div class="empty">未登录，无法获取</div>'; return; }
  try {
    const songs = (await api.recommendSongs()).map(normalize);
    $('#list-sub').textContent = `${songs.length} 首 · 每日 6:00 更新`;
    renderList('list-body', songs, `${songs.length} 首 · 每日 6:00 更新`, 'list-sub');
    console.log(`DAILY_OK ${songs.length} 首`);
  } catch (e) {
    $('#list-body').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

/* ────────── 最近播放（纯本地，不依赖网络） ────────── */
const RECENT_KEY = 'yw.recent.v1';

function pushRecent(track) {
  if (!track) return;
  const key = String(track.path || track.id || '');
  if (!key) return;
  try {
    let list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    if (!Array.isArray(list)) list = [];
    list = list.filter((x) => String(x.path || x.id) !== key);
    list.unshift({
      id: track.id, path: track.path || null,
      t: track.t, a: track.a, al: track.al,
      cover: track.cover || '', dur: track.dur || 0, sq: track.sq,
      at: Date.now(),
    });
    if (list.length > 100) list.length = 100;
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch (e) { console.warn('[recent]', e.message); }
}

function showRecent() {
  let list = [];
  try { list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch {}
  $('#list-title').textContent = '最近播放';
  if (!list.length) {
    $('#list-sub').textContent = '0 首';
    $('#list-body').innerHTML = '<div class="empty">还没有播放记录</div>';
    return;
  }
  $('#list-sub').textContent = `${list.length} 首 · 最多保留 100 首`;
  renderList('list-body', list, `${list.length} 首 · 最多保留 100 首`, 'list-sub');
  console.log(`RECENT_OK ${list.length} 首`);
}

/** 漫游舞台：大字 + 呼吸光晕 + 缓慢旋转的九爻印水印 */
function renderRadioStage(track) {
  const body = $('#list-body');
  if (!body) return;

  if (!body.querySelector('.radio-stage')) {
    body.innerHTML = `
      <div class="radio-stage">
        <div class="rs-glow"></div>
        <svg class="rs-mark" viewBox="0 0 96 96" data-logo="plain"></svg>
        <div class="rs-kicker">PRIVATE RADIO</div>
        <div class="rs-song" id="rs-song">—</div>
        <div class="rs-artist" id="rs-artist">—</div>
        <div class="rs-hint"><i class="rs-dot"></i>播完自动续下一首</div>
      </div>`;
    if (window.YW && window.YW.logo) window.YW.logo.paint(body);
  }

  const s = $('#rs-song');
  const a = $('#rs-artist');
  if (track) {
    if (s) { s.textContent = track.t || '—'; s.style.animation = 'none'; void s.offsetWidth; s.style.animation = ''; }
    if (a) a.textContent = track.a || '';
  }
}

/* ────────── 私人漫游：不排队列，点进去就播，播完自动取下一首 ────────── */
async function showRadio() {
  // ⚠ 不要在这里调 switchView('radio')：switchView 的 radio 分支就是调用本函数，
  // 那样会无限递归（RangeError: Maximum call stack size exceeded）。
  // 视图切换已由 switchView 完成，这里只负责填内容。
  $('#list-title').textContent = '私人漫游';
  $('#list-sub').textContent = '连续推荐 · 播完自动续';
  renderRadioStage(null);

  if (!state.loggedIn) {
    $('#list-body').innerHTML = '<div class="empty">未登录，无法漫游</div>';
    return;
  }

  // 手动进入 = 用户想重新开始：清掉上次的冷却和残留锁
  state.radioCooldownUntil = 0;
  state.radioFetching = false;
  state.radioMode = true;
  state.radioPool = [];
  try {
    await radioNext();
  } catch (e) {
    console.error('[radio] 启动异常:', e && e.stack || e);
    state.radioMode = false;
    $('#list-body').innerHTML = `<div class="empty">漫游启动失败<br><span style="color:#8a8a8e">${esc(e.message || e)}</span></div>`;
  }
}

/**
 * 取一批漫游曲目。personal_fm 有风控（返回 code 405「操作频繁」），
 * 所以准备三级源：私人FM → 推荐新歌 → 每日推荐（打乱）
 */
async function fetchRadioBatch() {
  // 失败的源记住 5 分钟，避免每次取流都先等一遍超时（这是「一直在取流」的主因）
  const now = Date.now();
  if (!(state.radioSkip.fm > now)) {
    try {
      const b = await api.personalFm();
      if (b && b.length) return { list: b, from: 'fm' };
    } catch (e) {
      state.radioSkip.fm = now + 300_000;
      console.warn('[radio] fm 不可用（5 分钟内跳过）:', e.message);
    }
  }

  if (!(state.radioSkip.newsong > now)) {
    try {
      const b = await api.newsong(10);
      if (b && b.length) return { list: b, from: 'newsong' };
    } catch (e) {
      state.radioSkip.newsong = now + 300_000;
      console.warn('[radio] newsong 不可用（5 分钟内跳过）:', e.message);
    }
  }

  const d = await api.recommendSongs();
  const shuffled = (d || []).slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return { list: shuffled, from: 'daily' };
}

/** 取一首开播；池子空了就再向接口要一批（每次 3 首） */
async function radioNext(force = false) {
  // 节流只约束「自动」切歌；用户手点下一曲必须立刻响应
  const nowMs = Date.now();
  if (!force && state.radioLastAt && nowMs - state.radioLastAt < 1000) return;
  state.radioLastAt = nowMs;

  console.log(`[radio] next: pool=${(state.radioPool || []).length} fetching=${state.radioFetching} cooldown=${Math.max(0, Math.round(((state.radioCooldownUntil || 0) - Date.now()) / 1000))}s`);

  // 冷却期：接口风控（code 405「操作频繁」）时不要连环重试，否则会把自己锁死
  if (state.radioCooldownUntil && Date.now() < state.radioCooldownUntil) {
    const left = Math.ceil((state.radioCooldownUntil - Date.now()) / 1000);
    setStatus(`漫游限流中，${left} 秒后可再试`);
    if (state.view === 'radio') {
      $('#list-body').innerHTML = `<div class="empty">漫游限流中<br><span style="color:#8a8a8e">${left} 秒后再点一次</span></div>`;
    }
    return;
  }

  if (!state.radioPool || !state.radioPool.length) {
    if (state.radioFetching) {
      console.log('[radio] 已有请求在跑，跳过');
      if (state.view === 'radio') {
        $('#list-body').innerHTML = '<div class="empty">正在取流…</div>';
      }
      return;
    }
    state.radioFetching = true;
    try {
      const { list, from } = await fetchRadioBatch();
      const batch = list.map(normalize).filter((t) => t.id);
      if (!batch.length) throw new Error('所有推荐源都没返回曲目');
      state.radioPool = batch;
      console.log(`RADIO_BATCH +${batch.length} (${from})`);
      if (from !== 'fm') setStatus(`私人FM 限流中，已切到「${from === 'newsong' ? '推荐新歌' : '每日推荐'}」`);
    } catch (e) {
      state.radioMode = false;
      state.radioCooldownUntil = Date.now() + 60_000;
      setStatus(`漫游暂不可用：${e.message}（60 秒后可再试）`);
      if (state.view === 'radio') {
        $('#list-body').innerHTML =
          `<div class="empty">漫游暂不可用<br><span style="color:#8a8a8e">${esc(e.message)}</span><br>60 秒后再点一次</div>`;
      }
      return;
    } finally {
      state.radioFetching = false;
    }
  }

  // 取一首就播；取流失败则跳过继续（最多 3 首），避免一路空转到把队列刷光
  let played = false;
  let t = null;
  for (let i = 0; i < 3; i++) {
    // 用户已手动点歌/切走漫游 → 立刻放弃本轮，别再抢播放权
    if (!state.radioMode) { console.log('[radio] 已被用户接管，停止本轮'); return; }
    if (i > 0 && state.radioLastAbort) return;

    t = state.radioPool.shift();
    if (!t) break;

    state.queue = [t];
    state.qi = 0;
    state.radioPumping = true;
    const ok = await playTrack(t);
    state.radioPumping = false;

    // playTrack 返回 false 也可能是"被更新的请求取代"，此时绝不能继续下一首
    if (!state.radioMode) { console.log('[radio] playTrack 期间被接管，停止'); return; }

    if (ok) { played = true; break; }
    console.warn(`[radio] 跳过不可播：${t.t}`);
  }

  if (!played) {
    state.radioMode = false;
    setStatus('漫游暂停：连续 3 首都取不到流');
    if (state.view === 'radio') {
      $('#list-body').innerHTML =
        '<div class="empty">漫游暂停<br><span style="color:#8a8a8e">连续 3 首都取不到流，再点一次试试</span></div>';
    }
    return;
  }

  if (state.view === 'radio') renderRadioStage(t);
}

/* ────────── 我喜欢的音乐 ────────── */
async function showLiked() {
  $('#list-title').textContent = '我喜欢的音乐';
  $('#list-sub').textContent = '加载中…';
  $('#list-body').innerHTML = '<div class="empty">加载中…</div>';
  if (!state.loggedIn || !state.uid) {
    $('#list-body').innerHTML = '<div class="empty">未登录，无法获取</div>';
    return;
  }
  try {
    const ids = await api.likelist(state.uid);
    if (!ids.length) {
      $('#list-sub').textContent = '0 首';
      $('#list-body').innerHTML = '<div class="empty">还没有喜欢的歌</div>';
      return;
    }
    const songs = (await api.songDetail(ids.slice(0, 500))).map(normalize);
    $('#list-sub').textContent = `${songs.length} 首`;
    renderList('list-body', songs, `${songs.length} 首`, 'list-sub');
    console.log(`LIKED_OK ${songs.length} 首`);
  } catch (e) {
    $('#list-body').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    console.warn('[liked]', e.message);
  }
}

/* ────────── 歌单详情 ────────── */
/**
 * 侧栏「我的歌单」：自己创建的排在前面，收藏的跟在后面。
 * subscribed === true 表示收藏的（别人建的、我收了）。
 */
async function loadSidePlaylists(uid) {
  const box = document.getElementById('side-pls');
  if (!box || !uid) return;

  box.innerHTML = '<div class="sp-empty">加载中…</div>';
  try {
    // specialType === 5 是「我喜欢的音乐」系统歌单，侧栏已有独立入口，跳过
    const list = (await api.userPlaylists(uid, 200)).filter((p) => p.specialType !== 5);
    const created = list.filter((p) => !p.subscribed);
    const favorited = list.filter((p) => p.subscribed);
    const all = [...created, ...favorited];

    if (!all.length) {
      box.innerHTML = '<div class="sp-empty">还没有歌单</div>';
      return;
    }

    box.innerHTML = all
      .map(
        (p) => `<button class="nav-i side-pl" data-pl="${p.id}" title="${esc(p.name)}（${p.trackCount || 0} 首）">
          <span class="sp-nm">${esc(p.name)}</span>
          <span class="sp-ct">${p.trackCount || 0}</span>
        </button>`
      )
      .join('');
    console.log(`SIDE_PL 歌单 ${created.length} 创建 / ${favorited.length} 收藏`);
  } catch (e) {
    box.innerHTML = '';
    console.warn('[side-pls]', e.message);
  }
}

async function showPlaylist(id) {
  switchView('playlist');
  $('#list-title').textContent = '歌单';
  $('#list-sub').textContent = '加载中…';
  $('#list-body').innerHTML = '<div class="empty">加载中…</div>';
  try {
    const pl = await api.playlistDetail(id);
    if (!pl) throw new Error('歌单不存在');
    const songs = (await api.playlistTracks(id, 500)).map(normalize);
    $('#list-title').textContent = pl.name || '歌单';
    $('#list-sub').textContent = `${songs.length} 首 · ${fmtCount(pl.playCount)} 次播放`;
    renderList('list-body', songs, `${songs.length} 首`, 'list-sub');
    console.log(`PLAYLIST_OK ${pl.name} ${songs.length} 首`);
  } catch (e) {
    $('#list-body').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    console.warn('[playlist]', e.message);
  }
}

/* ────────── 歌手页 ────────── */
async function showArtist(id) {
  closePlayer();
  switchView('artist');
  $('#list-title').textContent = '歌手';
  $('#list-sub').textContent = '加载中…';
  $('#list-body').innerHTML = '<div class="empty">加载中…</div>';
  try {
    const r = await api.artistSongs(id, 50);
    const songs = r.songs.map(normalize);
    $('#list-title').textContent = r.name || '歌手';
    $('#list-sub').textContent = `热门 ${songs.length} 首`;
    renderList('list-body', songs, `${songs.length} 首`, 'list-sub');
    console.log(`ARTIST_OK ${r.name} ${songs.length} 首`);
  } catch (e) {
    $('#list-body').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    console.warn('[artist]', e.message);
  }
}

/* ────────── 专辑页 ────────── */
async function showAlbum(id) {
  closePlayer();
  switchView('album');
  $('#list-title').textContent = '专辑';
  $('#list-sub').textContent = '加载中…';
  $('#list-body').innerHTML = '<div class="empty">加载中…</div>';
  try {
    const r = await api.albumSongs(id);
    const songs = r.songs.map(normalize);
    $('#list-title').textContent = r.name || '专辑';
    $('#list-sub').textContent = `${songs.length} 首`;
    renderList('list-body', songs, `${songs.length} 首`, 'list-sub');
    console.log(`ALBUM_OK ${r.name} ${songs.length} 首`);
  } catch (e) {
    $('#list-body').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    console.warn('[album]', e.message);
  }
}

/* ────────── 本地音乐 ────────── */
/** 本地页的 m3u 播放列表标签 */
function renderLocalPlaylists(playlists) {
  const box = document.getElementById('local-pls');
  if (!box) return;

  state.localPlaylists = playlists || [];
  if (!state.localPlaylists.length) { box.hidden = true; box.innerHTML = ''; return; }

  box.hidden = false;
  const total = (state.localTracks || []).length;
  box.innerHTML =
    '<span class="lp-g">视图</span>' +
    `<button class="lp-i on" data-pl="all" title="显示全部文件">
       <span class="lp-nm">全部</span><span class="lp-ct">${total}</span>
     </button>` +
    state.localPlaylists
      .map(
        (p, i) => `<button class="lp-i" data-pl="${i}" title="${esc(p.path)}">
          <span class="lp-nm">${esc(p.name)}</span>
          <span class="lp-ct">${p.count}</span>
        </button>`
      )
      .join('');
}

/** 渲染库目录列表（带每个目录的文件数） */
function renderLibraryDirs(dirs, files) {
  const box = document.getElementById('lb-dirs');
  if (!box) return;

  if (!dirs || !dirs.length) {
    box.innerHTML = '<div class="lb-empty">还没有添加文件夹 — 点右侧「+ 添加文件夹」，或把文件夹拖进窗口</div>';
    return;
  }

  const counts = {};
  if (files) {
    for (const f of files) {
      const hit = dirs.find((d) => f.path.startsWith(d));
      if (hit) counts[hit] = (counts[hit] || 0) + 1;
    }
  }

  box.innerHTML = dirs
    .map(
      (d) => `<div class="lb-dir">
        <span class="d-path" title="${esc(d)}">${esc(d)}</span>
        ${counts[d] !== undefined ? `<span class="d-n">${counts[d]} 首</span>` : ''}
        <button class="d-x" data-dir="${esc(d)}" title="从音乐库移除（不删文件）">×</button>
      </div>`
    )
    .join('');
}

/** 把一次扫描结果渲染到本地页（预扫快照与手动重扫共用同一套） */
function applyLocalResult(res, libDirs) {
  const files = (res && res.files) || [];
  const dirs = (res && res.dirs) || libDirs || [];
  renderLibraryDirs(dirs, files);

  const tracks = files.map((f) => {
    const parts = f.name.split(' - ');
    const m = f.meta || {};
    // 优先用内嵌标签；没有才回退到「歌手 - 歌名」文件名
    const a = m.artist || (parts.length > 1 ? parts[0].trim() : '未知歌手');
    const t = m.title || (parts.length > 1 ? parts.slice(1).join(' - ').trim() : f.name);
    const al = m.album || f.ext.toUpperCase();
    const cover = f.cover ? 'file:///' + String(f.cover).replace(/\\/g, '/') : '';
    return {
      path: f.path, t, a, al,
      dur: Math.round(m.dur || 0),
      sq: true,
      cover,
      freq: m.freq || 0,
      bits: m.bits || 0,
      codec: (m.codec || f.ext).toUpperCase(),
    };
  });

  state.localTracks = tracks;
  renderLocalPlaylists((res && res.playlists) || []);   // 要等 localTracks 就位，「全部」才数得对

  const losslessN = tracks.filter((x) => /FLAC|WAV|APE|AIFF|DFF|DSF/i.test(x.codec)).length;
  renderList('list-body', tracks, `${tracks.length} 个文件 · ${losslessN} 个无损容器`, 'list-sub');
  console.log(`LOCAL_OK ${tracks.length} 个文件 · ${((res && res.playlists) || []).length} 个播放列表`);
}

/**
 * 进入本地页。
 * 目录扫描只在两种时候发生：应用启动后预扫一次、用户点「重新扫描」。
 * 平时切回来直接用快照，不碰磁盘。
 */
async function showLocal(force = false) {
  $('#list-title').textContent = '本地音乐';

  const bar = document.getElementById('local-bar');
  if (bar) bar.hidden = false;

  let libDirs = [];
  try {
    const lib = await window.yw.libraryGet();
    libDirs = (lib && lib.dirs) || [];
  } catch {}
  renderLibraryDirs(libDirs, null);

  // 有快照且不是强制刷新 → 直接渲染，不扫盘
  if (!force && state.localSnapshot) {
    applyLocalResult(state.localSnapshot, libDirs);
    console.log('LOCAL_CACHED 使用启动时的扫描结果');
    return;
  }

  $('#list-sub').textContent = '扫描中…';
  $('#list-body').innerHTML = '<div class="empty">正在扫描音乐库…</div>';

  try {
    const res = await window.yw.scanLocal({ force });
    state.localSnapshot = res;
    applyLocalResult(res, libDirs);
  } catch (e) {
    $('#list-body').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

/** 启动后预扫一次，进本地页就不用等 */
function preloadLocalLibrary(delay = 1500) {
  setTimeout(async () => {
    try {
      const res = await window.yw.scanLocal({});
      state.localSnapshot = res;
      console.log(`LOCAL_PRELOAD ${(res && res.files ? res.files.length : 0)} 个文件`);
      // 预扫期间用户已经切到本地页 → 补渲染（快照优先，不会重复扫）
      if (state.view === 'local' && !state.localTracks) applyLocalResult(res);
    } catch (e) {
      console.warn('[local preload]', e.message);
    }
  }, delay);
}

function openPlayer() { $('#player-view').classList.add('on'); }
function closePlayer() {
  $('#player-view').classList.remove('on');
  // 播放页收起时，面板贴在 104px 会悬空，直接收起
  const qp = $('#queue-panel');
  if (qp && qp.classList.contains('open')) toggleQueue(false);
}

/* ────────── 事件 ────────── */
$$('#htabs button, #sidebar .nav-i').forEach((b) => {
  b.addEventListener('click', () => switchView(b.dataset.view));
});

$('#pl-meta').addEventListener('click', (e) => {
  const lnk = e.target.closest('.lnk');
  if (!lnk) return;
  if (lnk.dataset.artist) showArtist(lnk.dataset.artist);
  else if (lnk.dataset.album) showAlbum(lnk.dataset.album);
});

// 发现页刷新：重拉推荐歌单 + 榜单
$('#home-refresh').addEventListener('click', async () => {
  const btn = $('#home-refresh');
  if (btn.classList.contains('spin')) return;   // 防连点

  btn.classList.add('spin');
  setStatus('正在刷新推荐…');
  state.homePls = [];
  state.homeShown = 0;
  $('#pl-grid').innerHTML = '';
  $('#rank').innerHTML = '';

  try {
    await loadHomeReal({ mix: true });
    setStatus('推荐已刷新');
    console.log('[home] 手动刷新完成');
  } catch (e) {
    setStatus('刷新失败：' + e.message);
    console.warn('[home] 刷新失败', e.message);
  } finally {
    btn.classList.remove('spin');
  }
});

// 首页推荐歌单：滚轮在网格上 = 横向滑动；滑到右端再铺一批
let homeScrollAt = 0;
$('#pl-grid').addEventListener('wheel', (e) => {
  const el = $('#pl-grid');
  const delta = e.deltaY || e.deltaX || 0;
  if (!delta) return;

  const loadMore = () => {
    const now = Date.now();
    if (now - homeScrollAt < 300) return;
    homeScrollAt = now;
    if (state.homeShown < (state.homePls || []).length) {
      renderHomePlaylists();
      console.log(`[home] 追加推荐歌单 → 已显示 ${state.homeShown}/${state.homePls.length}`);
    }
  };

  // 内容还没超过容器宽度（不用滑）→ 直接加载，且不拦页面滚动
  if (el.scrollWidth <= el.clientWidth) {
    console.log('[home] 内容未溢出，直接加载下一批');
    loadMore();
    return;
  }

  e.preventDefault();                    // 有得滑：拦页面纵向滚动
  const before = el.scrollLeft;
  el.scrollLeft = before + delta;

  // 已经贴着右端（滑不动了）或快到头 → 加载下一批
  if (el.scrollLeft === before || el.scrollLeft + el.clientWidth >= el.scrollWidth - 200) {
    loadMore();
  }
}, { passive: false });

$('#search-tabs').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-tab]');
  if (!b) return;

  state.searchTab = b.dataset.tab;
  // 先点亮，保证任何情况下点击都有反馈
  $$('#search-tabs button').forEach((x) => x.classList.toggle('on', x === b));

  const label = ({ songs: '单曲', artists: '歌手', albums: '专辑', playlists: '歌单' })[state.searchTab];
  const kw = (($('#q') && $('#q').value) || '').trim();

  // ① 搜索框空着：给出明确引导，而不是死点
  if (!kw) {
    $('#search-sub').textContent = '输入关键词后回车';
    $('#search-list').innerHTML =
      `<div class="empty">在搜索框输入关键词，按回车开始搜索<br>
        <span style="color:#5a5a5e;font-size:11px">当前分类：${label}</span></div>`;
    return;
  }

  // ② 有关键词但还没搜过（或换了词）：直接搜
  if (!state.searchData || state.searchKeyword !== kw) {
    await doSearch(kw);
    return;
  }

  // ③ 已搜过：该分类没数据就补拉
  if (state.searchTab !== 'songs' && !state.searchData[state.searchTab].length) {
    await fetchSearchTab(state.searchTab);
  }
  renderSearchTab();
});

/** 按类型补拉搜索结果：artists→100 / albums→10 / playlists→1000 */
async function fetchSearchTab(tab) {
  const typeMap = { artists: 100, albums: 10, playlists: 1000 };
  const type = typeMap[tab];
  if (!type) return;
  try {
    $('#search-list').innerHTML = '<div class="empty">加载中…</div>';
    const r = await api.search(state.searchKeyword, type, 30);
    state.searchData[tab] = tab === 'artists' ? r.artists : tab === 'albums' ? r.albums : r.playlists;
    console.log(`[search] ${tab} ${state.searchData[tab].length} 个`);
  } catch (e) {
    console.warn('[search] 补拉失败', tab, e.message);
    state.searchData[tab] = [];
  }
}

$('#search-list').addEventListener('click', (e) => {
  const card = e.target.closest('.sc-card[data-id]');
  if (!card) return;
  const id = card.dataset.id;
  if (card.dataset.kind === 'artist') showArtist(id);
  else if (card.dataset.kind === 'album') showAlbum(id);
  else if (card.dataset.kind === 'playlist') showPlaylist(id);
});

$('#pl-grid').addEventListener('click', (e) => {
  const card = e.target.closest('.pl-card');
  if (card && card.dataset.pl) showPlaylist(card.dataset.pl);
});

/** 返回上一视图；栈空则回发现 */
function goBack() {
  const prev = state.viewStack.pop() || 'home';
  switchView(prev, { push: false });
}

$('#list-back').addEventListener('click', goBack);

/* ────────── 播放列表面板：当前播放 / 最近播放 两页 ────────── */
let qpTab = 'queue';   // queue | recent

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / 昨天 / N 天前 */
function relTime(ts) {
  if (!ts) return '';
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d === 1) return '昨天';
  if (d < 30) return `${d} 天前`;
  return new Date(ts).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

function isCurrentTrack(t) {
  const c = state.current;
  if (!c || !t) return false;
  return t.path && c.path ? t.path === c.path : t.id === c.id;
}

function renderQueuePanel() {
  $$('.qp-tab').forEach((b) => b.classList.toggle('on', b.dataset.qt === qpTab));

  // 漫游中：第一个 tab 直接标明状态，免得用户以为队列只有一首
  const qTab = document.querySelector('.qp-tab[data-qt="queue"]');
  if (qTab) qTab.textContent = state.radioMode ? '漫游中' : '当前播放';

  const body = $('#qp-body');
  const cnt = $('#qp-count');
  if (!body) return;

  if (qpTab === 'queue') {
    const q = state.queue || [];
    if (cnt) cnt.textContent = `${q.length} 首`;
    if (!q.length) { body.innerHTML = '<div class="empty">队列为空</div>'; return; }

    const rows = q.map((t, i) => {
      const cur = isCurrentTrack(t);
      return `<div class="qp-row${cur ? ' cur' : ''}" data-qt2="queue" data-qi="${i}">
        <span class="qp-idx">${cur ? '♪' : String(i + 1).padStart(2, '0')}</span>
        <span class="qp-t">${esc(t.t || '')}</span>
        <span class="qp-a">${esc(t.a || '')}</span>
      </div>`;
    }).join('');

    // 漫游队列只有当前这一首，用说明行交代「后面会自动续」
    const note = state.radioMode
      ? '<div class="qp-radio-tip"><span class="qp-dot"></span>私人漫游进行中 · 播完自动续下一首</div>'
      : '';

    body.innerHTML = note + rows;
    return;
  }

  // 最近播放
  let list = [];
  try { list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch {}
  if (cnt) cnt.textContent = `${list.length} 首`;
  if (!list.length) { body.innerHTML = '<div class="empty">还没有播放记录</div>'; return; }

  body.innerHTML = list.map((t, i) => {
    const cur = isCurrentTrack(t);
    return `<div class="qp-row${cur ? ' cur' : ''}" data-qt2="recent" data-ri="${i}">
      <span class="qp-idx">${cur ? '♪' : String(i + 1).padStart(2, '0')}</span>
      <span class="qp-t">${esc(t.t || '')}</span>
      <span class="qp-a">${esc(t.a || '')}</span>
      <span class="qp-when">${relTime(t.at)}</span>
    </div>`;
  }).join('');
}

function toggleQueue(force) {
  const p = $('#queue-panel');
  if (!p) return;
  const open = force === undefined ? !p.classList.contains('open') : !!force;

  if (open) {
    // 面板要贴住「当前这个底栏」的上沿：
    // 主界面底栏 74px，播放页底栏 104px，写死会压住播放页 30px
    const onPlayer = $('#player-view') && $('#player-view').classList.contains('on');
    const bar = onPlayer ? document.querySelector('.pl-bottom') : document.querySelector('.playbar');
    const h = bar ? Math.round(bar.getBoundingClientRect().height) : 74;
    p.style.bottom = `${h}px`;
    renderQueuePanel();
  }
  p.classList.toggle('open', open);
}

$$('.qp-tab').forEach((b) => b.addEventListener('click', () => {
  qpTab = b.dataset.qt;
  renderQueuePanel();
}));

$('#pb-list').addEventListener('click', () => toggleQueue());
$('#pl-list').addEventListener('click', () => toggleQueue());
$('#qp-close').addEventListener('click', () => toggleQueue(false));

$('#qp-body').addEventListener('click', (e) => {
  const row = e.target.closest('.qp-row');
  if (!row) return;

  if (row.dataset.qt2 === 'queue') {
    const i = Number(row.dataset.qi);
    const t = (state.queue || [])[i];
    if (!t) return;
    state.qi = i;
    state.radioMode = false;
    playTrack(t);
  } else {
    const i = Number(row.dataset.ri);
    let list = [];
    try { list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch {}
    const t = list[i];
    if (!t) return;
    state.radioMode = false;
    state.queue = list.slice();   // 从历史点歌，队列换成历史列表
    state.qi = i;
    state.history = [];
    playTrack(t);
  }
  renderQueuePanel();
});

/* ────────── 底栏进度条：点击跳转 + 拖动预览 ────────── */
const seekState = { dragging: false };

(function attachBarSeek() {
  const el = $('#pb-bar');
  if (!el) return;

  const ratioAt = (e) => {
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  };

  const preview = (ratio) => {
    const pct = (ratio * 100).toFixed(2) + '%';
    el.querySelector('i').style.width = pct;
    $('#pl-groove i').style.width = pct;
    const t = ratio * (state.dur || 0);
    $('#pb-time').textContent = `${fmt(t)} / ${fmt(state.dur)}`;
  };

  const commit = (ratio) => {
    if (!state.current || !state.dur) return;
    const seconds = ratio * state.dur;
    engSend({ cmd: 'seek', seconds });
    state.pos = seconds;
    preview(ratio);
  };

  el.addEventListener('pointerdown', (e) => {
    if (!state.current || !state.dur) return;
    seekState.dragging = true;
    el.classList.add('dragging');
    el.setPointerCapture(e.pointerId);
    preview(ratioAt(e));
  });

  el.addEventListener('pointermove', (e) => {
    if (!seekState.dragging) return;
    preview(ratioAt(e));
  });

  const finish = (e) => {
    if (!seekState.dragging) return;
    seekState.dragging = false;
    el.classList.remove('dragging');
    try { el.releasePointerCapture(e.pointerId); } catch {}
    commit(ratioAt(e));
  };

  el.addEventListener('pointerup', finish);
  el.addEventListener('pointercancel', finish);
})();

$('#daily-card').addEventListener('click', () => switchView('daily'));

$('#rank').addEventListener('click', (e) => {
  const rk = e.target.closest('.rk[data-pl]');
  if (rk) showPlaylist(rk.dataset.pl);
});

$('#q').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const kw = e.target.value.trim();
  if (kw) doSearch(kw);
});

document.addEventListener('click', (e) => {
  const lb = e.target.closest('.like-btn');
  if (lb) { toggleLike(Number(lb.dataset.like)); return; }   // 心形不触发行播放

  const row = e.target.closest('.res-row[data-key]');
  if (!row) return;
  const t = state.rows && state.rows.get(row.dataset.key);
  if (!t) return;
  const idx = (state.queue || []).indexOf(t);
  if (idx >= 0) state.qi = idx;
  state.history = [];      // 手动点歌 = 新的随机起点
  state.radioMode = false; // 手动点歌退出漫游
  playTrack(t);
});

/* ────────── 输出设备 ──────────
   Windows：main.html 里写死的 ASIO/WASAPI 清单（已实测，逻辑保持原样）
   macOS  ：引擎枚举 CoreAudio 设备 → 动态生成「扬声器（共享）」+ 每台设备「（独占）」
*/
let outDevice = 0;
let outMode = 'asio';   // Windows: asio | wasapi ／ macOS: shared | exclusive
let macDevices = [];    // macOS：最近一次枚举到的设备
const OUT_DEFAULT_LABEL = '扬声器（共享）';
// 音量：ASIO 独占下由声卡实体旋钮（或系统/功放）控制，本程序不提供软件音量

/** mac：把设置里的 mode 归一成 shared | exclusive（老配置 'asio'/'hog' → exclusive） */
function macMode(m) {
  if (m === 'shared' || m === 'wasapi') return 'shared';
  return 'exclusive';
}
/** mac：把设置里的 device 归一成 'default' 或设备索引（0 在 BASS 里是 No sound，一律当默认） */
function macDev(v) {
  if (v === undefined || v === null || v === 'default' || v === '') return 'default';
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 ? n : 'default';
}

const MODE_META = {
  list: { label: '列表循环', path: '<path d="M7 8h10a3 3 0 0 1 0 6h-2"/><path d="M17 16H7a3 3 0 0 1 0-6h2"/><path d="M8.5 5.5 6 8l2.5 2.5"/><path d="M15.5 18.5 18 16l-2.5-2.5"/>' },
  one:  { label: '单曲循环', path: '<path d="M7 8h10a3 3 0 0 1 0 6h-2"/><path d="M17 16H7a3 3 0 0 1 0-6h2"/><path d="M8.5 5.5 6 8l2.5 2.5"/><path d="M15.5 18.5 18 16l-2.5-2.5"/><path d="M12 10.6v2.8"/>' },
  shuffle: { label: '随机播放', path: '<path d="M4 7h3.6L15 17h4"/><path d="M4 17h3.6L15 7h4"/><path d="M18 4.6 20.4 7 18 9.4"/><path d="M18 14.6 20.4 17 18 19.4"/>' }
};

function updateModeUI() {
  const m = MODE_META[settings.playMode] || MODE_META.list;
  const el = $('#pl-mode-icon');
  if (el) el.innerHTML = m.path;
  const btn = $('#pl-mode');
  if (btn) btn.title = '播放模式：' + m.label;
}

const modeBtn = $('#pl-mode');
if (modeBtn) {
  modeBtn.addEventListener('click', () => {
    const order = ['list', 'one', 'shuffle'];
    const i = order.indexOf(settings.playMode);
    settings.playMode = order[(i + 1) % 3];
    saveSettings();
    updateModeUI();
    setStatus('播放模式：' + MODE_META[settings.playMode].label);
  });
  updateModeUI();
}

$('#like-switch').addEventListener('click', () => {
  if (state.current) toggleLike(state.current.id);
});

$('#pl-prev').addEventListener('click', () => advance(-1));
$('#pl-next').addEventListener('click', () => advance(1));

/** mac：设备号 → 显示名（-1/'default' = 扬声器） */
function outDevName(dev) {
  if (dev === -1 || dev === 'default' || dev === undefined || dev === null) return '扬声器';
  const d = macDevices.find((x) => String(x.index) === String(dev));
  return d ? d.name : '设备';
}

/** mac：第一次真正跑到独占时，说一句人话解释「为什么别的程序没声音」 */
function hintExclusiveOnce() {
  if (!IS_MAC || settings.exclusiveHintShown) return;
  settings.exclusiveHintShown = true;
  saveSettings();
  showToast('独占时其他程序暂时没有声音是正常的', [], 12000);
}

/** mac：切到某台设备独占（外接声卡提示里的「切换」走这里） */
function switchToExclusive(d) {
  outMode = 'exclusive';
  outDevice = d.index;
  settings.outMode = outMode;
  settings.outDevice = outDevice;
  settings.outLabel = `${d.name}（独占）${d.isDefault ? ' · 默认' : ''}`;
  saveSettings();
  applyOutUI();
  state.outFallbackDone = false;
  setStatus('已切到独占，下一次播放生效');
  console.log(`[out] mac 切到独占 dev=${d.index} name=${d.name}`);
}

/** mac：用户点「忽略」→ 这台设备以后不再提示（换新声卡仍会提示） */
function dismissDac(d) {
  const list = Array.isArray(settings.dismissedDevices) ? settings.dismissedDevices : [];
  if (!list.includes(d.name)) list.push(d.name);
  settings.dismissedDevices = list;
  saveSettings();
  console.log(`[out] mac 已忽略外接声卡提示 name=${d.name}`);
}

/**
 * mac：启动后第一次拿到设备列表时判断一次「是不是插着外接声卡」。
 * 只提示一次（每台设备一次），不做自动切换 —— 用户自己点。
 * 判定顺序（宁可不提示也别乱提示）：排除内置/蓝牙，取剩下的第一台，且不能是当前默认设备。
 */
function maybeHintExternalDac() {
  if (!IS_MAC || state.dacHintChecked) return;
  state.dacHintChecked = true;
  if (outMode !== 'shared') return;                       // 已经在独占，不打扰

  // 内置扬声器 / 蓝牙（独占对蓝牙必失败）/ 占位设备都不提示
  // 占位名来自 CI 实测（macos-14 runner）：dev1 = "Default"、dev3 = "Null Audio Device"、
  // "Apple Virtual Sound Device" —— 真机上也可能出现同名虚拟设备，不能当成外接声卡。
  const SKIP = /Built-in|内置|Internal|MacBook|AirPods|Bluetooth|蓝牙|\bDefault\b|Null|Virtual|虚拟/i;
  const defIdx = (macDevices.find((d) => d.isDefault) || {}).index;
  // 不能排除「当前系统默认设备」：macOS 插上 USB DAC 后通常会自动把它设为默认，
  // 此时我们正以共享模式输出到这台 DAC —— 恰恰是最该提示切独占的时刻。
  const cand = macDevices.find((d) => !SKIP.test(`${d.name} ${d.driver}`));
  if (!cand) { console.log('[out] mac 没有可提示的外接声卡'); return; }

  const dismissed = Array.isArray(settings.dismissedDevices) ? settings.dismissedDevices : [];
  if (dismissed.includes(cand.name)) { console.log(`[out] mac 外接声卡已忽略过 name=${cand.name}`); return; }

  console.log(`[out] mac 检测到外接声卡 index=${cand.index} name=${cand.name} 默认设备 index=${defIdx}`);
  showToast(`检测到 ${cand.name}，要切到独占吗？`, [
    { label: '切换', onClick: () => switchToExclusive(cand) },
    { label: '忽略', sub: true, onClick: () => dismissDac(cand) }
  ], 15000);
}

const outSel = $('#pl-output');
const outMenu = $('#out-menu');

/** mac：向引擎要设备清单（WS 连上时、每次打开菜单时各问一次，USB 热插拔能反映出来） */
function requestDevices() {
  if (!IS_MAC) return false;
  return engSend({ cmd: 'devices' });
}

/** mac：按设备清单重建 #out-menu（第一项固定「扬声器（共享）」，其后每台设备一个独占项） */
function renderMacOutMenu(devices) {
  if (!IS_MAC || !outMenu) return;
  const stat = $('#out-static');
  if (stat) stat.remove();            // Windows 的写死项在 mac 上一个都不适用
  outMenu.querySelectorAll('.out-item, .out-sep').forEach((n) => n.remove());

  macDevices = (devices || []).filter((d) => d && Number(d.index) >= 1);   // 只认 ≥1（0 = No sound）
  console.log(`[out] mac 设备 ${macDevices.length} 台: ` +
    macDevices.map((d) => `${d.index}:${d.name}${d.isDefault ? '(默认)' : ''}`).join(' | '));

  const note = outMenu.querySelector('.out-note');
  const add = (el) => outMenu.insertBefore(el, note || null);
  const mk = (dev, mode, label) => {
    const el = document.createElement('div');
    el.className = 'out-item';
    el.dataset.dev = String(dev);
    el.dataset.mode = mode;
    el.dataset.label = label;
    el.textContent = label;
    return el;
  };
  const sep = () => {
    const el = document.createElement('div');
    el.className = 'out-sep';
    return el;
  };

  add(mk('default', 'shared', OUT_DEFAULT_LABEL));
  add(sep());
  if (!macDevices.length) {
    const el = document.createElement('div');
    el.className = 'out-item disabled';
    el.textContent = '未枚举到输出设备';
    add(el);
  }
  for (const d of macDevices) {
    add(mk(d.index, 'exclusive', `${d.name}（独占）${d.isDefault ? ' · 默认' : ''}`));
  }

  // 旧配置迁移来的「独占 + 系统默认设备」（引擎接受 'default'，菜单项却是按索引的）：
  // 设备列表回来后绑到实际的默认设备索引上，菜单才能高亮到具体那一台。
  if (outMode === 'exclusive' && outDevice === 'default') {
    const def = macDevices.find((d) => d.isDefault) || macDevices[0];
    if (def) {
      outDevice = def.index;
      settings.outDevice = outDevice;
      saveSettings();
      console.log(`[out] mac 独占默认设备 → 绑定到 index=${def.index} name=${def.name}`);
    }
  }

  applyOutUI();
  maybeHintExternalDac();   // 启动后第一次拿到设备列表时判断一次外接声卡（内部有一次性开关）
}

/** mac：把 outMode/outDevice 的当前值画到菜单和顶栏按钮上 */
function applyOutUI() {
  if (!IS_MAC || !outSel || !outMenu) return '';
  const wantMode = outMode === 'exclusive' ? 'exclusive' : 'shared';
  const wantDev = wantMode === 'exclusive' ? String(outDevice) : 'default';
  let hit = null;
  outMenu.querySelectorAll('.out-item').forEach((x) => {
    const on = x.dataset.mode === wantMode && x.dataset.dev === wantDev;
    x.classList.toggle('on', on);
    if (on) hit = x;
  });
  const label = (hit && hit.dataset.label) ||
    (wantMode === 'shared' ? OUT_DEFAULT_LABEL : `${(macDevices.find((d) => String(d.index) === wantDev) || {}).name || '设备'}（独占）`);
  settings.outLabel = label;
  outSel.textContent = label + ' ▾';
  return label;
}

/** mac：load 失败时回落「扬声器（共享）」并重试一次（典型场景：拔了 USB 声卡） */
function macLoadFailed(err) {
  if (!IS_MAC) return;
  const s = state.lastLoad;
  if (!s) return;
  // err 码只进 console；界面说人话
  console.warn(`[out] mac 输出失败：${err}`);
  if (state.outFallbackDone) { setStatus('这台声卡用不了，请换一台或改用扬声器（共享）'); return; }
  if (outMode === 'shared' && outDevice === 'default') { setStatus('播放失败，请检查输出设备或稍后重试'); return; }

  state.outFallbackDone = true;
  outMode = 'shared';
  outDevice = 'default';
  settings.outMode = outMode;
  settings.outDevice = outDevice;
  settings.outLabel = OUT_DEFAULT_LABEL;
  saveSettings();
  applyOutUI();
  showOutBadge('shared');
  setStatus('声卡已断开，已切回扬声器');
  showToast('声卡已断开，已切回扬声器', [], 9000);
  requestDevices();                 // 顺手刷新设备列表（拔掉的声卡会消失）
  setTimeout(() => {
    if (!sendLoad(s)) setStatus('引擎未连接');
  }, 150);
}

if (outSel && outMenu) {
  outSel.addEventListener('click', (e) => {
    e.stopPropagation();
    outMenu.hidden = !outMenu.hidden;
    if (IS_MAC && !outMenu.hidden) requestDevices();   // 打开菜单时刷一次设备
  });
  document.addEventListener('click', () => { outMenu.hidden = true; });
  outMenu.addEventListener('click', (e) => {
    e.stopPropagation();
    const it = e.target.closest('.out-item');
    if (!it || it.classList.contains('disabled')) return;

    if (IS_MAC) {
      outMode = macMode(it.dataset.mode);
      outDevice = macDev(it.dataset.dev);
    } else {
      outDevice = Number(it.dataset.dev) || 0;
      outMode = it.dataset.mode || 'asio';
    }

    settings.outDevice = outDevice;
    settings.outMode = outMode;
    settings.outLabel = it.dataset.label || (IS_MAC ? OUT_DEFAULT_LABEL : 'ASIO 独占 · Donner');
    saveSettings();
    state.outFallbackDone = false;
    if (IS_MAC) applyOutUI();
    else outMenu.querySelectorAll('.out-item').forEach((x) => x.classList.toggle('on', x === it));
    outSel.textContent = settings.outLabel + ' ▾';
    outMenu.hidden = true;
    setStatus(`输出切到 ${settings.outLabel}，下一次播放生效`);
    if (IS_MAC) console.log(`[out] mac 选择 mode=${outMode} dev=${outDevice} label=${settings.outLabel}`);
  });
}

$('#pb-prev').addEventListener('click', () => advance(-1));
$('#pb-next').addEventListener('click', () => advance(1));
$('#pb-cover').addEventListener('click', () => { if (state.current) openPlayer(); });
$('#pl-back').addEventListener('click', closePlayer);
$('#pl-play').addEventListener('click', togglePlay);
$('#pb-play').addEventListener('click', togglePlay);

$('#pl-groove').addEventListener('click', (e) => {
  if (!state.dur) return;
  const r = e.currentTarget.getBoundingClientRect();
  const p = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  e.currentTarget.querySelector('i').style.width = (p * 100) + '%';
  $('#pl-pos').textContent = fmt(p * state.dur);
  engSend({ cmd: 'seek', seconds: p * state.dur });
});

/* ────────── 启动 ────────── */
/* ────────── 直链自愈：卡住就重取 ────────── */
/**
 * 网易云直链有有效期（expi 字段），播到一半可能失效，表现为：
 * 位置停止推进 / BASS 报 STALLED。这时自动重新取流并跳回原位。
 * 判据用「3 秒内位置没动」，比单看 active 更稳（缓冲也会短暂 stalled）。
 */
function checkStall(s) {
  if (!state.playing || !state.current || !state.current.id) return;
  if (!s.dur) return;

  const now = Date.now();
  const st = state.stallCheck;

  if (now - st.lastAt < 3000) return;   // 每 3 秒评估一次

  const moved = Math.abs((s.pos || 0) - st.lastPos) > 0.6;
  st.lastPos = s.pos || 0;
  st.lastAt = now;

  if (moved) {
    if (st.retried) console.log('[heal] 播放恢复，计数清零');
    st.retried = 0;
    return;
  }

  if (st.retried >= 3) {
    if (st.retried === 3) {
      console.warn('[heal] 连续 3 次重取无效，停止自愈');
      setStatus('播放中断：直链反复失效，请手动切歌');
      st.retried = 4;   // 只提示一次
    }
    return;
  }

  st.retried += 1;
  const at = s.pos || 0;
  console.warn(`[heal] 位置停在 ${at.toFixed(1)}s，第 ${st.retried} 次重取`);
  setStatus(`播放卡住，正在重取（第 ${st.retried} 次）…`);
  healCurrent(at);
}

async function healCurrent(atPos) {
  const t = state.current;
  if (!t || !t.id) return;
  try {
    const u = await api.songUrl(t.id, 'lossless');
    if (!u.url) { console.warn('[heal] 重取无直链'); return; }

    sendLoad({ source: u.url, trackId: t.id });

    // load 完成后跳回原位置（给引擎留出建流 + 启动时间）
    setTimeout(() => {
      engSend({ cmd: 'seek', seconds: atPos });
      console.log(`[heal] 已重取并跳回 ${atPos.toFixed(1)}s`);
    }, 1200);
  } catch (e) {
    console.warn('[heal] 重取失败:', e.message);
  }
}

/* ────────── 真无损体检（只标记，不拦） ────────── */
/**
 * FLAC 是无损压缩，码率反映的是「原始音频的信息量」。
 * CD 级（44.1k/16bit）真无损一般在 700~1100k；
 * 若明显偏低（<450k），很可能是低码率有损转成 FLAC 的假无损。
 * 注意：安静的古典/人声曲信息量天然偏低，判为 warn 不等于一定是假。
 */
function audioHealth(u) {
  if (!u.url) return { level: 'dead', text: '无源', kbps: 0 };
  const kbps = Math.round((u.br || 0) / 1000);

  if (!u.lossless) {
    return { level: 'lossy', text: kbps ? `${kbps}k` : '非无损', kbps };
  }
  if (kbps >= 700) return { level: 'ok', text: `无损 ${kbps}k`, kbps };
  if (kbps >= 450) return { level: 'warn', text: `无损 ${kbps}k 偏低`, kbps };
  return { level: 'suspect', text: `无损 ${kbps}k 疑似转码`, kbps };
}

/* ────────── 本地库管理 ────────── */
document.getElementById('lb-add')?.addEventListener('click', async () => {
  try {
    const r = await window.yw.libraryAdd();
    if (r && r.ok) {
      setStatus(`已添加 ${r.added.length} 个文件夹`);
      state.localSnapshot = null;    // 目录变了，快照作废
      showLocal(true);
    }
  } catch (e) {
    setStatus('添加失败：' + e.message);
  }
});

document.getElementById('local-pls')?.addEventListener('click', (e) => {
  const b = e.target.closest('.lp-i');
  if (!b) return;

  // 选中态
  document.querySelectorAll('#local-pls .lp-i').forEach((x) => x.classList.toggle('on', x === b));

  const all = state.localTracks || [];

  // 「全部」→ 回到整个音乐库
  if (b.dataset.pl === 'all') {
    const losslessN = all.filter((t) => /FLAC|WAV|APE|AIFF|DFF|DSF/i.test(t.codec)).length;
    renderList('list-body', all, `${all.length} 个文件 · ${losslessN} 个无损容器`, 'list-sub');
    console.log(`LOCAL_FILTER all ${all.length}`);
    return;
  }

  const pl = (state.localPlaylists || [])[Number(b.dataset.pl)];
  if (!pl) return;

  const want = new Set(pl.paths || []);
  const tracks = all.filter((t) => want.has(t.path));
  if (!tracks.length) {
    setStatus(`《${pl.name}》里的曲目都不在音乐库中`);
    b.classList.remove('on');
    document.querySelector('#local-pls .lp-i[data-pl="all"]')?.classList.add('on');
    return;
  }
  renderList('list-body', tracks, `${pl.name} · ${tracks.length} 首（列表共 ${pl.count}）`, 'list-sub');
  console.log(`LOCAL_PL ${pl.name} ${tracks.length}/${pl.count} 首可播`);
});

document.getElementById('lb-rescan')?.addEventListener('click', () => {
  setStatus('重新扫描中…');
  showLocal(true);
});

document.getElementById('lb-dirs')?.addEventListener('click', async (e) => {
  const b = e.target.closest('.d-x');
  if (!b || !b.dataset.dir) return;
  await window.yw.libraryRemove(b.dataset.dir);
  console.log('[lib] 已移除目录', b.dataset.dir);
  state.localSnapshot = null;
  showLocal(true);
});

/* 拖文件夹进窗口 → 加入音乐库 */
(() => {
  const hint = document.getElementById('drop-hint');
  let depth = 0;

  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');

  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    depth += 1;
    if (hint) hint.hidden = false;
  });

  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0 && hint) hint.hidden = true;
  });

  window.addEventListener('dragover', (e) => e.preventDefault());

  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    depth = 0;
    if (hint) hint.hidden = true;

    const paths = [...((e.dataTransfer && e.dataTransfer.files) || [])]
      .map((f) => (window.yw.pathForFile ? window.yw.pathForFile(f) : ''))
      .filter(Boolean);

    if (!paths.length) return;

    try {
      const r = await window.yw.libraryAddPath(paths);
      if (r && r.ok) {
        setStatus(`已加入 ${r.added.length} 个文件夹`);
        state.localSnapshot = null;
        showLocal(true);
      } else {
        setStatus('没有新增文件夹（拖文件夹，不是单个音频文件）');
      }
    } catch (err) {
      setStatus('加入失败：' + err.message);
    }
  });
})();

/* 侧栏歌单点击 */
document.getElementById('side-pls')?.addEventListener('click', (e) => {
  const b = e.target.closest('.side-pl');
  if (b && b.dataset.pl) showPlaylist(Number(b.dataset.pl));
});

/* ────────── 无边框窗口控制 ────────── */
const ICON_MAX = '<svg viewBox="0 0 10 10"><rect x="2.4" y="2.4" width="5.2" height="5.2" rx="1" fill="none" stroke="currentColor" stroke-width="1.1"/></svg>';
const ICON_RESTORE = '<svg viewBox="0 0 10 10"><rect x="1.9" y="3.5" width="4.2" height="4.2" rx=".9" fill="none" stroke="currentColor" stroke-width="1"/><path d="M3.5 3.5V2.3h4.2v4.2H6.5" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/></svg>';

document.querySelectorAll('.wc').forEach((btn) => {
  btn.addEventListener('click', () => {
    const action = btn.dataset.win;
    if (!window.yw || !window.yw.winControl) return;
    window.yw.winControl(action);
  });
});

if (window.yw && window.yw.onWinMaxed) {
  window.yw.onWinMaxed((maxed) => {
    const b = document.querySelector('.wc[data-win="max"]');
    if (!b) return;
    b.innerHTML = maxed ? ICON_RESTORE : ICON_MAX;
    b.setAttribute('aria-label', maxed ? '还原' : '最大化');
    b.setAttribute('title', maxed ? '还原' : '最大化');
  });
}

/* ────────── 扫码登录 ────────── */
let qrPolling = false;

async function openQrLogin() {
  const modal = $('#qr-modal');
  modal.hidden = false;
  $('#qr-img').innerHTML = '<div class="qr-ph">加载中…</div>';
  $('#qr-s').textContent = '正在获取二维码…';

  try {
    const key = await api.qrKey();
    if (!key) throw new Error('取不到二维码 key');
    const img = await api.qrCreate(key);
    if (!img) throw new Error('二维码生成失败');

    $('#qr-img').innerHTML = `<img src="${img}" alt="登录二维码">`;
    $('#qr-s').textContent = '请用网易云 App 扫码';
    pollQr(key);
  } catch (e) {
    $('#qr-s').textContent = '获取失败：' + e.message;
    console.warn('[login]', e.message);
  }
}

async function pollQr(key) {
  if (qrPolling) return;
  qrPolling = true;

  let tries = 0;
  try {
    while (tries++ < 150 && !$('#qr-modal').hidden) {
      await new Promise((r) => setTimeout(r, 2000));
      if ($('#qr-modal').hidden) break;

      let r;
      try {
        r = await api.qrCheck(key);
        if (r.code !== 801) console.log(`[login] qr check code=${r.code}`);
      } catch (e) {
        console.warn('[login] qr check 失败:', e.message);
        continue;
      }

      if (r.code === 800) { $('#qr-s').textContent = '二维码已过期，关掉重开'; break; }
      if (r.code === 802) { $('#qr-s').textContent = '已扫描，请在手机上确认'; continue; }
      if (r.code === 803) {
        if (!r.cookie || !/MUSIC_U=/.test(r.cookie)) {
          $('#qr-s').textContent = '登录成功但没拿到 cookie';
          break;
        }
        const saved = await window.yw.saveCookie(r.cookie);
        if (!saved || !saved.ok) {
          $('#qr-s').textContent = '保存失败：' + ((saved && saved.error) || '未知');
          break;
        }
        $('#qr-s').textContent = '登录成功';
        console.log(`[login] 扫码成功，cookie ${saved.length} 字节`);
        setTimeout(async () => {
          $('#qr-modal').hidden = true;
          await afterLogin();
        }, 700);
        break;
      }
      // 801 = 等待扫码
    }
  } finally {
    qrPolling = false;
  }
}

/** 登录后重建状态：cookie → 账号 → 喜欢列表 → 首页 */
async function afterLogin() {
  try {
    const cookie = await window.yw.getCookie();
    api.setCookie(cookie);

    // api.account() 内部已经取了 j.profile，这里拿到的就是 profile 本身，
    // 不要再写 acc.profile（那是 undefined，整块会被跳过）
    const acc = await api.account();
    if (!acc || !acc.userId) {
      console.warn('[login] 拿不到账号，cookie 可能无效');
      return;
    }

    state.loggedIn = true;
    state.uid = acc.userId;
    $('#user').textContent = acc.nickname || '已登录';
    $('#user').title = `uid ${acc.userId}`;

    try {
      const ids = await api.likelist(acc.userId);
      state.liked = new Set(ids);
      console.log(`[login] 喜欢列表 ${state.liked.size} 首`);
    } catch {}

    await Promise.all([loadHomeReal(), loadSidePlaylists(acc.userId)]);
    console.log(`LOGIN_OK nickname=${acc.nickname} uid=${acc.userId}`);
    setStatus(`已登录：${acc.nickname}`);
  } catch (e) {
    console.warn('[login] 刷新状态失败:', e.message);
  }
}

$('#user').addEventListener('click', () => {
  openQrLogin();
});
$('#qr-close').addEventListener('click', () => { $('#qr-modal').hidden = true; });
$('#qr-modal').addEventListener('click', (e) => {
  if (e.target.id === 'qr-modal') $('#qr-modal').hidden = true;
});

/* ────────── 托盘菜单命令 ────────── */
if (window.yw && window.yw.onTrayCmd) {
  window.yw.onTrayCmd((cmd) => {
    console.log('[tray] cmd =', cmd);
    if (cmd === 'toggle') togglePlay();
    else if (cmd === 'prev') advance(-1);
    else if (cmd === 'next') advance(1);
  });
}

/* ────────── 系统媒体控制（键盘媒体键 / 系统弹窗 / 蓝牙耳机） ────────── */
function setupMediaSession() {
  if (!('mediaSession' in navigator)) {
    console.warn('[media] 当前环境不支持 MediaSession');
    return;
  }
  const h = (action, fn) => {
    try { navigator.mediaSession.setActionHandler(action, fn); } catch {}
  };

  h('play', () => engSend({ cmd: 'resume' }));
  h('pause', () => engSend({ cmd: 'pause' }));
  h('previoustrack', () => advance(-1));
  h('nexttrack', () => advance(1));
  h('seekto', (d) => {
    if (d && typeof d.seekTime === 'number') engSend({ cmd: 'seek', seconds: d.seekTime });
  });
  console.log('[media] MediaSession 就绪');
}

function updateMediaSession(track) {
  if (!('mediaSession' in navigator) || !track) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.t || '',
      artist: track.a || '',
      album: track.al || '',
      artwork: track.cover
        ? [{ src: track.cover, sizes: '300x300', type: 'image/jpeg' }]
        : [],
    });
  } catch (e) { console.warn('[media] metadata', e.message); }
}

/* ────────── 开机画面 ────────── */
const SPLASH_START = Date.now();
const SPLASH_MIN = 1900;      // 最短显示，避免一闪而过
let splashGone = false;

function hideSplash() {
  if (splashGone) return;
  const el = $('#splash');
  if (!el) { splashGone = true; return; }
  const wait = Math.max(0, SPLASH_MIN - (Date.now() - SPLASH_START));
  setTimeout(() => {
    splashGone = true;
    el.classList.add('out');
    setTimeout(() => el.remove(), 700);
    console.log(`[splash] 关闭，显示 ${((Date.now() - SPLASH_START) / 1000).toFixed(1)}s`);
  }, wait);
}

// 兜底：无论成败，8 秒内一定放行
setTimeout(hideSplash, 8000);

async function boot() {
  setupMediaSession();
  renderHome();
  window.YW.logo.paint(document);
  connectEngine();
  console.log('BOOT 界面就绪, engine ws 连接中');

  // 恢复输出设备 / 播放模式
  if (IS_MAC) {
    // 老配置（Windows 侧写的 outMode:'asio' / outDevice:0）在 mac 上要迁移：
    //   'asio' → 'exclusive'；设备 0 → 'default'（BASS 里 0 是 No sound，会静音）
    const m = macMode(settings.outMode);
    const d = macDev(settings.outDevice);
    if (m !== settings.outMode || d !== settings.outDevice) {
      console.log(`[out] mac 迁移旧输出设置 ${settings.outMode}/${settings.outDevice} → ${m}/${d}`);
      outMode = m;
      outDevice = d;
      settings.outMode = m;
      settings.outDevice = d;
      settings.outLabel = m === 'shared' ? OUT_DEFAULT_LABEL : (settings.outLabel || '设备（独占）');
      saveSettings();
    } else {
      outMode = m;
      outDevice = d;
    }
    console.log(`[out] mac 恢复设置 mode=${outMode} dev=${outDevice}`);
  } else {
    outDevice = Number(settings.outDevice ?? 0);
    outMode = settings.outMode || 'asio';
  }
  updateModeUI();
  const os = $('#pl-output');
  if (os) os.textContent = (settings.outLabel || (IS_MAC ? OUT_DEFAULT_LABEL : 'ASIO 独占 · Donner')) + ' ▾';
  console.log(`SETTINGS_OK out=${outMode}/${outDevice} playMode=${settings.playMode}`);
  if (IS_MAC) requestDevices();   // 菜单在设备回来后重建（WS 已连上时立即生效）

  try {
    const cookie = (window.yw && window.yw.getCookie) ? await window.yw.getCookie() : '';
    if (cookie && /MUSIC_U=/.test(cookie)) {
      api.setCookie(cookie);
      const acc = await api.account();
      if (acc) {
        state.loggedIn = true;
        loadHomeReal();
        $('#user').textContent = acc.nickname || '已登录';
        state.uid = acc.userId;
        console.log(`BOOT_OK 登录态有效 nickname=${acc.nickname} uid=${acc.userId} vip=${acc.vipType}`);
        loadSidePlaylists(acc.userId);
        try {
          const ids = await api.likelist(acc.userId);
          state.liked = new Set(ids);
          console.log(`LIKE_SET ${ids.length} 首已喜欢`);
        } catch (e) { console.warn('[liked set]', e.message); }
      } else {
        $('#user').textContent = '登录失效';
      }
    } else {
      $('#user').textContent = '未登录';
    }
  } catch (e) {
    $('#user').textContent = '服务未启动';
    console.warn('[ui] account:', e.message);
  } finally {
    hideSplash();   // 不论登录成败，界面都该让用户看见
  }
}

boot();

// 启动后延迟预扫本地库：进本地页时直接有数据，不用每次等扫描
preloadLocalLibrary(1500);

if (location.hash === '#player') openPlayer();
