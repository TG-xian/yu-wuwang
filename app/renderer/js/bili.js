/* B 站音源（渲染层）
   ============================================================
   网络请求全在主进程（app/bili/api.js）：要带 Referer，且本页 CSP 只放行本机端口。
   这里只管界面；播放走 app.js 的 playTrack（曲目带 bili 字段即走 B 站分支），
   不另开引擎连接。依赖 app.js 的全局：state / playTrack / esc / fmt。
   ============================================================ */
(function () {
  const ipc = window.yw && window.yw.bili;
  const $id = (id) => document.getElementById(id);

  const QUALITY_LABEL = {
    30251: 'Hi-Res 无损',
    30250: '杜比全景声',
    30280: '192K',
    30232: '132K',
    30216: '64K',
  };

  // 推荐 / 榜单两个列表：容器 id → 当前曲目（行上的 data-bi 是它的下标）
  const lists = { 'bili-rec': [], 'bili-rank': [] };
  const loaded = { 'bili-rec': false, 'bili-rank': false };
  let cardTrack = null;

  /** IPC 统一返回 { ok, data }，这里转回 throw，调用方写法和 api.js 一致 */
  async function call(fn, ...args) {
    if (!ipc) throw new Error('B 站接口未就绪（preload 未暴露）');
    const r = await ipc[fn](...args);
    if (!r || !r.ok) throw new Error((r && r.error) || '未知错误');
    return r.data;
  }

  /** hdslb 图片支持尺寸后缀；黑胶中心是圆的，裁成正方形更好看 */
  function thumb(url, w, h) {
    if (!url) return '';
    return `${url}@${w}w_${h}h_1c.jpg`;
  }

  /** 统一成 app.js 的曲目结构；id 带前缀，避免和网易云数字 id 撞 */
  function toTrack(v, page) {
    const p = page || null;
    const multi = p && v.pages && v.pages.length > 1;
    const cleaned = window.YW.title ? window.YW.title.clean(v.title) : v.title;
    return {
      id: `bili:${v.bvid}:${p ? p.cid : (v.cid || 0)}`,
      // t 显示用（清洗过），tRaw 原文给悬停提示
      t: multi ? `${cleaned} · P${p.page} ${p.part}` : cleaned,
      tRaw: multi ? `${v.title} · P${p.page} ${p.part}` : v.title,
      a: v.artist || 'UP 主',
      al: 'B 站',
      cover: thumb(v.cover, 400, 400),
      thumb: thumb(v.cover, 160, 100),   // 列表行用的小图
      dur: (p && p.duration) || v.duration || 0,
      // title / up 留原样给歌词匹配用：t 在多 P 时拼了分 P 名，a 可能被兜底成「UP 主」
      bili: {
        bvid: v.bvid, cid: p ? p.cid : (v.cid || 0), page: p ? p.page : 1,
        title: multi && p.part ? p.part : v.title,
        up: v.artist || '',
        mid: Number(v.mid) || 0, face: v.face || '', seasonId: Number(v.seasonId) || 0,
      },
    };
  }

  /** 匹配歌词：返回主进程 match() 的结果（ok:false 是「没匹配到」，不抛错） */
  function lyrics(track) {
    const b = track.bili;
    return call('lyrics', {
      bvid: b.bvid,
      page: b.page,
      title: b.title || track.t,
      artist: b.up != null ? b.up : track.a,
      durationSec: track.dur || 0,
    });
  }

  /**
   * 一行 B 站曲目（榜单 / 推荐 / 搜索共用）。
   * attrs 决定谁来接点击：本页列表用 data-bi，搜索页用 data-key 走 app.js 的全局点歌。
   */
  function rowHtml(t, i, attrs, tag = '') {
    return `
      <div class="res-row bili-row" ${attrs} title="${esc(t.tRaw || t.t)}">
        <span class="res-idx">${String(i + 1).padStart(2, '0')}</span>
        <div class="br-cover" style="background-image:url('${esc(t.thumb)}')"></div>
        <div style="flex:1;min-width:0">
          <div class="res-t">${esc(t.t)}</div>
          <div class="res-a">${t.bili.mid ? `<button class="bili-up-link" data-bili-mid="${t.bili.mid}" data-up-name="${esc(t.a)}" data-up-face="${esc(t.bili.face || '')}">${esc(t.a)}</button>` : esc(t.a)}</div>
        </div>
        <span data-season-slot="${esc(t.bili.bvid)}">${t.bili.seasonId ? `<button class="bili-season-link" data-bili-season="${esc(t.bili.bvid)}">合集</button>` : ''}</span>
        ${tag}
        <span class="res-badge${t.qualityId === 30251 ? ' hires' : ''}" data-bili-badge="${esc(t.bili.bvid)}">${esc(t.qLabel || (tag ? '待取流' : 'B 站'))}</span>
        <span class="res-dur">${t.dur ? fmt(t.dur) : ''}</span>
      </div>`;
  }

  /**
   * 主进程把音频下载到本地缓存，返回的 source 是本地文件路径（引擎走 StreamCreateFile）。
   * force 用于播放卡住时：跳过缓存重新取链重下。
   */
  async function resolve(track, { force = false } = {}) {
    const b = track.bili;
    const d = await call('playurl', { bvid: b.bvid, cid: b.cid, page: b.page, force });
    if (d.cid) b.cid = d.cid;
    track.qualityId = d.qualityId;
    track.qLabel = QUALITY_LABEL[d.qualityId] || d.qualityLabel || String(d.qualityId);
    console.log(`[bili] ${b.bvid} 档位=${d.qualityId} ${(d.bytes / 1048576).toFixed(1)}MB ${d.fromCache ? '命中缓存' : '已下载'}`);

    // 列表 / 卡片上的档位标签同步更新
    document.querySelectorAll(`[data-bili-badge="${b.bvid}"]`).forEach((el) => {
      el.textContent = track.qLabel;
      el.classList.toggle('hires', d.qualityId === 30251);
    });
    return { source: d.path, qualityId: d.qualityId, qualityLabel: track.qLabel };
  }

  /** 播放：设好队列再交给 playTrack，上一曲/下一曲沿用现有逻辑 */
  function play(track, queue) {
    const q = queue || [track];
    state.queue = q;
    state.qi = q.indexOf(track);
    state.history = [];
    state.radioMode = false;
    playTrack(track);
  }

  /* ────────── 解析 BV / 链接 ────────── */

  async function lookup() {
    const text = $id('bili-q').value.trim();
    const box = $id('bili-card');
    if (!text) return;
    box.innerHTML = '<div class="empty">解析中…</div>';
    try {
      const info = await call('info', text);
      renderCard(info);
    } catch (e) {
      box.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    }
  }

  function renderCard(info) {
    const pages = info.pages || [];
    const cur = pages.find((p) => p.page === info.page) || pages[0] || null;
    cardTrack = toTrack(info, cur);

    // 多 P 视频（合集 / 专辑）给个选择框，默认选链接里的 ?p=
    const pageSel = pages.length > 1
      ? `<select class="bili-pages" id="bili-pages">${pages.map((p) =>
          `<option value="${p.page}"${cur && p.page === cur.page ? ' selected' : ''}>P${p.page} ${esc(p.part)}</option>`).join('')}</select>`
      : '';

    $id('bili-card').innerHTML = `
      <div class="bili-card">
        <div class="bc-cover" style="background-image:url('${esc(thumb(info.cover, 320, 200))}')"></div>
        <div class="bc-body">
          <div class="bc-t">${esc(info.title)}</div>
          <div class="bc-a">${esc(info.artist)} · ${fmt(info.duration)} · ${esc(info.bvid)}</div>
          ${pageSel}
        </div>
        <span class="res-badge" data-bili-badge="${esc(info.bvid)}">待取流</span>
        <button class="lb-btn bc-play" id="bili-play">▶ 播放</button>
      </div>`;

    const sel = $id('bili-pages');
    if (sel) {
      sel.addEventListener('change', () => {
        const p = pages.find((x) => x.page === Number(sel.value));
        if (p) cardTrack = toTrack(info, p);
      });
    }
    $id('bili-play').addEventListener('click', () => {
      // 多 P 时整组当队列，下一曲就是下一 P
      if (pages.length > 1) {
        const all = pages.map((p) => toTrack(info, p));
        const hit = all.find((t) => t.bili.page === cardTrack.bili.page) || all[0];
        play(hit, all);
      } else {
        play(cardTrack);
      }
    });
  }

  /* ────────── 推荐 / 榜单 ────────── */

  /** 拉一组视频填进容器；name 用在提示文案里（「推荐」「榜单」） */
  async function loadList(boxId, fn, name) {
    const box = $id(boxId);
    box.innerHTML = '<div class="empty">加载中…</div>';
    try {
      const list = await call(fn);
      lists[boxId] = list.map((v) => toTrack(v));
      loaded[boxId] = true;
      box.innerHTML = lists[boxId].map((t, i) => rowHtml(t, i, `data-bi="${i}"`)).join('')
        || `<div class="empty">${name}为空</div>`;
    } catch (e) {
      box.innerHTML = `<div class="empty">${name}加载失败：${esc(e.message)}　<button class="lb-btn" data-retry>重试</button></div>`;
      box.querySelector('[data-retry]').addEventListener('click', () => loadList(boxId, fn, name));
    }
  }

  const loadRanking = () => loadList('bili-rank', 'ranking', '榜单');
  const loadRecommend = () => loadList('bili-rec', 'recommend', '推荐');

  /* ────────── UP 主主页 / 合集页 ────────── */

  let userPage = null;
  let seasonPage = null;
  const detailHistory = [];

  function enterDetail(view) {
    detailHistory.push({ view: state.view, user: userPage, season: seasonPage });
    if (detailHistory.length > 20) detailHistory.shift();
    switchView(view, { push: false });
  }

  function detailHead(box, info, subtitle, round = false) {
    box.innerHTML = `${info.face || info.cover ? `<img class="${round ? 'round' : ''}" src="${esc(info.face || info.cover)}" alt="">` : ''}
      <div><div class="page-t">${esc(info.name || info.title || 'UP 主')}</div>
      <div class="page-sub">${esc(subtitle)}</div></div>`;
  }

  function renderUser() {
    const u = userPage;
    if (!u) return;
    detailHead($id('bili-user-head'), u, `UP 主 · ${u.mid}${u.fans != null ? ` · ${Number(u.fans).toLocaleString()} 粉丝` : ''}`, true);
    $id('bili-user-list').innerHTML = u.tracks.map((t, i) => rowHtml(t, i, `data-bi="${i}"`)).join('')
      || `<div class="empty">${u.busy ? '投稿加载中…' : u.error ? '投稿暂时无法获取' : '暂无公开投稿'}</div>`;
    $id('bili-user-note').textContent = u.error || (u.done ? '已加载全部投稿' : `已加载 ${u.tracks.length} 条`);
    const more = $id('bili-user-more');
    more.hidden = u.done;
    more.disabled = u.busy;
    more.textContent = u.busy ? '加载中…' : u.error ? '重试' : '加载更多';
  }

  async function loadUserMore() {
    const u = userPage;
    if (!u || u.busy || u.done) return;
    u.busy = true;
    u.error = '';
    renderUser();
    try {
      const videos = await call('userVideos', { mid: u.mid, page: u.page + 1 });
      const known = new Set(u.tracks.map((t) => t.bili.bvid));
      u.tracks.push(...videos.filter((v) => !known.has(v.bvid)).map((v) => toTrack(v)));
      u.page++;
      u.done = videos.length < 30;
    } catch (e) { u.error = `投稿加载失败：${e.message}`; }
    finally {
      u.busy = false;
      if (u === userPage && state.view === 'bili-user') renderUser();
    }
  }

  function openUser(mid, fallback = {}) {
    enterDetail('bili-user');
    const u = userPage = { mid: Number(mid), name: fallback.name || 'UP 主', face: fallback.face || '',
      fans: fallback.fans, tracks: [], page: 0, busy: false, done: false, error: '' };
    loadUserMore();
    call('userProfile', { mid: u.mid }).then((profile) => {
      Object.assign(u, profile, { fans: profile.fans == null ? u.fans : profile.fans });
      if (userPage === u && state.view === 'bili-user') renderUser();
    }).catch(() => {});   // 资料接口风控时保留来源页的头像、名字和粉丝数。
  }

  function renderSeason() {
    const s = seasonPage;
    if (!s) return;
    if (!s.info) {
      $id('bili-season-head').innerHTML = '';
      $id('bili-season-list').innerHTML = `<div class="empty">${esc(s.error || '合集加载中…')}</div>`;
      return;
    }
    detailHead($id('bili-season-head'), s.info, `${s.tracks.length} 个视频`);
    $id('bili-season-list').innerHTML = s.tracks.map((t, i) => rowHtml(t, i, `data-bi="${i}"`)).join('')
      || '<div class="empty">合集暂无可播放视频</div>';
  }

  async function openSeason(bvid) {
    enterDetail('bili-season');
    const s = seasonPage = { bvid, info: null, tracks: [], error: '' };
    renderSeason();
    try {
      s.info = await call('season', { bvid });
      if (!s.info) s.error = '这个视频没有合集';
      else s.tracks = s.info.episodes.map((v) => toTrack(v));
    } catch (e) { s.error = `合集加载失败：${e.message}`; }
    if (seasonPage === s && state.view === 'bili-season') renderSeason();
  }

  document.querySelectorAll('.bili-detail-back').forEach((button) => button.addEventListener('click', () => {
    const prev = detailHistory.pop();
    if (!prev) { switchView('bili-recommend', { push: false }); return; }
    userPage = prev.user;
    seasonPage = prev.season;
    switchView(prev.view, { push: false });
    if (prev.view === 'bili-user') renderUser();
    if (prev.view === 'bili-season') renderSeason();
  }));
  $id('bili-user-more').addEventListener('click', loadUserMore);
  ['user', 'season'].forEach((kind) => $id(`bili-${kind}-list`).addEventListener('click', (e) => {
    const row = e.target.closest('[data-bi]');
    const tracks = kind === 'user' ? userPage && userPage.tracks : seasonPage && seasonPage.tracks;
    if (row && tracks && tracks[Number(row.dataset.bi)]) play(tracks[Number(row.dataset.bi)], tracks);
  }));

  // 捕获阶段拦住行内按钮，避免点击 UP 主或合集时触发整行播放。
  document.addEventListener('click', (e) => {
    const up = e.target.closest('[data-bili-mid]');
    const season = e.target.closest('[data-bili-season]');
    if (!up && !season) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (up) openUser(up.dataset.biliMid, { name: up.dataset.upName, face: up.dataset.upFace,
      fans: up.hasAttribute('data-up-fans') ? Number(up.dataset.upFans) : null });
    else openSeason(season.dataset.biliSeason);
  }, true);
  document.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.is-up[data-bili-mid]')) {
      e.preventDefault();
      e.target.click();
    }
  });

  // 榜单/搜索不保证含 season_id：只查询进入视口的行，两路并发，风控后本次会话停止补查。
  const checkedSeasons = new Map();
  const seasonJobs = [];
  let activeSeasonJobs = 0;
  let seasonRisk = false;
  function pumpSeasons() {
    while (!seasonRisk && activeSeasonJobs < 2 && seasonJobs.length) {
      const bvid = seasonJobs.shift();
      activeSeasonJobs++;
      call('season', { bvid }).then((s) => {
        checkedSeasons.set(bvid, s);
        if (s) document.querySelectorAll(`[data-season-slot="${bvid}"]`).forEach((slot) => {
          slot.innerHTML = `<button class="bili-season-link" data-bili-season="${bvid}">合集</button>`;
        });
      }).catch((e) => {
        if (/412|352|风控/.test(e.message)) seasonRisk = true;
      }).finally(() => { activeSeasonJobs--; pumpSeasons(); });
    }
  }
  const visibleSeasons = new IntersectionObserver((entries) => entries.forEach((entry) => {
    if (!entry.isIntersecting) return;
    const slot = entry.target;
    visibleSeasons.unobserve(slot);
    const bvid = slot.dataset.seasonSlot;
    if (checkedSeasons.has(bvid)) {
      if (checkedSeasons.get(bvid)) slot.innerHTML = `<button class="bili-season-link" data-bili-season="${bvid}">合集</button>`;
      return;
    }
    if (slot.children.length || seasonRisk) return;
    checkedSeasons.set(bvid, null);
    seasonJobs.push(bvid);
    pumpSeasons();
  }));
  new MutationObserver(() => document.querySelectorAll('[data-season-slot]:not([data-season-observed])').forEach((slot) => {
    slot.dataset.seasonObserved = '1';
    visibleSeasons.observe(slot);
  })).observe(document.querySelector('main') || document.body, { childList: true, subtree: true });

  // 本页列表用 data-bi 自己接点击：不进 app.js 的 state.rows，免得和搜索页的映射互相覆盖
  Object.keys(lists).forEach((boxId) => {
    $id(boxId).addEventListener('click', (e) => {
      const row = e.target.closest('.bili-row[data-bi]');
      if (!row) return;
      const t = lists[boxId][Number(row.dataset.bi)];
      if (t) play(t, lists[boxId]);
    });
  });

  /* ────────── 页头（推荐 / 榜单共用一份节点，切页时搬过去） ────────── */

  const HEAD_TITLE = {
    'bili-recommend': ['推<em>·</em>荐', 'BILIBILI · 音乐区推荐'],
    'bili-rank': ['榜<em>·</em>单', 'BILIBILI · 音乐区排行榜'],
  };

  function createHead() {
    const el = document.createElement('div');
    el.className = 'bili-head';
    el.innerHTML = `
      <div>
        <div class="page-t" style="font-size:26px;" id="bili-head-t"></div>
        <div class="page-sub" id="bili-head-sub"></div>
      </div>
      <div class="bili-acct">
        <span class="bili-state" id="bili-state">未登录</span>
        <button class="lb-btn" id="bili-login">扫码登录</button>
        <button class="lb-btn lb-ghost" id="bili-logout" hidden>退出</button>
      </div>`;
    return el;
  }

  const head = createHead();

  function mountHead(view) {
    const slot = document.querySelector(`[data-page="${view}"] .bili-head-slot`);
    if (!slot) return;
    const [t, sub] = HEAD_TITLE[view];
    head.querySelector('#bili-head-t').innerHTML = t;
    head.querySelector('#bili-head-sub').textContent = sub;
    slot.appendChild(head);   // 已挂在别处时 appendChild 就是移动，事件绑定不丢
  }

  // 先挂进文档：下面按 id 绑事件、refreshSession 按 id 取元素，游离节点里 getElementById 找不到
  mountHead('bili-recommend');

  /* ────────── 搜索（供 app.js 的融合搜索调用） ────────── */

  async function searchVideo(keyword) {
    const list = await call('searchVideo', { keyword, page: 1 });
    return list.map((v) => toTrack(v));
  }

  function searchUser(keyword) {
    return call('searchUser', { keyword, page: 1 });
  }

  /* ────────── 登录态 ────────── */

  async function refreshSession() {
    const el = $id('bili-state');
    try {
      const s = await call('sessionGet');
      let txt = '未登录';
      if (s.hasSessdata && !s.loggedIn) txt = '登录已失效';
      else if (s.loggedIn) {
        const who = s.uname ? ` · ${s.uname}` : '';
        txt = s.member === true ? `已登录（大会员）${who}`
          : s.member === false ? `已登录${who}`
          : '已登录（会员状态未知）';
      }
      el.textContent = txt;
      el.classList.toggle('on', !!s.loggedIn);
      $id('bili-login').hidden = !!s.loggedIn;
      $id('bili-logout').hidden = !s.hasSessdata;
    } catch (e) {
      el.textContent = '状态未知';
      console.warn('[bili] session:', e.message);
    }
  }

  let qrToken = 0;   // 关弹窗或重开时作废旧的轮询

  async function openQr() {
    const my = ++qrToken;
    // 与网易云共用同一个登录面板，元素是共享的
    const modal = $id('qr-modal');
    const img = $id('qr-img');
    const st = $id('qr-s');
    modal.hidden = false;
    img.innerHTML = '<div class="qr-ph">加载中…</div>';
    st.textContent = '正在获取二维码…';

    let q;
    try {
      q = await call('qrGenerate');
    } catch (e) {
      st.textContent = '获取二维码失败：' + e.message;
      return;
    }
    if (my !== qrToken) return;
    img.innerHTML = `<img src="${q.qrDataUrl}" alt="B 站登录二维码">`;
    st.textContent = '等待扫码…';

    // 二维码 180 秒过期，2 秒一轮
    for (let i = 0; i < 90; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      if (my !== qrToken || modal.hidden) return;
      let r;
      try {
        r = await call('qrPoll', q.key);
      } catch (e) {
        st.textContent = '轮询出错，重试中…';
        console.warn('[bili] qr poll:', e.message);
        continue;
      }
      if (my !== qrToken) return;
      if (r.status === 'waiting') st.textContent = '等待扫码…';
      else if (r.status === 'scanned') st.textContent = '已扫码，请在手机上确认';
      else if (r.status === 'expired') { st.textContent = '二维码已过期，关掉重开'; return; }
      else if (r.status === 'ok') {
        st.textContent = r.persisted ? '登录成功' : `登录成功（${r.note || '仅本次有效'}）`;
        setTimeout(() => { modal.hidden = true; }, r.persisted ? 700 : 2500);
        refreshSession();
        return;
      }
    }
    if (my === qrToken) st.textContent = '二维码已过期，关掉重开';
  }

  function closeQr() {
    qrToken++;
    $id('qr-modal').hidden = true;
  }

  async function saveManual() {
    const inp = $id('bili-sess');
    const note = $id('bili-sess-note');
    const v = inp.value.trim();
    if (!v) { note.textContent = '先粘贴 SESSDATA'; return; }
    try {
      const r = await call('sessionSave', v);
      inp.value = '';   // 明文不留在输入框里
      note.textContent = r.persisted ? '已保存（系统加密）' : `已生效：${r.error || '仅本次运行有效'}`;
      refreshSession();
    } catch (e) {
      note.textContent = '保存失败：' + e.message;
    }
  }

  async function logout() {
    try { await call('sessionClear'); } catch {}
    refreshSession();
  }

  /* ────────── 绑定 ────────── */

  $id('bili-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') lookup(); });
  $id('bili-go').addEventListener('click', lookup);
  $id('bili-login').addEventListener('click', openQr);
  $id('bili-logout').addEventListener('click', logout);
  // 关闭按钮与遮罩点击统一由 app.js 的共用面板处理，这里只导出开/关函数
  $id('bili-sess-save').addEventListener('click', saveManual);
  $id('bili-rec-more').addEventListener('click', loadRecommend);

  /** switchView('bili-recommend' | 'bili-rank') 时调用：列表只拉一次，登录态每次进来刷新 */
  function onShow(view) {
    mountHead(view);
    if (view === 'bili-recommend' && !loaded['bili-rec']) loadRecommend();
    if (view === 'bili-rank' && !loaded['bili-rank']) loadRanking();
    refreshSession();
  }

  window.YW = window.YW || {};
  window.YW.bili = { onShow, resolve, lyrics, play, rowHtml, searchVideo, searchUser, thumb, QUALITY_LABEL, openQrLogin: openQr, closeQrLogin: closeQr };
})();
