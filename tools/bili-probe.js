/**
 * B 站音源验收探针（纯 node，不依赖 Electron）
 * 用法:
 *   node tools/bili-probe.js                  buvid + 音乐区榜单前 3
 *   node tools/bili-probe.js BV17VZpY1ENA     该 BV 的选中档位 / deadline 剩余 / CDN host
 *   node tools/bili-probe.js BV17VZpY1ENA --download   下载到缓存，再调一次验证命中缓存
 *   node tools/bili-probe.js BV1ft4y1G7so --lyrics     歌词匹配（网易云 + LRCLIB），再跑一次应命中缓存
 *   node tools/bili-probe.js --clean "【MV】标题"   标题清洗前后对比（不联网）
 *   node tools/bili-probe.js --qr          生成二维码，打印 key（验证登录接口通）
 *   node tools/bili-probe.js --search 起风了          WBI 签名视频搜索，前 5 条
 *   node tools/bili-probe.js --search-user 关键词     UP 主搜索，前 5 个
 *   node tools/bili-probe.js --recommend      音乐区推荐（region/feed/rcmd），全部打印
 *   node tools/bili-probe.js --user-videos <mid>  UP 主投稿，前 5 条
 *   node tools/bili-probe.js --season <bvid>      合集标题、视频数及首条视频
 * 环境变量 BILI_SESSDATA=xxx 可带登录态测 Hi-Res。
 */
const bili = require('../app/bili/api.js');

async function probeRanking() {
  const buvid = await bili.getBuvid();
  console.log(`buvid3: ${buvid}`);
  const list = await bili.ranking();
  console.log(`音乐区榜单 ${list.length} 条，前 3：`);
  list.slice(0, 3).forEach((v, i) => {
    console.log(`  ${i + 1}. ${v.title}  — ${v.artist}  [${v.bvid}]`);
  });
}

async function probeBv(input) {
  const bvid = bili.parseInput(input);
  if (!bvid) throw new Error(`解析不出 BV 号：${input}`);
  const info = await bili.getInfo(bvid);
  console.log(`标题: ${info.title}`);
  console.log(`UP主: ${info.artist}  时长: ${info.duration}s  cid: ${info.cid}  分P: ${info.pages.length}`);

  const sessdata = process.env.BILI_SESSDATA || '';
  const p = await bili.getPlayUrl(bvid, { sessdata, page: bili.parsePage(input) });
  const left = p.deadline - Math.floor(Date.now() / 1000);
  console.log(`登录态: ${sessdata ? '带 SESSDATA' : '未登录'}`);
  console.log(`可用档位: ${p.available.join(', ')}`);
  console.log(`选中档位: ${p.qualityId} (${p.qualityLabel})  codecs=${p.codecs}  带宽=${p.bandwidth}`);
  console.log(`deadline 剩余: ${Math.floor(left / 60)} 分钟`);
  console.log(`CDN host: ${new URL(p.url).host}`);
  if (p.backups.length) console.log(`备用 host: ${p.backups.map((u) => new URL(u).host).join(', ')}`);

  // 顺手验证 Referer 是不是真的必须：带头 / 不带头各打一次 Range 请求
  const tryGet = async (headers) => {
    try {
      const r = await fetch(p.url, { headers: { Range: 'bytes=0-1023', ...headers }, signal: AbortSignal.timeout(15000) });
      return r.status;
    } catch (e) { return e.name; }
  };
  console.log(`直链 带 Referer+UA: HTTP ${await tryGet(p.headers)}  ·  不带: HTTP ${await tryGet({})}`);
}

/** 下载两次：第一次真下，第二次应命中缓存 */
async function probeDownload(input) {
  const bvid = bili.parseInput(input);
  if (!bvid) throw new Error(`解析不出 BV 号：${input}`);
  const opts = { sessdata: process.env.BILI_SESSDATA || '', page: bili.parsePage(input) };
  for (const round of [1, 2]) {
    const t0 = Date.now();
    let last = 0;
    const d = await bili.downloadAudio(bvid, {
      ...opts,
      onProgress: (got, total) => {
        if (got - last < 4 * 1048576) return;
        last = got;
        console.log(`  …${(got / 1048576).toFixed(1)}MB${total ? ` / ${(total / 1048576).toFixed(1)}MB` : ''}`);
      },
    });
    console.log(`第 ${round} 次: fromCache=${d.fromCache}  档位=${d.qualityId} (${d.qualityLabel})  `
      + `${d.bytes} 字节 (${(d.bytes / 1048576).toFixed(2)}MB)  耗时 ${Date.now() - t0}ms`);
    console.log(`  路径: ${d.path}`);
  }
}

const fmtDur = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/** 先用规范里的示例验算签名，再真打搜索接口 */
async function probeSearch(keyword, type) {
  const signed = bili.wbiSign({ foo: '114', bar: '514', zab: 1919810 },
    '7cd084941338484aae1ad9425b84077c', '4932caff0ff746eab6f01bf08b70ac45', 1702204169);
  const ok = signed.endsWith('w_rid=8f6f2b5b3d485fe1886cec6a0be8c5d4');
  console.log(`签名自检（规范示例）: ${ok ? '通过' : '不通过 ' + signed}`);
  if (!ok) throw new Error('WBI 签名与规范示例不一致');

  if (!keyword) throw new Error('缺少关键词');
  const t0 = Date.now();
  if (type === 'user') {
    const list = await bili.searchUser(keyword);
    console.log(`UP 主搜索「${keyword}」${list.length} 条（${Date.now() - t0}ms），前 5：`);
    list.slice(0, 5).forEach((u, i) => {
      console.log(`  ${i + 1}. ${u.name}  [mid ${u.mid}]  粉丝 ${u.fans}  视频 ${u.videos}`);
    });
  } else {
    const list = await bili.searchVideo(keyword);
    console.log(`视频搜索「${keyword}」${list.length} 条（${Date.now() - t0}ms），前 5：`);
    list.slice(0, 5).forEach((v, i) => {
      console.log(`  ${i + 1}. [${v.bvid}] ${v.title}  — ${v.artist}  ${fmtDur(v.duration)}`);
    });
  }
}

async function probeRecommend() {
  const t0 = Date.now();
  const list = await bili.recommendRegion({ count: 15 });
  console.log(`音乐区推荐 ${list.length} 条（${Date.now() - t0}ms）：`);
  list.forEach((v, i) => {
    console.log(`  ${String(i + 1).padStart(2)}. [${v.bvid}] ${v.title}  — ${v.artist || '?'}  ${fmtDur(v.duration)}  cid=${v.cid}`);
  });
}

/** 本机 3000 取流服务没开就临时拉一个，跑完关掉（网易云一路要靠它） */
async function ensureNeApi() {
  const alive = () => fetch('http://127.0.0.1:3000/', { signal: AbortSignal.timeout(1200) }).then(() => true, () => false);
  if (await alive()) return null;
  const dir = require('node:path').join(__dirname, '..', 'node_modules', 'NeteaseCloudMusicApi');
  const proc = require('node:child_process').spawn(process.execPath, ['app.js'], {
    cwd: dir, env: { ...process.env, PORT: '3000' }, stdio: 'ignore', windowsHide: true,
  });
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await alive()) { console.log(`（临时拉起取流服务 pid=${proc.pid}）`); return proc; }
  }
  proc.kill();
  console.log('（取流服务没起来，网易云一路会失败）');
  return null;
}

async function probeLyrics(input) {
  const bvid = bili.parseInput(input);
  if (!bvid) throw new Error(`解析不出 BV 号：${input}`);
  const lyrics = require('../app/bili/lyrics.js');
  const info = await bili.getInfo(bvid);
  const page = bili.parsePage(input);
  const p = info.pages.find((x) => x.page === page);
  // 多 P 时每一 P 是一首，分 P 名更接近歌名
  const title = info.pages.length > 1 && p && p.part ? p.part : info.title;
  const durationSec = (p && p.duration) || info.duration;
  console.log(`B 站: ${title}  — ${info.artist}  ${fmtDur(durationSec)}`);

  const proc = await ensureNeApi();
  try {
    const t0 = Date.now();
    const r = await lyrics.match({ title, artist: info.artist, durationSec, bvid, page });
    const ms = Date.now() - t0;
    if (!r.ok) {
      console.log(`匹配失败（${ms}ms）: ok=false  reason=${r.reason}`);
      return;
    }
    const lines = r.lrc.split(/\r?\n/).filter((l) => l.replace(/\[[^\]]*\]/g, '').trim()).length;
    const tl = r.tlyric ? r.tlyric.split(/\r?\n/).filter((l) => l.replace(/\[[^\]]*\]/g, '').trim()).length : 0;
    console.log(`fromCache=${r.fromCache}  耗时 ${ms}ms`);
    console.log(`匹配: 「${r.songTitle}」 — ${r.songArtist}  来源=${r.source}  trackId=${r.trackId}  分数=${r.score}`);
    console.log(`歌词: ${lines} 行  ${r.synced ? '带时间轴' : '纯文本'}${tl ? `  译文 ${tl} 行` : ''}${r.romalrc ? '  有注音' : ''}`);
  } finally {
    if (proc) proc.kill();
  }
}

/** 标题清洗前后对比（纯本地，不联网） */
function probeClean(raw) {
  if (!raw) throw new Error('缺少标题');
  const out = require('../app/renderer/js/title-clean.js').clean(raw);
  console.log(`原文: ${raw}`);
  console.log(`清洗: ${out}${out === raw ? '  （原样返回）' : ''}`);
}

async function probeQr() {
  const q = await bili.qrGenerate();
  console.log(`qrcode_key: ${q.key}`);
  console.log(`扫码 url: ${q.url}`);
  console.log(`二维码图 dataURL 长度: ${q.qrDataUrl.length}`);
  const s = await bili.qrPoll(q.key);
  console.log(`首次轮询: ${s.status} (code=${s.code}) ${s.message}`);
}

(async () => {
  const arg = process.argv[2];
  try {
    if (!arg) await probeRanking();
    else if (arg === '--user-videos') {
      const rows = await bili.userVideos(process.argv[3]);
      console.log(`投稿 ${rows.length} 条，前 5：`);
      rows.slice(0, 5).forEach((v) => console.log(`[${v.bvid}] ${v.title} · ${v.duration}s`));
    }
    else if (arg === '--season') {
      const s = await bili.seasonInfo(process.argv[3]);
      console.log(s ? `合集：${s.title} · ${s.episodes.length} 个视频 · seasonId=${s.seasonId}` : '这个视频没有合集');
      if (s) console.log(JSON.stringify(s.episodes.slice(0, 1), null, 2));
    }
    else if (arg === '--clean') probeClean(process.argv.slice(3).join(' '));
    else if (arg === '--qr') await probeQr();
    else if (arg === '--recommend') await probeRecommend();
    else if (arg === '--search') await probeSearch(process.argv.slice(3).join(' '), 'video');
    else if (arg === '--search-user') await probeSearch(process.argv.slice(3).join(' '), 'user');
    else if (process.argv.includes('--download')) await probeDownload(arg);
    else if (process.argv.includes('--lyrics')) await probeLyrics(arg);
    else await probeBv(arg);
  } catch (e) {
    console.error(`失败 [${e.code || '-'}] ${e.message}`);
    process.exitCode = 1;
  }
})();
