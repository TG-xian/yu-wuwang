# 交接：豫 · 无妄

> 写给下一个接手这个项目的会话。读完这份就能接上，不必翻历史。
> 最后更新：2026-10-28（新增 B 站音源第一版；mac 真机仍未验证）

---

## 一句话现状

Windows 版**已完成并发布**（v0.1.0，实测可用）。
macOS 版已完成「开箱即用」改造：默认共享输出（装上就有声）、动态设备菜单（共享 / 共享·跟随采样率 / 声卡独占 三档）、独占与 follow 失败自动回落、外接声卡提示。
**仍未在真机运行过**——改造只做到静态正确 + Windows 回归通过，见下面「仍未验证」。

mac 打包只出 **arm64 单包**（朋友是 M 系）。要出 Intel 版改 `package.json` 的 `build.mac.target.arch` 即可。

---

## B 站音源（2026-10-28 新增，第一版）

**做法：下载到本地缓存再播，引擎侧零改动。**

⚠️ 一开始试过「URL 内嵌 `Referer` 头直接播」，单条流能播、能 seek，但**实测 41% 的视频会报 `err=41`**。
`41 = BASS_ERROR_FILEFORM`：`BASS_StreamCreateURL` 对这批 fMP4 解析不可靠，与 codec、`Content-Type`、`BASS_STREAM_BLOCK` 均无关；
同一份数据**下载成本地文件后 `StreamCreateFile` 100% 成功**（只保留前 1MB 也能建流）。
NaivG/bilimusic 要"下载到临时缓存再播"正是被同一个坑逼的。

所以：`app/bili/api.js` 的 `downloadAudio()` 下载到 `userData/bili-cache/<bvid>_<cid>_q<qid>.m4a`，
渲染层拿到本地路径直接 `load`（走 `StreamCreateFile`）。代价是首播缓冲：普通单曲 1–2 秒，80 分钟合集（86MB）约 11 秒。

| 文件 | 作用 |
|---|---|
| `app/bili/api.js`（新增 376 行） | 主进程侧 B 站客户端：buvid、BV 解析、playurl（`fnval=4048`）、榜单、二维码登录、SESSDATA 加密存取 |
| `app/main.js`（+70） | IPC：`bili:ranking` / `bili:info` / `bili:playurl` / `bili:qr-*` / `bili:session-*` |
| `app/renderer/js/bili.js`（新增 288 行） | B 站页：BV 号/链接直查、榜单、二维码登录、音质标识 |
| `app/renderer/main.html` / `app.css` / `app.js` | 侧栏入口、页面容器、样式；`app.js` 只加了接入点 |
| `tools/bili-probe.js`（新增 67 行） | 纯 node 验收探针，不依赖 Electron |

**选档优先级**：`30251`(Hi-Res 无损) → `30280`(192K) → `30232`(132K) → `30216`(64K) → `30250`(杜比)。
杜比是 E-AC-3，BASS 原生不支持、系统解码器也不保证有，所以**垫底**，避免大会员账号反而播不出声。

**验收（2026-10-28，本机实跑）**

- `node tools/bili-probe.js`：buvid + 音乐区榜单 30 条，前 3 与独立实测一致
- `node tools/bili-probe.js BV17VZpY1ENA`：选 30280，`deadline` 剩 119–120 分钟，upos CDN 带 Referer 206 / 不带 403
- 端到端（起 engine + WS 发 `load`/`play`/`seek`）：`load ok`、`freq=44100 ch=2 bits=16`、`dur=14.88s`、`bitperfect=true`、`pos` 每 0.5 秒稳定 +0.5、seek 后继续推进
- 硬约束核查：`engine/audio.js`、`engine/index.js`、`app/renderer/js/api.js` 均未被改动

**仍未验证 / 留待下一版**

1. **Hi-Res 30251 能否播**：需要大会员 `SESSDATA`。它是 MP4 封装的 FLAC，`bassflac` 能不能直接吃没验过；登录后第一件事就是测这个。
2. **关键词搜索未做**：B 站搜索接口要 WBI 签名且容易撞 412，第一版只支持 BV 号/链接与榜单。
3. `b23.tv` 短链不支持（要先跟一次跳转）。
4. 界面两处排版是 Claude Code 看截图修的，**审美尚未经用户确认**。

## 第一期 UI：骨架 + 融合搜索（2026-10-28 完成）

- 侧栏分组「在线」→ **「网易云」**；B 站从单入口拆成 **推荐 / 榜单** 两个平级页
- **搜索不进侧栏**：顶部 `#q` 输入即搜；结果页内 `#search-src` 三 tab：**全部 / 网易云 / B 站**，
  B 站 tab 内再用 `#bili-search-tabs` 分 **曲目 / UP 主**
- 新增 B 站音乐区推荐接口 `recommendRegion()` → `region/feed/rcmd?from_region=1003`（免签免登录）
- B 站搜索已就绪：`searchVideo` / `searchUser`，WBI 签名（口令缓存 6h、并发共用、撞 −352/−412 或 `v_voucher` 重签重试一次）
  - ⚠️ 搜索 cookie 必须 **buvid3 + buvid4 + b_nut** 三件套，只带 buvid3 会返回 `code:0` + 仅 `v_voucher` 无结果
- 「全部」= 两源并行，等两者都回来才渲染（避免结果跳动）；单源失败显示红字不影响另一源

**验收（本机 CDP 实跑）**：侧栏结构正确、推荐 15 行、榜单 30 行、全部模式混排 50 行（网易云 31 + B 站 20）、
B 站曲目 20 / UP 主 20、点 B 站结果播出 `B 站 · 192K · 48.0 kHz / 16 bit`、渲染层 0 错误、`engine/` 未改动。

**已知未做**：UP 主卡片点击无跳转（等第三期做 UP 主页）；手动 SESSDATA 输入框只在榜单页、BV 输入框只在推荐页。

## 第二期：歌词匹配 + 点歌词跳转（2026-10-28 完成）

- 新增 `app/bili/lyrics.js`（346 行）：B 站歌自动匹配歌词，**网易云 + LRCLIB 双源**并行
- 匹配策略：关键词 `标题 + UP主`（不清洗）→ 时长差 >4s 淘汰 → 字符 2-gram Dice 算标题相似度 →
  `标题×0.5 + 歌手×0.5` → 标题分 <30 扣 35 分 → 总分 <55 不接受 → 有时间轴的优先
  - 额外两条实测补丁：**LRCLIB 用原始长标题搜不到，要先抽「歌名 歌手」再搜**；
    **B 站 UP 主常是搬运号不是歌手**，所以歌手要从标题里抽
- 缓存 `userData/bili-lyrics/<bvid>[_pN].json`；失败冷却 3 分钟；LRCLIB 常回 503，重试一次
- IPC `bili:lyrics`；渲染层 `loadLyricBili()` 走「歌词匹配中…」→ 填入现有歌词区（复用三轨结构）
- **点歌词跳转（全局）**：播放页任意歌词行可点 → seek 到该行时间；点击时 +20ms 避免高亮回跳

**验收（本机）**：`--lyrics` 首次 1505ms 匹配 `ne「起风了」冯沁苑分数=100 / 70 行带时间轴`，二次 3ms 命中缓存；
冷门视频返回 `ok=false reason=没有候选过线` 且不报错；UI 实测 71 行歌词、点第 8 行「不禁笑这近乡情怯」→
播放位置跳到 `0:40 / 5:26`；渲染层 0 异常。

**注意**：首次匹配可能要 6 秒（本地网易云搜索 + 3 个候选取词），期间显示「歌词匹配中…」。

## 标题清洗 + 播放页限行（2026-10-28）

新增 `app/renderer/js/title-clean.js`（`window.YW.title.clean`），`main.html` 里在 `bili.js` 之前加载。

- **保守策略**：括号内按 `／ / · ・ | ｜ ， 、 ； ： :` 切段，一段要**同时**满足「命中关键词」且「去掉关键词+填充字后不剩内容」才删。
  段里只要还有歌手名、"原创"之类真实内容就整段保留 —— 宁可留噪音，不削歌名。
- 关键词：视频元信息（中字/字幕/pv/官方mv/mv/本家/熟肉/生肉/自译/自翻/自制/转载/搬运/翻唱/cover/4k/1080p/720p/60fps/高清/无水印/完整版/现场/直播/剪辑/混剪/合集/歌单/循环）
  + 音质词（无损/hi-res/杜比/dolby/atmos/全景声/母带/flac/320k/dsd/空间音频/高音质）
  + 填充字（版本/音质/双语/官方/完整/超/高/无/的/附/带/纯数字）
- 英文关键词整词匹配（`mv` 不命中 `MVP`），中文子串匹配；括号外的正文一律不动（防误伤 `Video Games`）
- `toTrack`：`t`=清洗后、`tRaw`=原文；`bili.title` 保持原文（歌词匹配依赖它）
- 列表行与 `#pl-title` 都加 `title="原文"` 悬停看原文；`#pl-title` 用 `-webkit-line-clamp:2` 限行两行

**验收**：6 个用例（含 `Video Games` 原样返回、`【乐正绫原创】潮起时【官方MV】`→`【乐正绫原创】潮起时`、`MVP (Live/现场版)`→`MVP (Live)`）；
播放页实测 `titleRect.h=114`、歌词区 `y=164` 在视口内、71 行歌词正常。

**已知**：`【无损音质】《起风了》…"起风了，也让我想起了那年夏天"` 清洗后仍有 32 字——结尾引号文案在括号外，按规则保留。

## 歌词匹配率修复（2026-10-28，37% → 83%）

用户反馈「B 站好多歌暂无歌词」。用 24 条完整歌曲（2–8 分钟）做基线：**原 9/24 → 现 20/24**。
诊断脚本：`%TEMP%` 之外另存 `<hermes scratch>/diag_lyrics2.js` 那份可直接复用（搜 6 个关键词 × 取完整时长）。

改的都是 `app/bili/lyrics.js`：

1. **搜索关键词**：从「原始长标题 + UP主」改为抽取的「歌名 歌手」（`parseBiliTitle().keyword`），抽不出才退回原文。
   实测原关键词会把相关候选挤掉（《夜曲》长标题搜回说唱 beat）。UP 主不再拼进关键词（多为搬运号）。
2. **分隔符补中文竖线 `丨`**：原来只有全角 `｜`，`周杰伦丨百万级录音棚试听丨` 整段被当成歌手名。
3. **`names` 分支修正**：无书名号时前两段都当候选歌名（原来第二段永远进 artists，「晴天」被漏掉）；
   有书名号时其余当歌手。
4. **标题相似度加「包含关系」**：候选歌名整体出现在标题片段里直接给 90 分（短标题对长片段用 Dice 会被长度差拖死）。
5. **歌手分为 0 时不拉低总分**（改由标题×0.9 主导）：B 站标题常没有歌手名。
6. **时长**：硬淘汰 4s → 20s；10–20 秒打 8 折。
7. **LRCLIB**：503/429 重试 3 次（600/1500/3000ms）—— 周杰伦等网易云无版权的歌全靠它。
8. **LRCLIB 备用搜索词**：改为「各段首词」（`夜曲 MV 2160P修复版` → `夜曲`），原来拼出 `周杰伦 周杰伦` 搜回不相干的歌。
9. 失败时返回 `candidates`（top3 含标题分/歌手分/淘汰原因），便于诊断与将来的「手动选歌词」。

**已知未解决**：`【4K修复】周杰伦 - 夜曲 MV 2160P修复版 新专辑`(232s) 仍匹配到 lrclib「最伟大的作品」且评分为 100，
与手工算分对不上，根因未查明（怀疑 `pick.title` 与打分用的字段不一致）。属于误匹配，优先级高于「暂无歌词」。

## 第三期 A：UP 主页 + 合集页（2026-10-28 部分完成）

- **合集页 ✅ 可用**：`view` 接口的 `ugc_season` 扁平化所有 `sections[].episodes[]`，按 BV 去重。
  实测 `--season BV1GJn26BExd` → 「45分钟音乐合集（听完下课）」**276 个视频**，标题/封面/时长正确。
- **UP 主页 ⚠️ 代码完成但拿不到数据**：`/x/space/wbi/arc/search` 与 `/x/space/wbi/acc/info`
  在**未登录**状态下稳定返回 `-352 / HTTP 412`（"风控校验失败"），重签一次无效。
  推测需要 `SESSDATA` 登录态（B 站对 space 接口的限制比搜索严得多）。
- 行内入口、分页、返回导航已接；`--user-videos` / `--season` 探针可用；`engine/` 未改。
- 详细证据：`docs/PHASE3A-REPORT.md`

**登录后实测（2026-10-28，SESSDATA 有效、大会员 TG_xian）**：
- `space` 接口的 `-352/412` 是**概率性风控**，登录不能豁免，但重试能过。
- 已加 `withRiskRetry()`：**4 次**，间隔 **1.5 / 4 / 6.5 秒**（+0~600ms 抖动）。
  - 关键经验：间隔太密（试过 5 次挤在 2.5 秒内）会一直落在风控惩罚窗口内，全被拒；
    拉到秒级以上就明显好转。
- 用户实测 10 个 UP 主：**9 个自动通过，1 个仍需手点「重试」一次**。
- **结论：接受现状，不再加复杂度**（用户 2026-10-28 决定）。

**Hi-Res 30251 已验证可用**（这是第一期以来的悬案，至此关闭）：
```
取流 BV1Qyt6zQEG9 档位=30251 84.8MB → asio ready 96000Hz/2ch
```
普通档位是 48kHz，Hi-Res 升到 96kHz，证明拿到的是真无损轨且 BASS 能解码。

## 仓库与产物

| 项 | 位置 |
|---|---|
| 项目 | `C:\Users\tianz\Program\yu-wuwang` |
| 仓库 | https://github.com/TG-xian/yu-wuwang （public） |
| Release | https://github.com/TG-xian/yu-wuwang/releases/tag/v0.1.0 |
| CI | GitHub Actions，workflow 名「打包」，手动触发或推 `v*` tag |

**发布流程**（已跑通，改完代码约 6 分钟出新包）：

```bash
git add -A && git commit -m "..." && git push
git tag v0.1.1 && git push origin v0.1.1     # tag 自动触发打包 + 创建 Release
```

⚠️ 本地 `gh` token 需要 `workflow` scope 才能推 `.github/workflows/`（已配好）。

---

## 已完成并验证

**播放**

- BASS 解码 + ASIO 独占（Windows），源采样率匹配、不重采样
- 黑胶拟物播放页：唱片、唱臂、底盘、换碟动画（`.disc-wrap` 管位移 / `.disc` 管旋转，两层拆开）
- 上一曲 / 下一曲 / 随机 / 列表 / 单曲循环
- 直链失效自愈：3 秒位置不动 → 重取 → 跳回原位（`checkStall` / `healCurrent`）
- 真无损体检：按码率体积标 `无损 / 偏低 / 疑似转码`

**在线**

- 扫码登录（应用内点昵称出二维码，`code=803` 时 cookie 落盘）
- 搜索、每日推荐、私人漫游、排行榜、歌单（含侧栏「我的歌单」）
- 歌词三轨：`lrc` + `tlyric`（按时间戳 ±0.3s 对齐）+ `romalrc`（粤拼/罗马音，**用网易云原生轨，不要自己算**）

**本地**

- 多目录音乐库：添加 / 移除 / 拖拽加入，配置在 `%APPDATA%\yu-wuwang\library.json`
- 元数据缓存（路径 + mtime），启动后预扫一次，平时进本地页走快照
- m3u / m3u8 / pls 播放列表，「全部」标签可切回全库

**界面**

- 无边框窗口 + 自定义窗口按钮（`.wc`，36px 宽、16px 圆角图标）
- 托盘（关窗口不退出）
- 九爻印：`app/renderer/js/logo.js`（SVG）+ `tools/make-icon.py`（PNG/ICO）**两份独立几何，改一处要同步另一处**

---

## macOS 版的真实差距 ★

**这是本次交接最重要的一节。**

### 基础（v0.1.0 已有）

- `engine/audio.js` 平台分支：`IS_WIN` 判断；mac 用 `BASS_DEVICE_HOG`（`bass.h` 第 209 行，已核实）
- `native/darwin/libbass.dylib` + `libbassflac.dylib`（universal binary）
- BASSASIO 在 mac 上为 `null`，所有 ASIO 调用被 `if (a)` 包住
- `build/entitlements.mac.plist`（含 `disable-library-validation`，BASS 预编译库必需）
- `package.json` 的 `build.mac` + `dist:mac` / `pack:mac`
- CI 在 mac runner 上已跑通，能产出 dmg

### 2026-10-23 开箱即用改造

静音的根因不是一个，是四个，全部已修：

| # | 原因 | 位置 | 修法 |
|---|---|---|---|
| 1 | 默认 `outDevice: 0` | `app/renderer/js/app.js` settings | mac 默认 `{outMode:'shared', outDevice:'default'}`，boot 迁移旧值 |
| 2 | 设备 0 在 BASS 里是「No sound」 | `engine/audio.js` `_resolveMacDevice` | `'default'`/0/非法值一律 → **-1**（BASS 惯用法＝系统默认设备），0 显式拦下 |
| 3 | `#out-menu` 写死 Windows 设备 | `main.html` + `renderMacOutMenu` | mac 动态生成三档：「系统默认设备 · 共享」/「系统默认设备 · 共享（跟随采样率）」/ 分隔线 + 每台设备「<名> · 独占」 |
| 4 | hog 被拒直接抛错 | `load()` | 独占失败 → 同设备改共享重试，返回 `degraded:true`，界面说人话 |

其他改动：

- 引擎新增 `listDevices()`（仅 mac，`BASS_GetDeviceInfo` 遍历 1..N；枚举期间临时关 `BASS_CONFIG_UNICODE` 取 UTF-8 名，结束恢复旧值）
- 新增 WS 命令 `devices`
- `_ensureBass()` mac 用 `BASS_Init(-1, …)`
- `snapshot().out`：mac 独占报 `hogRate` + `bitperfect=(hogRate===info.freq)`；共享报 `info.freq`、`bitperfect=false`
- 独占可见性：LED 显示「独占 · 设备名」，首次独占一次性提示「其他程序暂时没声音是正常的」
- 外接声卡提示（**B 方案，不自动切**）：启动后检测到非内置/非蓝牙设备 → toast「检测到 X，要切到独占吗？」→「切换」/「忽略」（记住已忽略的设备名，换新声卡仍提示）
- 拔声卡 / 独占失败 / follow 初始化失败 → 自动回落「系统默认设备 · 共享」并重试一次
- **第三种输出模式 `follow`**（新增，mac 菜单第二项「系统默认设备 · 共享（跟随采样率）」）：共享（不带 HOG，仍经系统混音）+ `BASS_DEVICE_FREQ`，让**设备**跟着源采样率走，而不是让流被重采样；`snapshot().out` 报 `mode:'follow'`、`rate:followRate`、`bitperfect:false`。设备/速率没变时只换流（命中缓存不重开设备）
  - **代价（必须写进说明/告诉用户）**：每切到采样率不同的歌都要改一次设备速率，CoreAudio 会重建 IO —— **其他 App 正在播放的声音会被打断（短暂静音）**；因为仍在系统混音链路里，它不等于 bit-perfect（要 bit-perfect 只有独占）
  - 初始化失败（设备被抢/不支持该速率）→ 自动回落普通共享，返回 `degraded:true` + `followFailed:true`，界面说「不支持跟随采样率，已改用普通共享」
- 托盘：mac `setTemplateImage(true)`（只取 alpha，变单色剪影）
- 退出：`before-quit` 发 `shutdown`（引擎 `BASS_Free` 释放 hog），`will-quit` 强杀兜底孤儿进程
- 打包只出 arm64 单包

### CI 真机上已经验证过的（2026-10-23）

`tools/probe-mac-bass.js` + `.github/workflows/mac-probe.yml` 在 **GitHub 托管的 macOS 虚拟机**（Apple Silicon）上跑过，**三代系统全部通过**：

| runner | 系统 | arch |
|---|---|---|
| macos-14 | macOS 14.8.9 | arm64 |
| macos-15 | macOS 15.7.9 | arm64 |
| macos-26 | macOS 26.6.2 | arm64 |

每代实测输出一致：

```
koffi.load(libbass.dylib) = OK           ← 打包进包 ≠ 运行时可加载，这条最关键
sizeof(BASS_DEVICEINFO) = 24             ← 结构体布局与 Windows 一致
dev=0 name="No sound" flags=0x1          ← 印证「设备 0 = 无声设备」
dev=1 name="Default" flags=0x3 [default]
dev=2 name="Apple Virtual Sound Device" flags=0x3 [default]
dev=3 name="Null Audio Device" flags=0x2000001
BASS_Init(-1, 48000, 0) = OK             ← -1 = 系统默认设备，成立
BASS_Init(-1, 44100, HOG|FREQ) = OK      ← HOG+FREQ 被接受（虚拟设备上）
BASS_Init(1, 48000, HOG|FREQ) = OK
```

所以「dylib 能加载 / 设备能枚举 / -1 能当默认设备」三条已从「理论」变成「实测」。

由这次实测顺带修的两处：

- runner 上 dev1 与 dev2 都带 default 位 → `listDevices()` 只保留第一台的「· 默认」标记
- 占位设备名（`Default` / `Null` / `Virtual`）加进外接声卡提示的排除规则，避免误弹「检测到 Default，要切到独占吗？」

**仍未覆盖**：真实 USB DAC 上的 HOG 成败、系统是否真被独占、拔插、退出释放、UI 渲染与 toast 观感。

### 仍未验证（必须真机）

以上只做了静态检查 + Windows 回归，**mac 一行都没在真机跑过**。按顺序验：

1. 打开应用**直接有声音**（默认共享，不用动任何设置）
2. 设备菜单列出 CoreAudio 设备（名字不乱码、默认设备带「· 默认」）
3. 切「<USB DAC> · 独占」→ 出声；「音频 MIDI 设置」里该 DAC 被独占
4. 44.1k / 48k / 96k 各播一次 → `snapshot().out.rate` 等于源采样率、`bitperfect: true`；再切「系统默认设备 · 共享（跟随采样率）」各播一次 → `rate` 跟着变、`bitperfect: false`，同时开着别的播放器确认它会因设备改速率被打断
5. 独占时切到采样率不同的下一首（会有 0.2–0.5s 静默，属正常）
6. 拔 USB DAC → 自动回「系统默认设备 · 共享」，有提示，不断音
7. 退出应用 → 整机声音恢复正常（hog 已释放）
8. 插 USB DAC 启动 → 出现「检测到 X，要切到独占吗？」；点切换生效、点忽略不再提示
9. 蓝牙耳机 → 不出现独占提示；手动选独占应自动降级到共享
10. 托盘图标为单色（Template），菜单栏不出现彩色方块

### 其他降级项

| 项 | 现状 | 影响 |
|---|---|---|
| 本地元数据 | 依赖 `ffprobe`，mac 默认无 | 时长/位深/封面缺失，**播放不受影响** |
| 窗口按钮 | 在右上角 | mac 用户习惯左上，非标准但可用 |
| 签名公证 | 不做（他朋友能自己点「仍要打开」） | 首次打开被 Gatekeeper 拦，步骤见 `docs/BUILD.md` 与随包说明卡 |

---

## 待办（按优先级）

**P0 — README（用户 2026-10-23 明确：这是第一个面向公众落地的项目，重视）**

- [ ] 重写仓库根 `README.md`：项目简介、功能清单、双平台安装（Windows 安装包 / mac dmg 三步 + 说明卡）、输出模式三档解释、截图、常见问题（Gatekeeper、独占时其他 App 没声音、蓝牙不做独占）
- [ ] 截图要真机截（Windows 已可截；mac 等真机）
- [ ] 法务/免责：数据来自网易云接口、不做破解与下载、BASS 个人非商用授权说明

**P0 — 真机验证（改造已完成，等验证）**

- [ ] 朋友在 M 系 Mac 上按「仍未验证」10 条跑一遍；出问题把 `npm run dev` 的 console 日志发回来
- [ ] 若独占全落到共享，查 `BASS_ErrorGetCode`（常见：hog 被其他 App 占用、设备不支持该速率）

**P1 — 交付**

- [ ] 给朋友的「仍要打开」步骤说明（Gatekeeper；Sequoia 起右键打开已失效）
- [ ] 推 `v0.1.1` 出 arm64 dmg，和说明一起发过去

**P2 — 打磨**

- [ ] `ffprobe` 打包进包，或加降级提示
- [ ] mac 窗口按钮位置（可选）
- [ ] 全局媒体键

**不做**

- QQ 音乐取流（DRM + 协议双重阻断，已论证）
- Hi-Res / 超清母带（本身是 AI 处理，用户明确不要）
- 社交功能

---

## 关键文件

| 文件 | 职责 |
|---|---|
| `app/main.js` | 主进程：spawn 引擎与取流服务、IPC、托盘、无边框窗口、本地库扫描与 `probeAudio`、cookie 读写 |
| `app/preload.js` | `window.yw` 暴露的 IPC（含 `pathForFile` 拖拽、`winControl`） |
| `app/renderer/js/app.js` | 视图切换、播放器状态机、歌词、本地库 UI、扫码登录、`playSeq` 代次、`checkStall` 自愈 |
| `app/renderer/js/api.js` | 取流服务客户端。**全部走 POST JSON body**（cookie 4054 字节编码进 query 会让 URL 超 12KB 触发 Node 请求头上限） |
| `app/renderer/js/logo.js` | 九爻印 SVG 生成器（`std` / `opt` / `plain`） |
| `app/renderer/app.css` | 黑金 tokens、主页扁平、播放页拟物 |
| `engine/audio.js` | BASS + ASIO / hog。平台分支集中在这里 |
| `engine/index.js` | WS 服务（47800）、`caps.exclusive` |
| `tools/make-icon.py` | 生成 `assets/icon-*.png` + `icon.ico` + `icon.png` |
| `tools/test-asio-regress.js` | **Windows ASIO 回归测试**（自带引擎，改引擎后必跑） |
| `tools/test-m3u.js` | m3u 解析验证 |
| `docs/ARCH.md` | 长期架构（进程结构、模块、接口契约、状态机） |
| `docs/BUILD.md` | 打包手册（三平台约束、图标流程、mac 章节、故障排查） |

---

## 常用命令

```bash
# 开发（PTY 后台，日志进 run.log）
npm run dev

# 重启前必须杀掉旧进程，否则 47800 端口被占
powershell -NoProfile -Command "Get-Process electron,YuWuwang -ErrorAction SilentlyContinue | Stop-Process -Force"

# Windows ASIO 回归（改过 engine/ 就跑一次）
node tools/test-asio-regress.js

# 本地打包
npm run dist      # Windows 安装包
npm run pack      # Windows 免安装（快，用于验证）

# 改图标后必须重跑，否则 exe 与托盘图标不更新
py tools/make-icon.py
```

---

## 会再踩的坑

**平台相关**

- `spawn('node', ...)` 打包后 ENOENT → 必须 `spawn(process.execPath, [...], { env: { ELECTRON_RUN_AS_NODE: '1' } })`
- cookie 不能写安装目录（`C:\Program Files` 只读、升级会覆盖）→ 用 `app.getPath('userData')`
- `asar: false`（BASS dll 按真实路径 `LoadLibrary`、取流服务要被 spawn 成真实文件）
- Hermes 后台起 node 子进程会 `stdin is not a tty` → 测试脚本要**自带 spawn**，或用 `pty: true`

**BASS**

- `BASS_ASIO_SetRate` 签名是 `double`（写成 `uint32` 报 err=37）
- ASIO 顺序：`Init → ChannelEnableBASS → SetRate → Start`
- `BASS_ASIO_DEVICEINFO.name` 在 x64 返回堆地址乱码 → Windows 读注册表 `HKLM\SOFTWARE\ASIO`
- 中文路径：`Buffer.from(file + '\0', 'utf16le')` + `BASS_UNICODE(0x80000000)`
- 切歌必须先 `BASS_StreamFree` 旧流，否则新旧叠加 → 音量翻倍削波
- `BASS_GetDeviceInfo` 实测（Windows BASS 同结构同函数）：**dev 0 = "No sound"、dev 1 = "Default"**；flags `0x1`=enabled、`0x2`=default。mac 用 `-1` 表示系统默认设备，**永远别传 0**
- `BASS_DEVICEINFO` 64 位布局：`name@0(8) / driver@8(8) / flags@16(4) + padding`，`sizeof=24, alignof=8`（koffi 实测）
- 枚举设备名要临时 `BASS_SetConfig(42, 0)`（关 UNICODE）拿 UTF-8，结束后用 `BASS_SetConfig` 的返回值恢复旧值

**取流**

- `/login/qr/check` 的 `code` 是 800/801/802/803，**全不是 200** → 不能走统一 `req()` 校验，否则 803 永远拿不到
- cookie 编码进 query 会让 URL 超 12KB → 全走 POST body
- CDN 的 `Content-Type: audio/mpeg` 不可信，FLAC 要看魔数 `66 4c 61 43` = `fLaC`
- 封面 URL 是 `http://`，CSP 只放行 `https:` → 必须替换协议
- `/user/playlist` 里 `specialType === 5` 是「我喜欢的音乐」系统歌单，侧栏要跳过

**前端**

- `switchView` 里每个分支都 `return`，任何全局副作用（如隐藏工具栏）**必须放在第一个 return 之前**，否则是死代码
- 连点切歌用 `playSeq` 代次号作废过期请求
- 歌词回来后要校验 `state.current.id === id`，防止先发后到覆盖
- `replace_all` 对缩进不同的块无效，改完要 grep 复核
- mac「检测到外接声卡」的判定**不能排除当前默认设备**：macOS 插上 USB DAC 会自动把它设为默认，一排除就永远不提示（本次踩过）

---

## 环境与凭据

| 项 | 位置 |
|---|---|
| 登录 cookie | `%APPDATA%\yu-wuwang\.cookie`（打包版）/ 项目根 `.cookie`（开发版），**已在 .gitignore** |
| 本地库配置 | `%APPDATA%\yu-wuwang\library.json` |
| 元数据缓存 | `%APPDATA%\yu-wuwang\library-cache.json` |
| 端口 | 取流服务 3000、引擎 WS 47800 |

**安全**：cookie 绝不打印、不落日志、不进 git；扫码登录时 `MUSIC_U` 只在 `code=803` 那一次响应出现，必须立刻保存。

**依赖漏洞**：`npm audit` 报 17 个（8 高危），几乎全来自 `NeteaseCloudMusicApi` 的传递依赖。**不要跑 `npm audit fix --force`**，会弄坏取流服务。服务只监听 `127.0.0.1`，风险可控。

---

## 下一步建议

1. 推 `v0.1.1` 出 arm64 单包，连同「仍要打开」说明一起给朋友
2. 朋友真机按上面 10 条验，重点前三条：能开、有声、独占生效
3. 出问题先看引擎日志：`[audio] [mac] …` 每行都带 dev / name / hogRate / degraded，一眼能定位是没枚举到设备、还是 hog 被拒
