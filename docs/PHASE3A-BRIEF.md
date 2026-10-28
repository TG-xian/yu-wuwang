# 第三期 A：UP 主主页 + 合集页

项目：`C:\Users\tianz\Program\yu-wuwang`（Electron 播放器，已接 B 站音源）
**开工前先读**：`docs/HANDOFF.md`（当前状态）、`app/bili/api.js`（B 站接口层，已有 WBI 签名实现）、`app/renderer/js/bili.js`（B 站页面逻辑）。

## 目标

1. **点 UP 主名 → UP 主主页**：列出该 UP 主的投稿视频（优先音乐分区），可点播
2. **点合集 → 合集页**：列出该合集（`ugc_season`）下的所有视频，可点播
3. 这两处入口出现在：B 站榜单/推荐/搜索结果的行里（UP 主名、合集标签）

## 接口事实（先自己验证再实现，别猜字段）

项目里已有 WBI 签名工具（`app/bili/api.js` 中的 `getWbiKeys` / `wbiSign` / `invalidateWbi`，撞 −352/−412 会重签重试），**直接复用，不要另写一套**。

### 1. UP 主投稿列表

```
GET https://api.bilibili.com/x/space/wbi/arc/search
    ?mid=<mid>&pn=<页码>&ps=30&order=pubdate&platform=web
```
- 需要 **WBI 签名**（wts + w_rid），cookie 需带 `buvid3 + buvid4 + b_nut`（项目里的 `searchCookies()` 已封装）
- 返回结构：`data.list.vlist[]`，每条含 `bvid / title / pic / author / mid / length("mm:ss") / created`
- 注意：这个接口**风控比搜索更严**，撞 −352 要重签重试一次，仍失败就报错

### 2. 合集信息（从单个视频反查它属于哪个合集）

```
GET https://api.bilibili.com/x/web-interface/view?bvid=<bvid>
```
- 返回 `data.ugc_season`（没有合集时为 null 或不返回）
- `ugc_season` 结构：`{ id, title, cover, mid, sections: [{ episodes: [{ bvid, title, arc: { pic, duration, pubdate } }] }] }`
- **先打印一条真实返回确认字段名**，再写映射

### 3. UP 主的合集列表（可选，第二步再做）

```
GET https://api.bilibili.com/x/polymer/web-space/seasons_series_list?mid=<mid>&page_num=1&page_size=20
```
- 若风控严重可跳过，第三期 A 不强制

## 实现要求

### 后端 `app/bili/api.js`

```js
async function userVideos(mid, { page = 1, ps = 30 } = {})
// → [{ bvid, title, cover, artist, duration, created }]

async function userSeasons(mid, { page = 1 } = {})
// → [{ seasonId, title, cover, count }]（拿不到就返回 []）

async function seasonInfo(bvid)
// → { seasonId, title, cover, mid, episodes: [{ bvid, title, cover, duration }] } 或 null
```

- `duration` 统一成**秒**（B 站返回的是 `"4:32"` 字符串）
- 封面 `//` 开头补 `https:`
- 标题剥掉 `<em class="keyword">` 这类标签
- 复用文件里现有的 `request()` / `getBuvid()` / WBI 工具，不要重复造

### 主进程 `app/main.js` + `app/preload.js`

沿用现有 `biliHandle()` 包装器加：
- `bili:user-videos`（参数 `{ mid, page }`）
- `bili:season`（参数 `{ bvid }`）

preload 里 `window.yw.bili` 补 `userVideos` / `season` 两个转发。

### 渲染层

1. **入口**：B 站列表行（`app/renderer/js/bili.js` 的 `rowHtml`）里，UP 主名做成可点击；
   合集信息在行上以「合集」小标签呈现（没有合集就不显示）。
2. **UP 主页**：新增 `data-page="bili-user"` 页面
   - 顶部：UP 主头像/名字/粉丝数（`/x/space/wbi/acc/info?mid=`，拿不到就用列表里的 author 兜底）
   - 列表：投稿视频，复用现有 `.res-row.bili-row` 样式，点击即播（走现有 `toTrack` + 下载播放链路）
   - 分页：「加载更多」按钮或滚动加载，二选一
3. **合集页**：新增 `data-page="bili-season"` 页面
   - 顶部：合集封面 + 标题 + 视频数
   - 列表：合集内所有视频，点击即播
4. 两个新页面都要有「返回」按钮，回到来源页（榜单/推荐/搜索/UP 主页）
5. 侧栏**不加**新入口（这两个页面从行内点击进入）

## 硬约束

- **不改** `engine/audio.js`、`engine/index.js`
- **不改** 网易云相关逻辑（`app/renderer/js/api.js`）
- 不引入新依赖
- 不要从开源项目复制代码
- 注释中文，风格与现有代码一致

## 验收（我会自己跑）

1. `node tools/bili-probe.js --user-videos <某个 mid>` → 打印前 5 条（bvid/标题/时长）
2. `node tools/bili-probe.js --season <带合集的 bvid>` → 打印合集标题与视频数
3. 应用里：榜单某行点 UP 主名 → 进入主页 → 点一首能播
4. 应用里：带合集的行点「合集」→ 进入合集页 → 点一首能播
5. `git diff --stat engine/` 为空

## 报告

- 每个接口的**真实返回片段**（贴一条，说明字段从哪取）
- 改了哪些文件、各多少行
- 风控情况（撞没撞 −352，怎么处理的）
