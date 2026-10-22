/* 取流服务客户端
   ============================================================
   ⚠ 边界：这里只负责调用"已经跑在你本机"的 NeteaseCloudMusicApi，
   不实现、不逆向任何网易云接口。base URL 默认 http://127.0.0.1:3000。
   ============================================================
   三条硬规则（与 ARCH.md §5.3 一致）：
   1. level 只发 lossless（不发 hires / jymaster / sky）
   2. 播放地址必须校验：非 flac 或 br < 700000 → 判为非无损，不静默播
   3. 直链有有效期：播放前请求，不缓存 URL，只缓存 id
*/
(function () {
  const BASE_KEY = 'yw.api.base';
  const DEFAULT_BASE = 'http://127.0.0.1:3000';
  const MIN_LOSSLESS_BR = 700000;

  let base = localStorage.getItem(BASE_KEY) || DEFAULT_BASE;
  let cookie = '';                              // 服务无状态，登录态按请求携带

  function setBase(url) {
    base = String(url || DEFAULT_BASE).replace(/\/+$/, '');
    localStorage.setItem(BASE_KEY, base);
  }
  function getBase() { return base; }
  function setCookie(c) { cookie = String(c || ''); }
  function hasCookie() { return /MUSIC_U=/.test(cookie); }

  /** 带超时的 GET；服务未启动时给明确错误 */
  /**
   * 所有请求走 POST + JSON body。
   * 原因：cookie 有 4KB，塞进 query 后 URL 约 12KB，并发几个就把本地服务拖到超时。
   * 服务端会把 req.body 合并进 query，所以参数照传即可；body 里的 cookie 优先级最高。
   */
  async function req(path, params) {
    const body = {};
    for (const [k, v] of Object.entries(params || {})) {
      if (v !== undefined && v !== null && v !== '') body[k] = v;
    }
    body.timestamp = Date.now();
    if (cookie) body.cookie = cookie;

    // ⚠ 必须带唯一 query：NeteaseCloudMusicApi 的缓存键只看 URL，
    // 参数全放 body 时所有请求 URL 相同 → 全部命中同一份缓存，永远返回第一次的结果。
    const bust = `?_t=${Date.now()}${Math.random().toString(36).slice(2, 8)}`;

    let res;
    try {
      res = await fetch(`${base}${path}${bust}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });
    } catch (e) {
      throw new Error(`取流服务连不上（${base}）：${e.name === 'TimeoutError' ? '超时' : e.message}`);
    }
    if (!res.ok) throw new Error(`取流服务 ${res.status} @ ${path}`);
    const json = await res.json();
    if (json && json.code && json.code !== 200) {
      throw new Error(`接口返回 code=${json.code} @ ${path}${json.msg ? ' · ' + json.msg : ''}`);
    }
    return json;
  }

  /* ────────── 登录（扫码） ────────── */

  async function qrKey() {
    const j = await req('/login/qr/key');
    return j.data && j.data.unikey;
  }

  async function qrCreate(key) {
    const j = await req('/login/qr/create', { key, qrimg: true });
    return { qrurl: j.data && j.data.qrurl, qrimg: j.data && j.data.qrimg };
  }

  /** code: 800 过期 / 801 待扫 / 802 已扫待确认 / 803 成功 */
  async function qrCheck(key) {
    const j = await req('/login/qr/check', { key });
    return { code: j.code, message: j.message };
  }

  async function account() {
    const j = await req('/user/account');
    return j.profile || null;
  }

  async function logout() { return req('/logout'); }

  /* ────────── 内容 ────────── */

  /** type: 1 单曲 / 100 歌手 / 10 专辑 / 1000 歌单 */
  async function search(keywords, type = 1, limit = 30, offset = 0) {
    const j = await req('/cloudsearch', { keywords, type, limit, offset });
    const r = j.result || {};
    return {
      songs: r.songs || [],
      total: r.songCount || 0,
      playlists: r.playlists || [],
      artists: r.artists || [],
      albums: r.albums || []
    };
  }

  async function songDetail(ids) {
    const j = await req('/song/detail', { ids: [].concat(ids).join(',') });
    return j.songs || [];
  }

  /**
   * 取播放地址并判定是否真无损。
   * 返回 { url, br, type, lossless, reason }
   */
  async function songUrl(id, level = 'lossless') {
    const j = await req('/song/url/v1', { id, level });
    const d = (j.data && j.data[0]) || {};
    const url = d.url || '';
    const br = Number(d.br || 0);
    const type = (d.type || '').toLowerCase();
    const suffix = (url.split('?')[0].split('.').pop() || '').toLowerCase();

    let lossless = true, reason = '';
    if (!url) { lossless = false; reason = '无播放权限或已下架'; }
    else if (type && type !== 'flac' && suffix !== 'flac') { lossless = false; reason = `返回 ${type || suffix}，非无损`; }
    else if (br && br < MIN_LOSSLESS_BR) { lossless = false; reason = `码率 ${br} 低于无损阈值`; }

    return {
      url, br, type: type || suffix,
      size: d.size || 0,
      expi: d.expi || 0,           // 直链有效期（秒）
      lossless, reason
    };
  }

  /* ── 扫码登录 ── */
  async function qrKey() {
    const j = await req('/login/qr/key', { timestamp: Date.now() });
    return (j.data && j.data.unikey) || '';
  }

  /** 返回可直接放进 img.src 的 data URL */
  async function qrCreate(key) {
    const j = await req('/login/qr/create', { key, qrimg: true, timestamp: Date.now() });
    return (j.data && j.data.qrimg) || '';
  }

  /**
   * code: 800 过期 / 801 等待扫码 / 802 已扫待确认 / 803 成功（带 cookie）
   * ⚠ 这几个都不是 200，不能走 req()——那里会把非 200 的 code 当错误抛出，
   * 结果 803 永远到不了调用方，界面就一直停在二维码上。
   */
  async function qrCheck(key) {
    const res = await fetch(`${base}/login/qr/check?_t=${Date.now()}${Math.random().toString(36).slice(2, 6)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, timestamp: Date.now() }),
      signal: AbortSignal.timeout(8000),
    });
    const j = await res.json();
    return { code: j.code, message: j.message || '', cookie: j.cookie || '' };
  }

  async function lyric(id) {
    const j = await req('/lyric', { id });
    return {
      lrc: (j.lrc && j.lrc.lyric) || '',
      tlyric: (j.tlyric && j.tlyric.lyric) || '',
      // romalrc：网易云自带的注音轨。粤语歌是粤拼，日语歌是罗马音。
      // 已按时间戳对齐、不带原字与声调，正好是想要的形式。
      romalrc: (j.romalrc && j.romalrc.lyric) || ''
    };
  }

  async function recommendSongs() {
    const j = await req('/recommend/songs');
    return (j.data && j.data.dailySongs) || [];
  }

  async function personalized(limit = 12) {
    const j = await req('/personalized', { limit });
    return j.result || [];
  }

  /** 用户歌单（含自己创建的与收藏的，用 subscribed 区分） */
  async function userPlaylists(uid, limit = 200) {
    const j = await req('/user/playlist', { uid, limit, offset: 0 });
    return j.playlist || [];
  }

  async function playlistDetail(id) {
    const j = await req('/playlist/detail', { id });
    return j.playlist || null;
  }

  async function playlistTracks(id, limit = 500, offset = 0) {
    const j = await req('/playlist/track/all', { id, limit, offset });
    return j.songs || [];
  }

  /** 歌手页：{ name, songs }（hotSongs 通常 50 首） */
  async function artistSongs(id, limit = 50) {
    const j = await req('/artists', { id, limit });
    return { name: (j.artist && j.artist.name) || '', songs: j.hotSongs || [] };
  }

  /** 专辑页：{ name, picUrl, songs } */
  async function albumSongs(id) {
    const j = await req('/album', { id });
    const al = j.album || {};
    return { name: al.name || '', picUrl: al.picUrl || '', songs: j.songs || al.songs || [] };
  }

  async function likelist(uid) {
    const j = await req('/likelist', { uid });
    return j.ids || [];
  }

  /** 私人漫游（无限流，每次 3 首）。注意：该接口只收 POST，GET 会 405 */
  async function personalFm() {
    const j = await req('/personal_fm');
    return j.data || [];
  }

  /** 分类热门歌单，支持 offset 分页（刷新时用来换血） */
  async function topPlaylist(cat = '全部', limit = 28, offset = 0) {
    const j = await req('/top/playlist', { cat, limit, offset });
    return j.playlists || [];
  }

  /** 所有榜单（含 id/名称/更新频率） */
  async function toplist() {
    const j = await req('/toplist', {});
    return j.list || [];
  }

  /** 推荐新歌（漫游的备用源，不受 personal_fm 风控影响） */
  async function newsong(limit = 10) {
    const j = await req('/personalized/newsong', { limit });
    return (j.result || []).map((x) => x.song || x);
  }

  /** 喜欢 / 取消喜欢（需要登录态） */
  async function likeSong(id, like = true) {
    const j = await req('/like', { id, like: String(like) });
    return j.code === 200;
  }

  /** 解析 LRC 文本为 [{ t: 秒, text }] */
  function parseLrc(lrc) {
    const out = [];
    const re = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
    for (const line of String(lrc || '').split(/\r?\n/)) {
      const stamps = [];
      let m;
      while ((m = re.exec(line))) {
        const ms = m[3] ? Number(m[3].padEnd(3, '0')) : 0;
        stamps.push(Number(m[1]) * 60 + Number(m[2]) + ms / 1000);
      }
      if (!stamps.length) continue;
      const text = line.replace(re, '').trim();
      for (const t of stamps) out.push({ t, text });
    }
    return out.sort((a, b) => a.t - b.t);
  }

  window.YW = window.YW || {};
  window.YW.api = {
    setBase, getBase, setCookie, hasCookie,
    qrKey, qrCreate, qrCheck, account, logout,
    search, songDetail, songUrl, lyric, artistSongs, albumSongs, qrKey, qrCreate, qrCheck,
    recommendSongs, personalized, userPlaylists, playlistDetail, playlistTracks, likelist, likeSong, personalFm, newsong, toplist, topPlaylist,
    parseLrc,
    MIN_LOSSLESS_BR
  };
})();
