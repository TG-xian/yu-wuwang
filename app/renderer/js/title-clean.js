/* B 站标题清洗（只用于显示）
   ============================================================
   只动括号里的内容：按分隔符切段，命中「视频元信息 / 音质」词且剩下的只是
   「版、音质、中文」这类填充字时才删该段；段里还有别的（歌手名、原创…）就整段保留。
   括号外的正文一律不动。判不准就保守，宁可留噪音也不削掉真歌名。
   歌词匹配用的是原始标题（track.bili.title），不经过这里。
   同时给渲染层（window.YW.title）和 node 探针（require）用。
   ============================================================ */
(function () {
  // 视频元信息词
  const META = [
    '中字', '字幕', 'pv', '官方mv', 'mv', '本家', '熟肉', '生肉', '自译', '自翻', '自制',
    '转载', '搬运', '翻唱', 'cover', '4k', '1080p', '720p', '60fps', '高清', '无水印',
    '完整版', '现场', '直播', '剪辑', '混剪', '合集', '歌单', '循环',
  ];
  // 音质词
  const QUALITY = [
    '无损', 'hi-res', 'hires', '杜比', 'dolby', 'atmos', '全景声', '母带', 'flac', '320k',
    'dsd', '空间音频', '高音质',
  ];
  // 删掉关键词后，剩下的若只是这些字，整段算噪音
  const FILLER = /版本|版|音质|音源|中文|中日|中英|双语|官方|完整|超|高|无|的|附|带|\d+/g;

  // [开, 合]：全角半角圆括号常混用，归一组
  const BRACKETS = [['【', '】'], ['[', ']'], ['(（', ')）'], ['「', '」'], ['〈', '〉'], ['<', '>']];
  const SEP = /(\s*[／/·・|｜，、；：:]\s*)/;
  const TRIM = /^[\s／/·・|｜，、；：:\-–—]+|[\s／/·・|｜，、；：:\-–—]+$/g;

  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
  // 英文 / 数字词要求两侧不是字母数字（「mv」不吃「MVP」）；中文词直接子串
  const KEYWORDS = [...META, ...QUALITY]
    .sort((a, b) => b.length - a.length)
    .map((w) => (/^[a-z0-9-]+$/.test(w)
      ? new RegExp(`(?<![a-z0-9])${escRe(w)}(?![a-z0-9])`, 'gi')
      : new RegExp(escRe(w), 'g')));

  /** 一段是不是噪音：至少命中一个词，且去掉词和填充字后什么都不剩 */
  function isNoise(seg) {
    let rest = seg;
    let hit = false;
    for (const re of KEYWORDS) {
      const next = rest.replace(re, ' ');
      if (next !== rest) { hit = true; rest = next; }
    }
    return hit && !rest.replace(FILLER, '').replace(/[\s\-_.~～·]/g, '');
  }

  /** 括号内容 → 删掉噪音段后的内容（可能为空） */
  function cleanInner(inner) {
    const parts = inner.split(SEP);   // 偶数位是段，奇数位是分隔符
    let out = '';
    for (let i = 0; i < parts.length; i += 2) {
      const seg = parts[i];
      if (!seg.trim() || isNoise(seg)) continue;
      out += (out ? parts[i - 1] || ' ' : '') + seg.trim();
    }
    return out;
  }

  function clean(raw) {
    if (!raw || typeof raw !== 'string') return raw;
    let s = raw;
    for (const [o, c] of BRACKETS) {
      const oc = escRe(o), cc = escRe(c);
      // 只吃最内层一对，不跨嵌套
      const re = new RegExp(`([${oc}])([^${oc}${cc}]*)([${cc}])`, 'g');
      s = s.replace(re, (m, open, inner, close) => {
        const kept = cleanInner(inner);
        if (kept === inner.trim()) return m;   // 没删东西就原样留着（含原来的空白）
        return kept ? open + kept + close : ' ';
      });
    }
    s = s.replace(/\s{2,}/g, ' ').replace(TRIM, '');
    if (s.length < 2 || s === raw) return raw;
    return s;
  }

  const api = { clean };
  if (typeof window !== 'undefined') {
    window.YW = window.YW || {};
    window.YW.title = api;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
