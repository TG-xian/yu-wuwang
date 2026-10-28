# 任务：为「豫 · 无妄」画 README 用的系统架构分解图

## 目标

产出一个**单文件 HTML**（内联 SVG，无外链、无 JS），放进 `docs/` 供 README 引用；
最终我会用浏览器截图转成 PNG 挂到 README。图要让人一眼看出：
**这个播放器的数据从哪来、经过哪些进程、最后怎么以 ASIO 独占输出**。

## 视觉基调（硬性）

⚠️ 这个项目的 UI 是**黑金**风格，图必须跟它一致，**不要用默认的深蓝+青绿科技风**：

- 背景：`#0a0a0c`（近黑），叠 40px 细网格 `#17171b`（stroke-width 0.5）
- 主色（强调/高亮/播放链路）：金色 `#c9a227`
- 次要文字：`#7a7a82`；正文：`#b8b8be`；标题白 `#f0f0f2`
- 分组容器：填充 `rgba(201,162,39,0.05)`，描边 `rgba(201,162,39,0.28)`，虚线 `6,4`，`rx=12`
- 节点卡片：**双层矩形**（先画不透明底 `#0f0f12`，再叠半透明填充），`rx=6`，1.5px 描边
- 字体：`"JetBrains Mono", "Cascadia Mono", Consolas, monospace`
  （中文回退 `"Microsoft YaHei", sans-serif`，用 `font-family` 列表即可）
- 字号：节点名 12px、副标题 9px、注释 8px

## 必须画出的内容（这是本项目的真实结构，别自己编）

### 三个进程 / 一个渲染层

1. **渲染层（Renderer）** — UI：发现 / 搜索 / 本地 / B 站推荐 / B 站榜单 / 播放页
2. **主进程（Main）** — 窗口、IPC、托盘、拉起两个子进程、B 站直连、缓存管理
3. **引擎子进程（engine/）** — BASS 解码 + ASIO 独占输出，WebSocket `47800`
4. **取流服务子进程（NeteaseCloudMusicApi）** — HTTP `127.0.0.1:3000`

### 两条音源链路（要画出区别，这是重点）

- **网易云**：渲染层 → 主进程 → 取流服务(3000) → cloudmusic API → **直链** →
  引擎 `BASS_StreamCreateURL` **流式播放**（不落盘）→ ASIO
- **B 站**：主进程直接请求 `api.bilibili.com`（带 `Referer` + `User-Agent`，搜索走 WBI 签名）→
  `playurl` 拿 DASH 音频（最高 30251 Hi-Res）→ **下载到 `userData/bili-cache`** →
  引擎 `BASS_StreamCreateFile` 播放 → ASIO
  ⚠️ 用不同颜色（比如金色 vs 淡青）区分这两条链路，并在图注里写清「B 站为何要落盘」
  （fMP4 让 `StreamCreateURL` 报 err=41，只能下载后播）

### 歌词链路（次要，画细线即可）

`主进程 → 网易云歌词 / LRCLIB → 渲染层`（双源打分匹配）

### 输出端

`引擎 → BASS → ASIO 独占 → 声卡`，旁边标注「源采样率匹配，不重采样（44.1k/48k/96k/192k 直通）」

## 布局要求

- 画布建议 `1440×900` 左右（`viewBox="0 0 1440 900"`），横向铺开，从「音源」在左、「ASIO」在右
- 箭头**先画**（在节点之前），这样不会压住卡片
- 图例放在所有分组框之外的下方，至少留 20px
- 每条链路上标注关键参数，例如 `fnval=4048`、`qualityId 30251`、`deadline 120min`、`WS 47800`

## 交付

- 文件：`C:/Users/tianz/Program/yu-wuwang/docs/architecture.html`
- 页面结构：顶部标题区（项目名 + 一句话副标题）→ 中间大 SVG → 下方 3 张摘要卡片
  （分别讲：三进程模型 / 两条音源链路 / 直通不重采样）
- **不要外链字体以外的任何资源**；Google Fonts 可以引，但要有本地字体回退

## 约束

- 不要改项目任何其他文件，不要 git commit
- 不要动 `engine/` 目录
- 完成后把 HTML 的绝对路径和一段结构说明贴出来
