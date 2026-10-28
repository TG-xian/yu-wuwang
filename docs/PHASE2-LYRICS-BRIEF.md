# 第二期：B 站源歌词匹配 + 点歌词跳转

## 目标

1. **B 站音源播放时自动匹配歌词**（网易云 + LRCLIB 双源），显示进现有歌词区
2. **播放页点歌词跳转到该句**（全局功能：网易云 / 本地 / B 站都生效）

## 已实测事实

- **LRCLIB**（免鉴权、无需任何 key）：
  `GET https://lrclib.net/api/search?q=<标题 歌手>` → 返回数组，字段：`id / trackName / artistName / albumName / duration(秒) / syncedLyrics(LRC 文本) / plainLyrics`
  实测「起风了 买辣椒也用券」返回 20 条，`syncedLyrics` 有值。
- **网易云**（已有）：`window.YW.api.search(keywords, 1)` 搜单曲 → 取 `id`；`window.YW.api.lyric(id)` 取歌词（现有三轨：`lrc` / `tlyric` / `romalrc`）。
- **B 站标题形态**举例：`【无损音质】《起风了》-买辣椒也用券`，UP 主 `西伯利亚麻雀`，时长 `5:27`（`getInfo` 里已有秒数）。

## 匹配策略（思路来自 bilimusic，实现自己写）

1. 关键词 = `标题 + UP 主`（**不清洗标题**，直接拼——这是它源码里的做法，清洗反而会丢信息）
2. 候选：网易云前 10 条 + LRCLIB 前 10 条
3. 打分：
   - **时长差 > 4 秒 → 直接淘汰**
   - 标题相似度分（**字符 2-gram Dice 系数 × 100**）
   - 歌手分（候选的 artist 与 `UP主` / 标题里提取的歌手名比）
   - 综合分 = `标题×0.5 + 歌手×0.5`
   - 标题分 < 30 → 总分 **−35**（防「只是时长巧合撞上」）
   - 总分 < **55** → 不接受
4. 选优：**有逐字/行级时间轴的优先**（能跟着走的）> 纯文本；同档取分数高者

## 实现要求

### 1. 新增 `app/bili/lyrics.js`（主进程）

```js
async function match({ title, artist, durationSec, bvid }) 
// → { ok, source: 'ne'|'lrclib', songTitle, songArtist, score, trackId, lrc, tlyric?, romalrc? }
// 失败 → { ok:false, reason }
```

- 两个源**并行请求**，任一成功即可；两源都失败返回 `ok:false`
- 网易云走本地 3000 服务（`http://127.0.0.1:3000/cloudsearch` + `/lyric`），复用主进程已有的请求方式
- 缓存：`userData/bili-lyrics/<bvid>.json`，命中直接返回（歌词不常变）
- **失败冷却 3 分钟**（同一个 bvid 失败后 3 分钟内不再重试，防重试风暴）
- 请求超时 8 秒

### 2. `app/main.js` + `preload.js`

- IPC `bili:lyrics`，参数 `{ bvid, title, artist, durationSec }`
- preload 暴露 `window.yw.bili.lyrics(payload)`

### 3. 渲染层

- B 站曲目开始播放后：先显示「歌词匹配中…」，拿到结果后填入**现有歌词区**（复用现有的 `state.lyric` 结构，不要另起一套渲染）
- 网易云歌词的三轨显示逻辑（原文/译文/罗马音）要能复用：如果匹配到的是网易云歌词，`tlyric`/`romalrc` 一起带回来并按现有规则显示
- 匹配不到：显示「暂无歌词（可手动切换）」即可，不要报错弹窗

### 4. 点歌词跳转（全局）

- 播放页歌词每一行加点击事件 → `seek` 到该行起始时间
- 需要：
  - 行加 `cursor:pointer` + hover 高亮（用现有 CSS 变量，别加新配色）
  - 点击后立即向引擎发 `{ cmd:'seek', seconds }`，并让歌词高亮跟到该行
  - 正在拖动的状态不要互相打架（如果已有 seek 逻辑，复用它）
- **不限于 B 站**：网易云、本地歌词同样可点

## 硬约束

- **不改** `engine/audio.js`、`engine/index.js`
- **不改** 现有网易云歌词的取词/显示逻辑（只做扩展：B 站来源的歌词走同一套显示）
- 不引入新依赖
- 不要从开源项目复制代码（bilimusic 是 AGPL-3.0，只能学思路；Dice 系数、打分公式这些是通用算法，自己写）
- 中文注释，风格与现有代码一致

## 验收（我会自己跑）

1. `node tools/bili-probe.js BV1ft4y1G7so --lyrics` → 打印匹配到的歌名、来源（ne/lrclib）、分数、歌词行数
2. 再跑一次同一首 → 应命中缓存（打印 `fromCache`）
3. 故意用一首冷门/无歌词的 bvid → 返回 `ok:false` 且不报错
4. `npx electron .` 启动无报错
5. 播放 B 站歌曲 → 歌词区出现歌词；点某一行 → 播放位置跳过去

## 报告

- 改了哪些文件、各多少行
- `--lyrics` 的真实输出（贴原文）
- 匹配成功/失败的判定阈值最终是多少
- 踩到的坑
