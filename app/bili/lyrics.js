/**
 * B 站音源歌词匹配（主进程侧）
 * 网易云（本机 3000 取流服务）+ LRCLIB 两个源并行搜，按「时长 + 标题 + 歌手」打分选一首，取它的歌词。
 * 和 api.js 一样不 require('electron') 到顶层：tools/bili-probe.js 用纯 node 跑。
 */
const fs = require('node:fs');
const path = require('node:path');

const NE_BASE = `http://127.0.0.1:${Number(process.env.YW_API_PORT || 3000)}`;
const LRCLIB_BASE = 'https://lrclib.net/api';
const LRCLIB_UA = 'yu-wuwang (https://github.com/TG-xian)';
const TIMEOUT_MS = 8000;
const FAIL_COOLDOWN_MS = 3 * 60 * 1000;
const PER_SOURCE = 10;

// 打分阈值
const MAX_DUR_DIFF = 10;      // 超过 10 秒开始打折（B 站视频普遍带片头片尾）
const HARD_DUR_DIFF = 20;     // 超过 20 秒直接淘汰
const MIN_TITLE = 30;         // 标题分低于它总分扣 35：防「只是时长巧合撞上」
const LOW_TITLE_PENALTY = 35;
const ACCEPT = 55;            // 总分低于它不接受

/* ────────── 存储 ────────── */

function electron() {
  try {
    const e = require('electron');
    return e && typeof e === 'object' && e.app ? e : null;
  } catch {
    return null;
  }
}

function cacheDir() {
  const e = electron();
  const dir = e
    ? path.join(e.app.getPath('userData'), 'bili-lyrics')
    : path.join(require('node:os').tmpdir(), 'yu-wuwang-bili-lyrics');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 多 P 视频每一 P 是不同的歌，P2 起单独存 */
function cacheKey(bvid, page) {
  const safe = String(bvid || '').replace(/[^0-9A-Za-z]/g, '');
  return page > 1 ? `${safe}_p${page}` : safe;
}

function readCache(key) {
  try { return JSON.parse(fs.readFileSync(path.join(cacheDir(), `${key}.json`), 'utf8')); } catch { return null; }
}

function writeCache(key, value) {
  try {
    fs.writeFileSync(path.join(cacheDir(), `${key}.json`), JSON.stringify(value), 'utf8');
  } catch (e) {
    console.warn('[bili-lyrics] 写缓存失败:', e.message);
  }
}

// 失败冷却：key → 失败时刻。只在内存里，重启应用就清
const failedAt = new Map();

/* ────────── 网络 ────────── */

async function getJson(url, headers = {}) {
  let res;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    throw new Error(e.name === 'TimeoutError' ? `超时（${TIMEOUT_MS / 1000}s）` : (e.cause && e.cause.code) || e.message);
  }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/** 网易云取流服务：缓存键只看 URL，带个时间戳免得拿到旧结果 */
function neGet(p, params) {
  const q = new URLSearchParams({ ...params, timestamp: String(Date.now()) });
  return getJson(`${NE_BASE}${p}?${q}`).then((j) => {
    if (j && j.code && j.code !== 200) throw new Error(`网易云接口 code=${j.code}`);
    return j;
  });
}

/** LRCLIB 高峰期偶发 503（ServerOverloaded），隔一会儿重试一次 */
async function lrclibSearch(q) {
  const url = `${LRCLIB_BASE}/search?q=${encodeURIComponent(q)}`;
  // 它高峰期很爱回 503，三次退避重试；周杰伦这类网易云无版权的歌全靠这个源
  const backoff = [600, 1500, 3000];
  let lastErr;
  for (let i = 0; i <= backoff.length; i++) {
    try {
      return await getJson(url, { 'User-Agent': LRCLIB_UA });
    } catch (e) {
      lastErr = e;
      if (e.status !== 503 && e.status !== 429) throw e;
      if (i < backoff.length) await new Promise((r) => setTimeout(r, backoff[i]));
    }
  }
  throw lastErr;
}

/* ────────── 文本处理 ────────── */

/** 比较前的归一：全角转半角、小写、去标点空白（只用于打分，不改关键词） */
function norm(s) {
  return String(s || '')
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

/** 字符 2-gram 的多重集合；单字符串退化成它自己 */
function bigrams(s) {
  const m = new Map();
  if (s.length === 1) { m.set(s, 1); return m; }
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    m.set(g, (m.get(g) || 0) + 1);
  }
  return m;
}

/** Dice 系数 = 2|A∩B| / (|A|+|B|)，返回 0~100 */
function dice(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 100;
  const ga = bigrams(x);
  const gb = bigrams(y);
  let inter = 0;
  let na = 0;
  let nb = 0;
  for (const v of ga.values()) na += v;
  for (const v of gb.values()) nb += v;
  for (const [g, v] of ga) inter += Math.min(v, gb.get(g) || 0);
  return (200 * inter) / (na + nb);
}

/** 去掉括号里的附注：「起风了 (Live)」「起风了（翻自 xx）」 → 「起风了」 */
function stripNotes(s) {
  return String(s || '')
    .replace(/[(（[【〔][^)）\]】〕]*[)）\]】〕]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 从 B 站标题里拆出「可能的歌名」和「可能的歌手」，只用来打分。
 * 常见形态：【无损音质】《起风了》-买辣椒也用券、周杰伦 - 晴天、晴天 / 周杰伦（Live）
 */
function parseBiliTitle(title) {
  const t = String(title || '');
  const names = [];
  const artists = [];

  // 书名号 / 直角引号里的通常就是歌名
  const bookNames = [];
  for (const m of t.matchAll(/[《「『]([^》」』]{1,40})[》」』]/g)) bookNames.push(m[1].trim());
  bookNames.forEach((n) => names.push(n));

  // 去掉【】[] 标签和书名号部分，剩下的按分隔符切
  const rest = t
    .replace(/【[^】]*】|\[[^\]]*\]/g, ' ')
    .replace(/[《「『][^》」』]*[》」』]/g, ' | ')
    .replace(/[“"][^”"]*[”"]/g, ' ');   // 引号里一般是简介文案
  const parts = rest.split(/[-—–|/｜丨]/).map((s) => stripNotes(s)).filter(Boolean);
  for (const p of parts) {
    const s = p.trim();
    if (!s || s.length > 30) continue;
    // 有书名号歌名 → 剩下的都当歌手；没有书名号 → 「A - B」分不清先后，前两段都当候选歌名
    if (bookNames.length) artists.push(s);
    else if (names.length < 2) { names.push(s); artists.push(s); }
    else artists.push(s);
  }
  if (!names.length) names.push(stripNotes(t.replace(/【[^】]*】/g, ' ')));

  // 搜索关键词：用抽出来的「歌名 歌手」比原始长标题准得多（实测原文搜会把相关候选挤掉）
  const bookHit = t.match(/[《「『]([^》」』]{1,40})[》」』]/);
  const cleanParts = parts.map((s) => String(s).split(/[「『《“"]/)[0].trim()).filter(Boolean);
  let keyword = '';
  if (bookHit && artists.length) keyword = `${bookHit[1].trim()} ${artists[0]}`.trim();
  else if (cleanParts.length >= 2) keyword = `${cleanParts[0]} ${cleanParts[1]}`.trim();
  else if (cleanParts.length === 1) keyword = cleanParts[0];
  if (!keyword) keyword = stripNotes(t.replace(/【[^】]*】/g, ' '));

  return { names: [...new Set(names)], artists: [...new Set(artists)], keyword };
}

// 伴奏 / 混音之类的版本：B 站标题没提到就不该选它
const VARIANT_RE = /伴奏|纯音乐|instrumental|off\s*vocal|karaoke|remix|\bdj\b|铃声|加速|降调|0\.\d+x/i;

/** 候选歌手名拆开：「冯沁苑(买辣椒也用券)」「A/B」「A & B」 */
function splitArtists(s) {
  return String(s || '').split(/[/,，、&;；()（）]|\sfeat\.?\s|\sft\.?\s/i).map((x) => x.trim()).filter(Boolean);
}

/* ────────── 打分 ────────── */

function scoreTitle(candTitle, ctx) {
  const plain = stripNotes(candTitle) || candTitle;
  let best = dice(candTitle, ctx.title);
  const cc = norm(plain);
  for (const n of ctx.names) {
    // 候选歌名整体出现在 B 站标题片段里（「孤勇者」⊂「孤勇者「爱你孤身走暗巷…」）：
    // 短标题对长片段用 Dice 会被长度差拖死，这种包含关系直接给高分
    if (cc && cc.length >= 2 && norm(n).includes(cc)) best = Math.max(best, 90);
    best = Math.max(best, dice(plain, n), dice(candTitle, n));
  }
  // 候选是伴奏 / remix，而 B 站标题里没这个字眼：大幅扣分
  const m = String(candTitle).match(VARIANT_RE);
  if (m && !ctx.title.toLowerCase().includes(m[0].toLowerCase())) best -= 50;
  return Math.max(0, best);
}

function scoreArtist(candArtist, ctx) {
  const hay = norm(`${ctx.title} ${ctx.artist}`);
  let best = 0;
  for (const a of splitArtists(candArtist)) {
    const n = norm(a);
    // 名字原样出现在 B 站标题或 UP 主名里，直接满分（纯字母的要 3 个以上，免得 "li" 这种到处撞）
    if ((/[^\x00-\x7f]/.test(n) ? n.length >= 2 : n.length >= 3) && hay.includes(n)) return 100;
    for (const h of [ctx.artist, ...ctx.artists]) best = Math.max(best, dice(a, h));
  }
  return best;
}

/** total < 0 表示被硬淘汰；reject 记录原因 */
function score(cand, ctx) {
  const diff = (ctx.durationSec > 0 && cand.durationSec > 0)
    ? Math.abs(cand.durationSec - ctx.durationSec) : 0;
  if (diff > HARD_DUR_DIFF) {
    return { title: 0, artist: 0, total: -1, diff: Math.round(diff), reject: `时长差 ${Math.round(diff)}s` };
  }
  const t = scoreTitle(cand.title, ctx);
  const a = scoreArtist(cand.artist, ctx);
  // 歌手分 0 = 判定不出（B 站标题常只有歌名 + 片段描述），这时别让歌手分把好匹配拖死，改由标题主导
  let total = a > 0 ? t * 0.5 + a * 0.5 : t * 0.9;
  if (t < MIN_TITLE) total -= LOW_TITLE_PENALTY;
  // 10–20 秒的差：视频片头片尾造成，可用但降权
  if (diff > MAX_DUR_DIFF) total *= 0.8;
  return { title: Math.round(t), artist: Math.round(a), total: Math.round(total), diff: Math.round(diff) };
}

/** 带 [mm:ss] 时间戳的才算能跟着走的歌词 */
const SYNCED_RE = /\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]/;
// 网易云对纯音乐会给一句「纯音乐，请欣赏」，等于没有
const isEmptyLyric = (s) => !String(s || '').replace(/\[[^\]]*\]/g, '').replace(/纯音乐，?请欣赏|此歌曲为没有填词的纯音乐/g, '').trim();

/* ────────── 两个源 ────────── */

async function searchNe(keyword) {
  const j = await neGet('/cloudsearch', { keywords: keyword, type: 1, limit: PER_SOURCE });
  const songs = (j.result && j.result.songs) || [];
  return songs.map((s) => ({
    source: 'ne',
    trackId: s.id,
    title: s.name || '',
    artist: (s.ar || []).map((x) => x.name).join('/'),
    durationSec: (s.dt || 0) / 1000,
  }));
}

/** 网易云的歌词要单独再取；顺带把译文 / 注音一起带回 */
async function fetchNeLyric(c) {
  const j = await neGet('/lyric', { id: c.trackId });
  const lrc = (j.lrc && j.lrc.lyric) || '';
  if (isEmptyLyric(lrc)) return null;
  return {
    lrc,
    tlyric: (j.tlyric && j.tlyric.lyric) || '',
    romalrc: (j.romalrc && j.romalrc.lyric) || '',
    synced: SYNCED_RE.test(lrc),
  };
}

async function searchLrclib(keyword, ctx) {
  let list = await lrclibSearch(keyword);
  // LRCLIB 是分词全文检索：B 站原标题太长太杂时一条都搜不到，退一步用拆出来的「歌名 歌手」再搜
  if (!Array.isArray(list) || !list.length) {
    // 备用词：把抽出来的每段再按空格取第一个词（「夜曲 MV 2160P修复版」→「夜曲」），
    // 原来用 names[0]+artists[0] 会拼出「周杰伦 周杰伦」这种，搜回一堆不相干的歌
    const alt = ctx.names
      .map((n) => String(n).split(/\s+/)[0])
      .filter(Boolean)
      .slice(0, 2)
      .join(' ');
    if (alt && alt !== keyword) list = await lrclibSearch(alt);
  }
  return (Array.isArray(list) ? list : []).slice(0, PER_SOURCE).map((x) => {
    const synced = x.syncedLyrics || '';
    const plain = x.plainLyrics || '';
    return {
      source: 'lrclib',
      trackId: x.id,
      title: x.trackName || x.name || '',
      artist: x.artistName || '',
      durationSec: Number(x.duration) || 0,
      lyric: x.instrumental || (isEmptyLyric(synced) && !plain.trim())
        ? null
        : { lrc: synced.trim() ? synced : plain, tlyric: '', romalrc: '', synced: !!synced.trim() },
    };
  });
}

/* ────────── 对外 ────────── */

/**
 * match({ title, artist, durationSec, bvid, page? })
 * → { ok:true, source, songTitle, songArtist, score, trackId, lrc, tlyric, romalrc, synced, fromCache }
 * → { ok:false, reason }
 */
async function match({ title, artist, durationSec, bvid, page = 1 } = {}) {
  if (!title) return { ok: false, reason: '缺少标题' };
  const key = cacheKey(bvid, page);

  if (key) {
    const hit = readCache(key);
    if (hit && hit.ok) return { ...hit, fromCache: true };
    const at = failedAt.get(key);
    if (at && Date.now() - at < FAIL_COOLDOWN_MS) {
      return { ok: false, reason: `上次匹配失败，冷却中（${Math.ceil((FAIL_COOLDOWN_MS - (Date.now() - at)) / 1000)}s 后可重试）` };
    }
  }

  const ctx = { title, artist: artist || '', durationSec: Number(durationSec) || 0, ...parseBiliTitle(title) };
  // 优先用抽出来的「歌名 歌手」；抽不出东西才退回原始标题
  const keyword = ctx.keyword || `${title} ${artist || ''}`.trim();

  const [ne, lr] = await Promise.allSettled([searchNe(keyword), searchLrclib(keyword, ctx)]);
  const errs = [];
  if (ne.status === 'rejected') errs.push(`网易云：${ne.reason.message}`);
  if (lr.status === 'rejected') errs.push(`LRCLIB：${lr.reason.message}`);
  if (errs.length === 2) return fail(key, errs.join('；'));

  // 打分 + 过阈值
  const all = [...(ne.value || []), ...(lr.value || [])].map((c) => ({ ...c, score: score(c, ctx) }));
  const cands = all
    .filter((c) => c.score && c.score.total >= ACCEPT)
    .sort((a, b) => b.score.total - a.score.total);

  // 网易云候选要再取一次歌词才知道有没有时间轴；只取过线的前 3 条，免得请求太多
  const neTop = cands.filter((c) => c.source === 'ne').slice(0, 3);
  await Promise.all(neTop.map(async (c) => {
    try { c.lyric = await fetchNeLyric(c); } catch (e) { c.lyric = null; errs.push(`网易云歌词：${e.message}`); }
  }));

  // 选优：有时间轴的优先，同档按分数
  const withLyric = cands.filter((c) => c.lyric);
  const pick = withLyric.find((c) => c.lyric.synced) || withLyric[0];
  if (!pick) {
    const why = cands.length ? '过线的候选都没有歌词' : '没有候选过线（时长 / 标题 / 歌手对不上）';
    // 失败时把最近的候选带回去：方便诊断，将来也能做「手动选歌词」
    const top = all
      .filter((c) => c.score && c.score.total > 0)
      .sort((a, b) => b.score.total - a.score.total)
      .slice(0, 3)
      .map((c) => ({
        source: c.source, title: c.title, artist: c.artist,
        durationSec: Math.round(c.durationSec),
        titleScore: c.score.title, artistScore: c.score.artist,
        total: c.score.total, reject: c.score.reject || '',
      }));
    return { ...fail(key, errs.length ? `${why}；${errs.join('；')}` : why), candidates: top };
  }

  const out = {
    ok: true,
    source: pick.source,
    songTitle: pick.title,
    songArtist: pick.artist,
    score: pick.score.total,
    trackId: pick.trackId,
    lrc: pick.lyric.lrc,
    tlyric: pick.lyric.tlyric,
    romalrc: pick.lyric.romalrc,
    synced: pick.lyric.synced,
    matchedAt: Date.now(),
  };
  if (key) {
    writeCache(key, out);
    failedAt.delete(key);
  }
  return { ...out, fromCache: false };
}

function fail(key, reason) {
  if (key) failedAt.set(key, Date.now());
  return { ok: false, reason };
}

module.exports = { match, dice, score, parseBiliTitle, ACCEPT, MAX_DUR_DIFF };
