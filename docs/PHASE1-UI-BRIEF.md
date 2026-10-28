# 第一期 UI 骨架 + 融合搜索（前端部分）

## 参照

结构示意图：`docs/layout-phase1.html`（已和用户确认）。用户明确要求：

1. 侧栏分组「在线」→ 改名为 **「网易云」**
2. **搜索不进侧栏**，用顶部搜索框（`#q`）直接搜
3. B 站从「单独一个入口」拆成一组平级子页：**推荐**、**榜单**
4. 搜索页内 tab：**全部 / 网易云 / B 站**；B 站 tab 内再分 **曲目 / UP 主**

## 现有代码锚点（不要猜，按实际读到的改）

- `app/renderer/main.html`
  - 第 22-26 行：`<nav class="htabs">`（发现 / 搜索 / 本地 三个顶部标签）
  - 第 27 行：`<input id="q" class="search-box" placeholder="搜索曲目、歌手、歌单">`
  - 第 30 行附近：`<div class="huser" id="user">未登录</div>`
  - 第 46 行起：`<nav class="sidebar">`，含 `nav-g "在线"`、B 站按钮（`data-view="bili"`，在第一期已加到「在线」组里）
  - 第 93 行：`<section class="view" data-page="search">`，内部 `#search-list`
  - 第 105 行附近：`<section class="view" data-page="bili">`（现有 B 站单页）
- `app/renderer/js/app.js`：`data-view` 路由、`#q` 搜索键盘事件、`playTrack`
- `app/renderer/js/bili.js`：现有 B 站页逻辑（榜单、BV 解析、登录弹窗）
- 网易云搜索：`app/renderer/js/api.js` 的 `search(keywords, type, limit, offset)`，`type=1` 单曲、`type=100` 歌手
- B 站搜索后端已就绪：`window.yw.bili.searchVideo(keyword, page)` / `searchUser(keyword, page)`（preload 已暴露）

## 要做的

### 1. 侧栏（`main.html`）

- `nav-g "在线"` → `nav-g "网易云"`
- 把现有的单个 `data-view="bili"` 按钮替换成一组：
  ```html
  <div class="nav-g">B 站</div>
  <button class="nav-i" data-view="bili-recommend">推荐</button>
  <button class="nav-i" data-view="bili-rank">榜单</button>
  ```
- 位置：仍在「网易云」组之后、「我的」组之前

### 2. 页面拆分

- 现有 `data-page="bili"` 拆成两页：
  - `data-page="bili-recommend"`：调 `region/feed/rcmd` 拿音乐区推荐（后端需新增，见第 5 条）
  - `data-page="bili-rank"`：现有榜单逻辑原样搬过来
- 两页共用一个「B 站页头」（标题 + 账号状态 + 登录按钮），可以抽成一个函数渲染，不要复制两份 HTML

### 3. 搜索页改造（`data-page="search"`）

- 顶部加 tab 行：`全部 / 网易云 / B 站`（样式参照 `docs/layout-phase1.html` 的 `.tabs/.tab`，用现有 CSS 变量，不要新配色）
- `全部`：两个源并行请求，结果混排，每条带来源标签（`网易云` / `B 站`）
- `网易云`：只调 `api.search`
- `B 站`：内部再分 `曲目 / UP 主` 两个小 tab，分别调 `searchVideo` / `searchUser`
- 顶部 `#q` 回车 → 切到 search 页并触发搜索（保持现有行为，若已存在就沿用）
- 空关键词不请求；请求期间显示「搜索中…」；单源失败不影响另一源（分别 try/catch，失败的那一块显示错误文案）

### 4. B 站曲目行

沿用现有 B 站榜单行样式；搜索结果里的视频行要能直接点播（复用现有 `window.YW.bili.resolve` 那套下载+播放链路，不要另写一份）。

### 5. 后端：B 站音乐区推荐

在 `app/bili/api.js` 增加：

```js
async function recommendRegion({ count = 15 } = {})
// GET https://api.bilibili.com/x/web-interface/region/feed/rcmd
//   ?display_id=1&request_cnt=<count>&from_region=1003&device=web&plat=30
// 返回 [{ bvid, title, cover, artist, duration }]
```

已实测：这个接口**免签名、免登录**即可 `code:0`，返回 15 条音乐区内容；但返回字段里 **没有 `tid`/`owner`**，UP 主名和时长需要按实际情况取（先打印一条原始 JSON 看清字段再实现，不要猜字段名）。

`app/main.js` 加 IPC `bili:recommend`，`preload.js` 暴露 `recommend`。

## 硬约束

- **不改** `engine/audio.js`、`engine/index.js`
- **不改** 网易云 `api.js` 的任何现有函数（只调用）
- 不引入新依赖、不引入新字体/新配色，沿用现有 CSS 变量与黑金风格
- 不要从开源项目复制代码
- 中文注释，风格与现有代码一致

## 验收（我会自己跑）

1. `node tools/bili-probe.js --recommend` → 打印推荐 15 条（若你加了该参数）
2. `npx electron .` 启动无报错；侧栏能看到「网易云 / B 站（推荐·榜单）」
3. 顶部搜索框输入「起风了」回车 → 搜索页出现结果，三个 tab 都能切
4. B 站 tab → 曲目有结果、UP 主有结果
5. 点一条 B 站结果能正常播放（走现有下载链路）
6. `git diff --stat engine/` 为空

## 报告

- 改了哪些文件、各多少行
- 第 5 条接口的**原始 JSON 字段**（贴一条真实返回，说明你从哪取 artist/duration）
- 踩到的坑
