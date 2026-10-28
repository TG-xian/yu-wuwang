/**
 * B 站音源（主进程侧）
 * 只在主进程 / 纯 node 里跑：渲染层有 CSP 且 B 站接口要带 Referer，浏览器里发不了。
 * 不 require('electron') 到顶层 —— tools/bili-probe.js 直接用 node 跑这个文件。
 */
const fs = require('node:fs');
const path = require('node:path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const REFERER = 'https://www.bilibili.com';
const TIMEOUT_MS = 15000;
// 直链剩余不到 5 分钟就当过期：一首歌放完前链接不能先死
const DEADLINE_MARGIN = 300;

// 选档优先级：Hi-Res → 192K → 132K → 64K → 杜比（垫底）
// 30250 杜比是 E-AC-3，BASS 原生不支持、系统解码器也不保证有；
// 排在标准档之后，否则大会员账号遇到带杜比音轨的视频反而播不出来。
const QUALITY_ORDER = [30251, 30280, 30232, 30216, 30250];
const QUALITY_LABEL = {
  30251: 'Hi-Res 无损',
  30250: '杜比全景声',
  30280: '192K',
  30232: '132K',
  30216: '64K',
};

function biliError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/* ────────── Electron 侧能力（不在 Electron 里就是 null） ────────── */

function electron() {
  try {
    const e = require('electron');
    // 纯 node 下 require('electron') 拿到的是可执行文件路径字符串，不是模块
    return e && typeof e === 'object' && e.app ? e : null;
  } catch {
    return null;
  }
}

/* ────────── 网络 ────────── */

/** cookie 值保持 URL 编码形态：SESSDATA 里有逗号，解码后放进 Cookie 头 B 站不认 */
function cookieValue(v) {
  const s = String(v || '').trim();
  return /%[0-9a-f]{2}/i.test(s) ? s : encodeURIComponent(s);
}

function cookieHeader(pairs) {
  return Object.entries(pairs)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${cookieValue(v)}`)
    .join('; ');
}

async function request(url, { cookies = {}, raw = false } = {}) {
  const headers = { Referer: REFERER, 'User-Agent': UA, Accept: 'application/json, text/plain, */*' };
  const ck = cookieHeader(cookies);
  if (ck) headers.Cookie = ck;

  let res;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    if (e.name === 'TimeoutError') throw biliError('TIMEOUT', `B 站请求超时（${TIMEOUT_MS / 1000}s）`);
    throw biliError('NET', `B 站连不上：${e.cause ? e.cause.code || e.cause.message : e.message}`);
  }
  if (!res.ok) throw biliError(`HTTP_${res.status}`, `B 站返回 HTTP ${res.status}`);

  let json;
  try { json = await res.json(); } catch { throw biliError('BAD_JSON', 'B 站返回的不是 JSON'); }
  if (raw) return { json, res };
  if (json.code !== 0) throw biliError(json.code, `B 站接口 code=${json.code}${json.message ? ' · ' + json.message : ''}`);
  return json.data;
}

/* ────────── buvid3 ────────── */

let buvidCache = '';
let buvid4Cache = '';
let buvidPending = null;
// b_nut 是首次访问时间戳，进程内固定一个即可
const B_NUT = Math.floor(Date.now() / 1000);

/** 不带 buvid3 时部分接口偶发 -352 风控；同一进程复用一个即可 */
async function getBuvid() {
  if (buvidCache) return buvidCache;
  if (!buvidPending) {
    buvidPending = request('https://api.bilibili.com/x/frontend/finger/spi')
      .then((d) => {
        buvidCache = (d && d.b_3) || '';
        buvid4Cache = (d && d.b_4) || '';
        return buvidCache;
      })
      .finally(() => { buvidPending = null; });
  }
  return buvidPending;
}

/** buvid 拿不到也继续：它只是让接口更稳，不是必需 */
async function baseCookies(sessdata) {
  let buvid3 = '';
  try { buvid3 = await getBuvid(); } catch {}
  return { buvid3, SESSDATA: sessdata || '' };
}

/* ────────── 输入解析 ────────── */

const BV_RE = /BV1[0-9A-Za-z]{9}/;

function parseInput(text) {
  const m = String(text || '').match(BV_RE);
  return m ? m[0] : null;
}

/** 链接里的 ?p=N（分 P），没有就是 1 */
function parsePage(text) {
  const m = String(text || '').match(/[?&]p=(\d+)/);
  return m ? Math.max(1, Number(m[1])) : 1;
}

function httpsCover(u) {
  return String(u || '').replace(/^http:\/\//, 'https://');
}

/* ────────── 内容 ────────── */

async function getInfo(bvid) {
  if (!BV_RE.test(String(bvid || ''))) throw biliError('BAD_BVID', `不是有效的 BV 号：${bvid}`);
  const d = await request(
    `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
    { cookies: await baseCookies() }
  );
  return {
    bvid: d.bvid || bvid,
    title: d.title || '',
    cover: httpsCover(d.pic),
    artist: (d.owner && d.owner.name) || '',
    mid: Number(d.owner && d.owner.mid) || 0,
    face: fullUrl(d.owner && d.owner.face),
    seasonId: Number(d.ugc_season && d.ugc_season.id) || 0,
    duration: Number(d.duration) || 0,
    cid: d.cid,
    pages: (d.pages || []).map((p) => ({
      cid: p.cid, page: p.page, part: p.part || '', duration: Number(p.duration) || 0,
    })),
  };
}

async function ranking() {
  const d = await request(
    'https://api.bilibili.com/x/web-interface/ranking/v2?rid=3&type=all',
    { cookies: await baseCookies() }
  );
  return (d.list || []).slice(0, 30).map((v) => ({
    bvid: v.bvid,
    title: v.title || '',
    cover: httpsCover(v.pic),
    artist: (v.owner && v.owner.name) || '',
    mid: Number(v.owner && v.owner.mid) || 0,
    face: fullUrl(v.owner && v.owner.face),
    seasonId: Number(v.season_id || (v.ugc_season && v.ugc_season.id)) || 0,
    duration: Number(v.duration) || 0,
    cid: v.cid || 0,   // 榜单自带 cid，播放时可省一次 view
  }));
}

/**
 * 音乐区推荐（免签名、免登录）。每次调用给的是新一批。
 * 实测返回 data.archives[]：UP 主在 author.name（不是榜单的 owner），duration 是秒，自带 cid。
 */
async function recommendRegion({ count = 15 } = {}) {
  const d = await request(
    'https://api.bilibili.com/x/web-interface/region/feed/rcmd'
      + `?display_id=1&request_cnt=${Number(count) || 15}&from_region=1003&device=web&plat=30`,
    { cookies: await baseCookies() }
  );
  return (d.archives || []).filter((v) => v.bvid).map((v) => ({
    bvid: v.bvid,
    title: v.title || '',
    cover: httpsCover(v.cover),
    artist: (v.author && v.author.name) || '',
    mid: Number(v.author && v.author.mid) || 0,
    face: fullUrl(v.author && v.author.face),
    seasonId: Number(v.season_id || (v.ugc_season && v.ugc_season.id)) || 0,
    duration: Number(v.duration) || 0,
    cid: v.cid || 0,
  }));
}

/* ────────── WBI 签名 ──────────
   规范：https://socialsisteryi.github.io/bilibili-API-collect/docs/misc/sign/wbi.html
   （原仓库已清空，核对用的是 Wayback 存档 web.archive.org/web/20251124213947/ 同一地址） */

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
];
// 口令每日更替，6 小时内复用
const WBI_TTL_MS = 6 * 3600 * 1000;

let wbiCache = null;     // { img, sub, at }
let wbiPending = null;

function keyFromUrl(u) {
  const name = String(u || '').split('/').pop() || '';
  return name.split('.')[0];
}

/** nav 未登录时 code=-101，但 wbi_img 照样给，所以走 raw 不看 code */
async function getWbiKeys() {
  if (wbiCache && Date.now() - wbiCache.at < WBI_TTL_MS) return wbiCache;
  if (!wbiPending) {
    wbiPending = (async () => {
      const { json } = await request('https://api.bilibili.com/x/web-interface/nav',
        { cookies: await baseCookies(), raw: true });
      const w = (json && json.data && json.data.wbi_img) || {};
      const img = keyFromUrl(w.img_url);
      const sub = keyFromUrl(w.sub_url);
      if (!img || !sub) throw biliError('NO_WBI_KEY', `取 WBI 口令失败 code=${json && json.code}`);
      wbiCache = { img, sub, at: Date.now() };
      return wbiCache;
    })().finally(() => { wbiPending = null; });
  }
  return wbiPending;
}

function invalidateWbi() {
  wbiCache = null;
}

/** 纯函数，便于对照规范里的示例验算；返回签好的 query string */
function wbiSign(params, imgKey, subKey, wts = Math.floor(Date.now() / 1000)) {
  const raw = imgKey + subKey;
  const mixinKey = MIXIN_KEY_ENC_TAB.map((i) => raw[i]).join('').slice(0, 32);
  const all = { ...params, wts };
  const query = Object.keys(all).sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(all[k]).replace(/[!'()*]/g, ''))}`)
    .join('&');
  const wRid = require('node:crypto').createHash('md5').update(query + mixinKey).digest('hex');
  return `${query}&w_rid=${wRid}`;
}

// 风控：-352 / -412 / HTTP 412；签名或 cookie 不过关时还会 code=0 但只回 v_voucher
const RISK_CODES = new Set([-352, -412, 'HTTP_412', 'V_VOUCHER']);

/** 实测搜索只带 buvid3 必回 v_voucher，要 buvid3 + buvid4 + b_nut 三件套 */
async function wbiCookies() {
  const c = await baseCookies();
  return { ...c, buvid4: buvid4Cache, b_nut: c.buvid3 ? B_NUT : '' };
}

async function wbiRequest(base, params) {
  const once = async () => {
    const k = await getWbiKeys();
    const d = await request(`${base}?${wbiSign(params, k.img, k.sub)}`, { cookies: await wbiCookies() });
    if (d && ((d.v_voucher && !d.result) || d.is_risk || d.gaia_res_type)) {
      throw biliError('V_VOUCHER', 'B 站风控拦截（v_voucher / gaia）');
    }
    return d;
  };
  try {
    return await once();
  } catch (e) {
    if (!RISK_CODES.has(e.code)) throw e;
    // 口令可能过期、指纹可能被标记：都清掉重取重签，只重试一次
    invalidateWbi();
    buvidCache = '';
    buvid4Cache = '';
    return once();
  }
}

/* ────────── 搜索 ────────── */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' };

/** 剥掉 <em class="keyword"> 高亮，顺带还原常见实体 */
function plainText(s) {
  return String(s || '')
    .replace(/<\/?em[^>]*>/gi, '')
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_, n) => ENTITIES[n]);
}

function fullUrl(u) {
  const s = String(u || '');
  return s.startsWith('//') ? `https:${s}` : httpsCover(s);
}

/** "mm:ss" 或 "h:mm:ss" → 秒 */
function parseDuration(s) {
  return String(s || '').split(':').reduce((acc, x) => acc * 60 + (Number(x) || 0), 0);
}

const SEARCH_URL = 'https://api.bilibili.com/x/web-interface/wbi/search/type';

function checkKeyword(keyword) {
  const kw = String(keyword || '').trim();
  if (!kw) throw biliError('EMPTY_KEYWORD', '搜索关键词为空');
  return kw;
}

async function searchVideo(keyword, { page = 1 } = {}) {
  const d = await wbiRequest(SEARCH_URL, { search_type: 'video', keyword: checkKeyword(keyword), page });
  return (d.result || []).filter((v) => v.bvid).map((v) => ({
    bvid: v.bvid,
    title: plainText(v.title),
    cover: fullUrl(v.pic),
    artist: v.author || '',
    mid: Number(v.mid) || 0,
    seasonId: Number(v.season_id) || 0,
    duration: parseDuration(v.duration),
    play: Number(v.play) || 0,
    danmaku: Number(v.video_review ?? v.danmaku) || 0,
  }));
}

async function searchUser(keyword, { page = 1 } = {}) {
  const d = await wbiRequest(SEARCH_URL, { search_type: 'bili_user', keyword: checkKeyword(keyword), page });
  return (d.result || []).filter((u) => u.mid).map((u) => ({
    mid: u.mid,
    name: plainText(u.uname),
    face: fullUrl(u.upic),
    sign: u.usign || '',
    videos: Number(u.videos) || 0,
    fans: Number(u.fans) || 0,
  }));
}

/* ────────── UP 主与合集 ────────── */

function positiveId(value, name) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw biliError('BAD_ID', `${name} 无效`);
  return n;
}

// B 站的 space 系列风控是概率性的：同一请求往往重试几次就过。
// 实测用户手点「刷新多次才有」就是这个现象，所以这里做退避重试而不是一次就放弃。
// 实测：5 次挤在 2.5 秒内全被拒，而手动点重试（间隔几秒）能过 →
// 间隔必须跨过风控的惩罚窗口，取 1.5/4/6.5 秒，累计约 12 秒。
const RISK_RETRY = 4;
function isRiskError(e) {
  const s = String((e && (e.code || e.message)) || '');
  return /-352|412|V_VOUCHER|v_voucher|风控|risk/i.test(s);
}
async function withRiskRetry(fn) {
  let last;
  for (let i = 0; i < RISK_RETRY; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      if (!isRiskError(e) || i === RISK_RETRY - 1) throw e;
      // 退避 1.5/4/6.5s + 抖动：间隔太近会一直落在风控惩罚窗口内
      await new Promise((r) => setTimeout(r, 1500 + i * 2500 + Math.random() * 600));
    }
  }
  throw last;
}

async function userVideos(mid, { page = 1, ps = 30 } = {}) {
  const d = await withRiskRetry(() => wbiRequest('https://api.bilibili.com/x/space/wbi/arc/search', {
    mid: positiveId(mid, 'UP 主 ID'), pn: positiveId(page, '页码'),
    ps: Math.min(50, positiveId(ps, '每页数量')), order: 'pubdate', platform: 'web',
  }));
  if (d.is_risk || d.gaia_res_type) throw biliError('V_VOUCHER', 'B 站投稿列表被风控拦截');
  // 保留接口的分页顺序，音乐投稿优先展示；不漏掉其他分区。
  return ((d.list && d.list.vlist) || []).filter((v) => v.bvid)
    .map((v) => ({
      bvid: v.bvid, title: plainText(v.title), cover: fullUrl(v.pic),
      artist: v.author || '', mid: Number(v.mid) || Number(mid),
      duration: parseDuration(v.length), created: Number(v.created) || 0,
      tid: Number(v.typeid) || 0, seasonId: Number(v.season_id) || 0,
    })).sort((a, b) => Number(b.tid === 3) - Number(a.tid === 3));
}

async function userProfile(mid) {
  mid = positiveId(mid, 'UP 主 ID');
  const d = await withRiskRetry(() => wbiRequest('https://api.bilibili.com/x/space/wbi/acc/info', { mid }));
  // acc/info 不含粉丝数，需单独取关系统计；失败不影响头像与名字。
  const stat = await request(`https://api.bilibili.com/x/relation/stat?vmid=${mid}`,
    { cookies: await baseCookies() }).catch(() => null);
  return { mid, name: plainText(d.name), face: fullUrl(d.face),
    fans: stat ? Number(stat.follower) || 0 : null };
}

// 该接口为可选能力，暂不额外请求风控较重的合集目录。
async function userSeasons() { return []; }

// 同一视频的合集信息供行内标签与合集页共用，避免重复查询。
const seasonCache = new Map();
async function seasonInfo(bvid) {
  if (!BV_RE.test(String(bvid || ''))) throw biliError('BAD_BVID', '不是有效的 BV 号');
  if (seasonCache.has(bvid)) return seasonCache.get(bvid);
  const job = (async () => {
    const d = await request(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
      { cookies: await baseCookies() });
    const s = d.ugc_season;
    if (!s) return null;
    const seen = new Set();
    const episodes = (s.sections || []).flatMap((section) => section.episodes || [])
      .filter((e) => e.bvid && !seen.has(e.bvid) && seen.add(e.bvid))
      .map((e) => ({
        bvid: e.bvid, title: plainText(e.title || (e.arc && e.arc.title)),
        cover: fullUrl(e.arc && e.arc.pic), duration: Number(e.arc && e.arc.duration) || 0,
        cid: Number(e.cid) || 0, mid: Number(s.mid) || 0,
        artist: (e.arc && e.arc.author && e.arc.author.name) || (d.owner && d.owner.name) || '',
        seasonId: Number(s.id),
      }));
    return { seasonId: Number(s.id), title: plainText(s.title), cover: fullUrl(s.cover),
      mid: Number(s.mid) || 0, episodes };
  })();
  seasonCache.set(bvid, job);
  if (seasonCache.size > 300) seasonCache.delete(seasonCache.keys().next().value);
  try { return await job; } catch (e) { seasonCache.delete(bvid); throw e; }
}

/* ────────── 取流 ────────── */

/** flac / dolby 的内层结构不固定：可能是对象、数组，字段叫 audio 或 dash */
function collectStreams(node, into) {
  if (!node) return;
  if (Array.isArray(node)) { node.forEach((x) => collectStreams(x, into)); return; }
  if (typeof node !== 'object') return;
  if (node.id && (node.baseUrl || node.base_url)) { into.push(node); return; }
  collectStreams(node.audio, into);
  collectStreams(node.dash, into);
}

function deadlineOf(url) {
  try { return Number(new URL(url).searchParams.get('deadline')) || 0; } catch { return 0; }
}

// 同一 bvid+cid+登录态 在直链有效期内复用，切回上一首不必重取
const playUrlCache = new Map();

async function getPlayUrl(bvid, { sessdata = '', cid = 0, page = 1, force = false } = {}) {
  if (!cid) {
    const info = await getInfo(bvid);
    const p = info.pages.find((x) => x.page === page);
    cid = (p && p.cid) || info.cid;
  }
  const cacheKey = `${bvid}:${cid}:${sessdata ? 1 : 0}`;
  const now = Math.floor(Date.now() / 1000);
  const hit = playUrlCache.get(cacheKey);
  // force：播放卡住时调用，说明这条链接虽没到 deadline 但已经不能用了
  if (hit && !force && hit.deadline - now >= DEADLINE_MARGIN) return hit;

  const d = await request(
    `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(bvid)}&cid=${cid}&fnval=4048&fnver=0&fourk=1`,
    { cookies: await baseCookies(sessdata) }
  );
  const dash = d && d.dash;
  if (!dash) throw biliError('NO_DASH', '这个视频没有 dash 音频流（可能是老视频或需要付费）');

  // 数组顺序不保证，统一按 id 建索引再按优先级挑
  const streams = [];
  collectStreams(dash.audio, streams);
  collectStreams(dash.flac, streams);
  collectStreams(dash.dolby, streams);
  if (!streams.length) throw biliError('NO_AUDIO', '这个视频没有可用的音频流');

  const byId = new Map(streams.map((s) => [Number(s.id), s]));
  let pick = null;
  for (const id of QUALITY_ORDER) {
    if (byId.has(id)) { pick = byId.get(id); break; }
  }
  // 未知档位：退回带宽最高的那条，总比放不出来强
  if (!pick) pick = streams.slice().sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0];

  const url = pick.baseUrl || pick.base_url;
  const out = {
    url,
    headers: { Referer: REFERER, 'User-Agent': UA },
    qualityId: Number(pick.id),
    qualityLabel: QUALITY_LABEL[pick.id] || `${Math.round((pick.bandwidth || 0) / 1000)}K`,
    codecs: pick.codecs || '',
    bandwidth: pick.bandwidth || 0,
    deadline: deadlineOf(url) || now + 3600,
    backups: pick.backupUrl || pick.backup_url || [],
    cid,
    available: [...byId.keys()].sort((a, b) => a - b),
  };
  playUrlCache.set(cacheKey, out);
  return out;
}

/** 引擎零改动：请求头拼进 URL 后面，BASS 会当成附加 HTTP 头发出去 */
function toEngineSource(play) {
  const h = play.headers || {};
  return `${play.url}\r\nReferer: ${h.Referer || REFERER}\r\nUser-Agent: ${h['User-Agent'] || UA}\r\n`;
}

/* ────────── 下载到本地缓存 ──────────
   BASS_StreamCreateURL 对 B 站的 fMP4 音频流不可靠（约四成视频 err=41 FILEFORM），
   同样的数据落成本地文件走 StreamCreateFile 全部能开。所以先下完再交给引擎。 */

// 下载时多久没收到新数据就算断了；不限总时长，长音频慢网也能下完
const DOWNLOAD_IDLE_MS = 20000;

function cacheDir() {
  const e = electron();
  const dir = e
    ? path.join(e.app.getPath('userData'), 'bili-cache')
    : path.join(require('node:os').tmpdir(), 'yu-wuwang-bili-cache');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 写到 .part，成功后才 rename：半截文件永远不会被当成完整缓存 */
async function fetchToFile(url, dest, onProgress) {
  const ctl = new AbortController();
  let timer = setTimeout(() => ctl.abort(), DOWNLOAD_IDLE_MS);
  const kick = () => { clearTimeout(timer); timer = setTimeout(() => ctl.abort(), DOWNLOAD_IDLE_MS); };
  const part = `${dest}.part`;
  let fh = null;
  try {
    const res = await fetch(url, { headers: { Referer: REFERER, 'User-Agent': UA }, signal: ctl.signal });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || 0;
    fh = await fs.promises.open(part, 'w');
    let received = 0;
    for await (const chunk of res.body) {
      kick();
      await fh.write(chunk);
      received += chunk.length;
      if (onProgress) { try { onProgress(received, total); } catch {} }
    }
    await fh.close();
    fh = null;
    if (!received) throw new Error('下载到 0 字节');
    if (total && received !== total) throw new Error(`只下到 ${received}/${total} 字节`);
    await fs.promises.rename(part, dest);
    return received;
  } catch (e) {
    if (fh) await fh.close().catch(() => {});
    await fs.promises.unlink(part).catch(() => {});
    throw e.name === 'AbortError' ? new Error(`${DOWNLOAD_IDLE_MS / 1000}s 没收到数据`) : e;
  } finally {
    clearTimeout(timer);
  }
}

// 同一个文件同时只下一份：连点两次播放 / 预取和播放撞上时共用一次下载
const downloading = new Map();

/** 返回 { path, qualityId, qualityLabel, bytes, fromCache, cid } */
async function downloadAudio(bvid, { sessdata = '', cid = 0, page = 1, force = false, onProgress } = {}) {
  const play = await getPlayUrl(bvid, { sessdata, cid, page, force });
  const name = `${bvid}_${play.cid}_q${play.qualityId}.m4a`;
  const dest = path.join(cacheDir(), name);
  const base = { path: dest, qualityId: play.qualityId, qualityLabel: play.qualityLabel, cid: play.cid };

  if (!force) {
    try {
      const st = fs.statSync(dest);
      if (st.size > 0) {
        // 刷新 mtime：pruneCache 按 mtime 淘汰，常听的不会先被删
        const now = new Date();
        try { fs.utimesSync(dest, now, now); } catch {}
        return { ...base, bytes: st.size, fromCache: true };
      }
    } catch {}
  }

  if (downloading.has(dest)) return downloading.get(dest);
  const job = (async () => {
    const errs = [];
    // 主链挂了依次试备用 host
    for (const url of [play.url, ...(play.backups || [])]) {
      try {
        const bytes = await fetchToFile(url, dest, onProgress);
        return { ...base, bytes, fromCache: false };
      } catch (e) {
        errs.push(`${new URL(url).host}: ${e.cause ? e.cause.code || e.cause.message : e.message}`);
      }
    }
    throw biliError('DOWNLOAD_FAILED', `B 站音频下载失败（${errs.join('；')}）`);
  })().finally(() => downloading.delete(dest));
  downloading.set(dest, job);
  return job;
}

/** 先删超龄的，再按总大小从最旧的删；残留 .part 超过 10 分钟一并清掉 */
function pruneCache({ maxBytes = 800 * 1024 * 1024, maxAgeDays = 7 } = {}) {
  let dir;
  try { dir = cacheDir(); } catch { return { removed: 0, kept: 0, bytes: 0 }; }
  const now = Date.now();
  const files = [];
  for (const n of fs.readdirSync(dir)) {
    const p = path.join(dir, n);
    try {
      const st = fs.statSync(p);
      if (st.isFile()) files.push({ p, part: n.endsWith('.part'), size: st.size, mtime: st.mtimeMs });
    } catch {}
  }

  let removed = 0;
  const rm = (f) => { try { fs.unlinkSync(f.p); removed++; return true; } catch { return false; } };
  const maxAge = maxAgeDays * 86400 * 1000;
  const keep = [];
  for (const f of files) {
    const stale = f.part ? now - f.mtime > 10 * 60 * 1000 : now - f.mtime > maxAge;
    if (!(stale && rm(f))) keep.push(f);
  }

  keep.sort((a, b) => a.mtime - b.mtime);
  let bytes = keep.reduce((s, f) => s + f.size, 0);
  while (bytes > maxBytes && keep.length) {
    const f = keep.shift();
    if (rm(f)) bytes -= f.size;
  }
  return { removed, kept: keep.length, bytes };
}

/* ────────── 二维码登录 ────────── */

async function qrGenerate() {
  const d = await request('https://passport.bilibili.com/x/passport-login/web/qrcode/generate');
  let qrDataUrl = '';
  try {
    qrDataUrl = await require('qrcode').toDataURL(d.url, { margin: 1, width: 240 });
  } catch (e) {
    throw biliError('QR_RENDER', `二维码图生成失败：${e.message}`);
  }
  return { url: d.url, key: d.qrcode_key, qrDataUrl };
}

/** 从登录成功的跳转 URL 里拆 cookie；不解码，保持 B 站下发的原始形态 */
function cookiesFromUrl(u) {
  const out = {};
  const q = String(u || '').split('?')[1] || '';
  for (const kv of q.split('&')) {
    const i = kv.indexOf('=');
    if (i > 0) out[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return out;
}

function cookiesFromSetCookie(res) {
  const out = {};
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const line of list) {
    const first = line.split(';')[0];
    const i = first.indexOf('=');
    if (i > 0) out[first.slice(0, i).trim()] = first.slice(i + 1).trim();
  }
  return out;
}

/**
 * 返回 { status, message, cookie? }
 * status：waiting 未扫 / scanned 已扫待确认 / expired 过期 / ok 成功
 */
async function qrPoll(key) {
  const { json, res } = await request(
    `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(key)}`,
    { raw: true }
  );
  if (json.code !== 0) throw biliError(json.code, `扫码轮询失败 code=${json.code}`);
  const d = json.data || {};
  const map = { 86101: 'waiting', 86090: 'scanned', 86038: 'expired', 0: 'ok' };
  const status = map[d.code] || 'unknown';
  if (status !== 'ok') return { status, message: d.message || '', code: d.code };

  const cookie = { ...cookiesFromUrl(d.url), ...cookiesFromSetCookie(res) };
  if (!cookie.SESSDATA) throw biliError('NO_SESSDATA', '登录成功但没拿到 SESSDATA');
  return {
    status,
    message: '',
    code: 0,
    cookie: {
      SESSDATA: cookie.SESSDATA,
      bili_jct: cookie.bili_jct || '',
      DedeUserID: cookie.DedeUserID || '',
    },
  };
}

/** 登录态 + 大会员；SESSDATA 失效时 isLogin=false，不抛错 */
async function nav(sessdata) {
  const d = await request('https://api.bilibili.com/x/web-interface/nav', { cookies: await baseCookies(sessdata) })
    .catch((e) => {
      // 未登录时 nav 返回 code=-101，属于正常结果
      if (e.code === -101) return { isLogin: false };
      throw e;
    });
  return {
    isLogin: !!d.isLogin,
    uname: d.uname || '',
    vip: !!(d.vipStatus === 1 && d.vipType > 0),
    vipType: d.vipType || 0,
  };
}

/* ────────── 登录态持久化（仅主进程） ────────── */

let sessionMem = null;   // 加密不可用时只留在内存，本次运行有效

function sessionPath() {
  const e = electron();
  if (!e) return null;
  return path.join(e.app.getPath('userData'), 'bili-session.bin');
}

/** 必须在 app ready 之后调：safeStorage 在 ready 前（尤其 Linux）一律报不可用 */
function saveSession(cookieObj) {
  const sess = {
    SESSDATA: String((cookieObj && cookieObj.SESSDATA) || '').trim(),
    bili_jct: (cookieObj && cookieObj.bili_jct) || '',
    DedeUserID: (cookieObj && cookieObj.DedeUserID) || '',
    savedAt: Date.now(),
  };
  if (!sess.SESSDATA) return { ok: false, persisted: false, error: 'SESSDATA 为空' };
  sessionMem = sess;
  playUrlCache.clear();   // 换了账号，旧缓存的档位不再准

  const e = electron();
  if (!e) return { ok: true, persisted: false, error: '不在 Electron 里运行，登录态只保存在内存' };
  if (!e.safeStorage.isEncryptionAvailable()) {
    return { ok: true, persisted: false, error: '系统加密不可用，登录态不落盘，仅本次运行有效' };
  }
  try {
    fs.writeFileSync(sessionPath(), e.safeStorage.encryptString(JSON.stringify(sess)));
    return { ok: true, persisted: true };
  } catch (err) {
    return { ok: true, persisted: false, error: `写盘失败：${err.message}` };
  }
}

function loadSession() {
  if (sessionMem) return sessionMem;
  const e = electron();
  if (!e) return null;
  const p = sessionPath();
  if (!fs.existsSync(p)) return null;
  if (!e.safeStorage.isEncryptionAvailable()) return null;
  try {
    sessionMem = JSON.parse(e.safeStorage.decryptString(fs.readFileSync(p)));
    return sessionMem;
  } catch {
    return null;   // 换机器 / 换系统账号后解不开，当未登录
  }
}

function clearSession() {
  sessionMem = null;
  playUrlCache.clear();   // 缓存里可能是登录后才有的 Hi-Res 链接
  const p = sessionPath();
  if (p) { try { fs.unlinkSync(p); } catch {} }
  return { ok: true };
}

module.exports = {
  UA, REFERER, QUALITY_LABEL, DEADLINE_MARGIN,
  getBuvid, parseInput, parsePage, getInfo, getPlayUrl, toEngineSource, downloadAudio, pruneCache, ranking, recommendRegion,
  getWbiKeys, invalidateWbi, wbiSign, searchVideo, searchUser,
  userVideos, userProfile, userSeasons, seasonInfo,
  qrGenerate, qrPoll, nav,
  saveSession, loadSession, clearSession,
};
