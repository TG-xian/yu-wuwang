# 豫 · 无妄 — 架构文档

> 版本 v0.1-draft ｜ 2026-10-22
> 对应设计稿：`final-pages.html`（主页/播放页）、`splash.html`（开机画面）、`logo-9yao.html`（标识）

---

## 0. 一句话

一个 Windows 优先的网易云桌面播放器：**取流交给外部 API 服务，播放与界面全部自研**，核心卖点是真无损（SQ FLAC）、ASIO 独占 bit-perfect、黑金拟物界面。

---

## 1. 范围与明确不做的事

### 做

| 能力 | v0.1 |
|---|---|
| 扫码登录网易云 | ✅ |
| 搜索（单曲/歌手/专辑/歌单） | ✅ |
| 歌单详情与播放 | ✅ |
| 播放页（拟物唱机 + 滚动歌词） | ✅ |
| ASIO 独占 / WASAPI 独占 | ✅ |
| 采样率跟随、bit-perfect 通路 | ✅ |
| 每日推荐 | M4 |
| 我的音乐 / 我喜欢的 | M4 |
| 本地音乐页（系统音乐文件夹 + 自选目录） | M3 |
| 全局媒体键（播放/暂停/上下曲） | M5 |
| 真无损体检（只标记，不拦截） | M4 |

### 不做

| 项 | 原因 |
|---|---|
| 取流层（任何 API 请求实现） | 本人不写；由你本机运行现成服务，播放器只按契约调用 `127.0.0.1:3000` |
| 歌曲下载到本地 | 会员下载文件加密，下了也播不了，无意义 |
| 社交（评论/关注/动态/私信） | 你的明确要求 |
| 播客 / 视频 / 直播 / 云盘 | 不在范围 |
| 逐字歌词 | 网易云接口给逐行，逐字需额外对齐，你已确认只要逐行 |
| 「臻品母带」等 AI 升频档 | 正是你要避开的东西，`jymaster` / `sky` 一律不请求 |

---

## 2. 技术选型

| 层 | 选择 | 理由 | 备选与被否原因 |
|---|---|---|---|
| 界面 | **Electron**（Chromium + Node） | 设计稿是 HTML/CSS，可直接落地；跨平台成熟；媒体键、托盘、多窗口生态全 | Tauri：体积小但要重写界面且 WebView 各平台不一致；PyQt：重画设计稿成本高 |
| 播放内核 | **BASS 2.4 + BASSASIO**（非商用免费） | 预编译 DLL，不碰 ASIO SDK 许可、不染 GPL；自带 FLAC/APE/ALAC/DSD 解码与 ASIO host | PortAudio：ASIO 要自编译 + SDK；直接调 ASIO SDK：host 全自己写，成本高十倍 |
| FFI | **koffi**（Node） | 现代 FFI，Win/macOS/Linux 同一套 API，无需编译原生模块 | ffi-napi：维护停滞、Node 22 兼容差 |
| 进程间通信 | **本地 WebSocket（ws）**，仅绑 `127.0.0.1` | 引擎可独立测试、跨语言可替换；JSON 协议好调试 | Node IPC：绑死在 Electron 主进程，失去独立进程的意义 |
| 存储 | **SQLite**（better-sqlite3） | 设置、播放历史、收藏缓存、歌词缓存；同步 API 简单 | JSON 文件：并发写会坏 |
| 打包 | electron-builder | Win 出 portable + nsis；macOS 出 dmg（二期） | — |

**关键约束：BASS 是原生库，跑在渲染进程会拖垮 UI 且崩溃无法隔离 —— 所以必须独立进程。**

---

## 3. 进程结构

```
┌─────────────────────────────────────────────┐
│ Electron 主进程 (main.js)                    │
│  · 窗口、托盘、全局快捷键、SMTC 媒体控制      │
│  · 生命周期：拉起/守护 engine 进程            │
└───────────────┬─────────────────────────────┘
                │
     ┌──────────┴───────────┐
     │                      │
┌────▼─────────────┐  ┌─────▼──────────────────┐
│ 渲染进程 (UI)     │  │ 引擎进程 (engine/)      │
│  · 设计稿落地      │  │  · BASS 初始化/解码     │
│  · 视图与交互      │◄─┤  · ASIO / WASAPI 输出   │
│  · 不碰音频        │ws│  · 播放状态机           │
└──────────────────┘  │  · 采样率切换           │
                      └─────┬──────────────────┘
                            │
     ┌──────────────────────┴───────────────────┐
     │ 外部取流服务 NeteaseCloudMusicApi:3000    │
     │ （你自己启动；本架构不实现、不打包）        │
     └──────────────────────────────────────────┘
```

**守护规则**
- UI 启动 → 拉起 engine → 等 `ready` 握手（超时 8s 报错）
- engine 崩溃 → UI 捕获 exit → 自动重启最多 3 次 → 仍失败则弹「音频引擎不可用」，界面仍可浏览
- UI 关闭 → 发 `shutdown` → engine 释放设备后退出；10s 未退则强杀
- **engine 退出必须释放 ASIO 设备**，否则下次启动会拿不到声卡（ASIO 单客户端）

---

## 4. 模块划分

```
app/
  main.js              窗口/托盘/快捷键/引擎守护
  preload.js           contextBridge 白名单 IPC
  renderer/
    index.html         主页
    player.html        播放页（可独立窗口）
    splash.html        开机画面
    css/  tokens.css   黑金变量、九爻印组件
    js/
      api.js           取流服务客户端（唯一出网点）
      store.js         本地状态（UI 侧）
      views/           主页/搜索/歌单/播放页
      components/      唱片/歌词/进度条/音质徽章
engine/
  index.js             WS 服务 + 命令分发
  bass.js              koffi 绑定：BASS_* 全量封装
  output/
    asio.js            Windows: BASSASIO 链路
    wasapi.js          Windows: WASAPI 独占/共享
    coreaudio.js       macOS: 二期
  decoder.js           文件/URL 播放、采样率跟随
  state.js             播放状态机
  probe.js             真无损体检（解码后走 ffmpeg 或 BASS 解码回调做频谱）
native/
  win32-x64/bass.dll  bassasio.dll  basswasapi.dll  bassflac.dll
  darwin-arm64/libbass.dylib        （二期）
docs/
  ARCH.md   UI/（设计稿副本）
```

---

## 5. 取流层接口契约

播放器**只认一个 base URL**（默认 `http://127.0.0.1:3000`），全部端点来自 `NeteaseCloudMusicApi@4.32.0`。

### 5.1 登录（扫码）

| 步骤 | 请求 | 说明 |
|---|---|---|
| 1 | `GET /login/qr/key?timestamp=<ms>` | 返回 `data.unikey` |
| 2 | `GET /login/qr/create?key=<key>&qrimg=true&timestamp=<ms>` | 返回 `data.qrimg`（base64）与 `data.qrurl` |
| 3 | 轮询 `GET /login/qr/check?key=<key>&timestamp=<ms>` | `code`：800 过期 / 801 待扫 / 802 已扫待确认 / **803 成功** |
| 4 | `GET /login/status` 或 `/user/account` | 拿 `profile.userId`、`nickname`、`avatarUrl` |

**cookie 归属**：由服务自己维护（它内部存 cookie jar）。播放器**不接触、不保存、不打印** `MUSIC_U`。退出登录调用 `/logout`。

### 5.2 内容

| 用途 | 端点 | 关键参数 |
|---|---|---|
| 搜索 | `/search` 或 `/cloudsearch` | `keywords`, `type=1\|100\|10\|1000`, `limit`, `offset` |
| 歌曲详情 | `/song/detail` | `ids=1,2,3` |
| 播放地址 | **`/song/url/v1`** | `id`, **`level=lossless`**（写死，不暴露其他档） |
| 歌词 | `/lyric` | `id` → `lrc.lyric`（逐行） |
| 每日推荐 | `/recommend/songs` | 需登录 |
| 推荐歌单 | `/personalized` | `limit` |
| 歌单详情 | `/playlist/detail` | `id` |
| 歌单曲目 | `/playlist/track/all` | `id`, `limit`, `offset` |
| 喜欢列表 | `/likelist` | `uid` |
| 喜欢/取消 | `/like` | `id`, `like=true\|false` |

### 5.3 三条硬规则

1. **`level` 只发 `lossless`**。`jymaster`（超清母带）、`sky`（沉浸环绕声）、`hires` 本版不发——前者是你不要的 AI 升频，后者无实测保障。
2. **播放地址必须校验**：返回 `url` 为空 / `.mp3` / `br < 700000` ⇒ 判为「无权益或降级」，UI 在该曲打「非无损」标并降级提示，**不静默播 mp3 冒充无损**。
3. **地址有有效期**（`expiration` 字段，通常几分钟）。播放前请求、不预取、不缓存直链；缓存只存 `id`。

---

## 6. 播放引擎

### 6.1 Windows：三条输出链路

| 模式 | 实现 | bit-perfect 条件 |
|---|---|---|
| **ASIO 独占**（默认首选） | `BASS_ASIO_Init(device)` → `BASS_ASIO_SetRate(源采样率)` → `BASS_ASIO_ChannelSetFormat` → `BASS_ASIO_ChannelEnableBASS` | `BASS_ATTRIB_VOL = 1.0`、无 BASS_FX/DSP、`SetRate` 成功（失败说明驱动不支持该率，**不得回落 ChannelSetRate**，那等于重采样） |
| **WASAPI 独占** | `basswasapi` 或 BASS 内建独占 | 独占格式由设备支持性探测，不支持则报错并建议换率或换共享 |
| **WASAPI 共享**（兜底） | BASS 默认 | 不保证 bit-perfect，UI 显示「共享模式」黄标 |

**设备释放**：暂停超过 30s 或停止时释放设备（ASIO 单客户端，长期占用会让浏览器/会议软件失声）。这是「记住上次选择」之外必须有的一条策略。

### 6.2 macOS（二期，未验证）

- 无 ASIO。CoreAudio 下 BASS 直接输出；bit-perfect 需设备采样率与源一致，通过 `BASS_Init` 的精确格式与系统音频设备格式设置配合。
- **本机无 Mac，无法验证。** Mac 版在拿到真机前只承诺「能出声」，不承诺 bit-perfect。

### 6.3 采样率跟随

每首歌开始前：读解码流的 `freq` → 与设备当前率比对 → 不同则切设备率 → 切换成功后 `Play`。
**切换期间静音 30–80ms**，避免爆音（宁可短暂静音也不要 pop）。

### 6.4 音量

数字衰减，BASS 的 `BASS_ATTRIB_VOL` 在**非 1.0 时破坏 bit-perfect**——所以：
- 默认让 BASS 音量固定 1.0，音量由 ASIO/WASAPI 的通道增益控制（BASSASIO 提供 `ChannelSetVolume`）
- 若目标设备不支持通道增益，则接受「软件音量 = 非 bit-perfect」并在 UI 明示

> 这条与「ASIO 独占必须 bit-perfect」直接冲突，实装时二选一，我倾向前者并把选择权放进设置。

---

## 7. 播放状态机

```
        ┌─────────┐
        │  IDLE   │
        └────┬────┘
      load   │
        ┌────▼────┐   url 失败 / 解码失败
        │ LOADING ├──────────────► ERROR ──retry──► LOADING
        └────┬────┘
      ready  │
        ┌────▼────┐
        │  READY  │◄──────────────┐
        └────┬────┘               │
      play   │                    │ seek 完成
        ┌────▼────┐   pause   ┌───┴─────┐
        │ PLAYING │◄─────────►│ PAUSED  │
        └────┬────┘           └─────────┘
      stop   │
        ┌────▼────┐
        │ STOPPED │ ──release device──► IDLE
        └─────────┘
```

**状态事件**（engine → UI，JSON over WS）：
```json
{"ev":"state","state":"PLAYING","track":123,"pos":12.34,"dur":311.2,
 "fmt":{"rate":44100,"bits":16,"ch":2},
 "out":{"mode":"asio","device":"Donner USB Audio Device","bitperfect":true}}
```

**UI → engine 命令**：`load` / `play` / `pause` / `stop` / `seek` / `volume` / `setOutput` / `probe`

---

## 8. 数据与存储

| 表 | 字段 | 说明 |
|---|---|---|
| `settings` | key, value | 输出设备、模式、音量、窗口位置、关闭行为、歌词偏移 |
| `history` | track_id, played_at, ms_played | 本地播放历史（不上传） |
| `tracks_cache` | id, name, artists, album, cover_url, dur, cached_at | 元数据缓存，避免每次列表都请求详情 |
| `lyrics_cache` | id, lrc, fetched_at | 歌词缓存 |
| `probe` | track_id, real_flac, bandwidth_hz, checked_at | 真无损体检结果 |

**不存**：cookie、`MUSIC_U`、播放直链。

---

## 9. 目录结构

```
C:\Users\tianz\Program\yu-wuwang\
  package.json
  electron-builder.yml
  app/            Electron 主进程 + 渲染层
  engine/         播放引擎（独立进程）
  native/         二进制（按平台分目录）
  docs/           ARCH.md、设计稿
  tools/          体检/探针脚本
  release/        打包产物
```

---

## 10. 跨平台策略

**Windows 是一等公民，macOS 是二期。**

| 项 | Windows | macOS |
|---|---|---|
| 输出 | ASIO / WASAPI 独占 / 共享 | CoreAudio |
| bit-perfect | 承诺（ASIO 且条件满足时） | 不承诺 |
| 系统媒体控制 | SMTC + 全局快捷键 | MPNowPlayingInfoCenter（二期） |
| 打包 | portable + nsis | dmg（需真机签名/未签名绕过 Gatekeeper） |
| 验证 | 本机可测 | **本机不可测，需朋友实机反馈** |

给朋友的 Mac 版在 M6 再说，且明确告知：**未签名应用首次打开需右键→打开**。

---

## 11. 验收判据（v0.1 必须全绿）

| # | 判据 | 验证方式 |
|---|---|---|
| 1 | 扫码登录成功，拿到 `uid` | 界面显示昵称头像 |
| 2 | 搜索「周杰伦」返回 ≥ 20 条 | 结果列表非空且可滚动 |
| 3 | 请求 `level=lossless` 返回 `.flac` | 日志打印 url 后缀与 `br` |
| 4 | 播放时引擎报告 `rate=44100, bits=16` | state 事件 |
| 5 | ASIO 独占下 `bitperfect=true` | state 事件 + 手动确认其他程序无声 |
| 6 | 暂停 30s 后设备释放，其他程序恢复出声 | 手动 |
| 7 | 44.1k → 48k 切歌不爆音 | 连续切 10 首无异响 |
| 8 | 关闭 UI 后 engine 进程消失 | 任务管理器 |
| 9 | 返回 mp3 的曲目被标「非无损」而非静默播放 | 找一首无版权曲验证 |
| 10 | 引擎崩溃自动重启，UI 不白屏 | 手动 kill engine |

---

## 12. 里程碑

| 里程碑 | 内容 | 可验收产物 |
|---|---|---|
| **M1 骨架** | Electron 空窗 + engine 拉起 + WS 握手 | 打印 `ready`，两边能互发心跳 |
| **M2 出声** | BASS 播本地 FLAC + ASIO 输出 | 你的 16 个 FLAC 能播，ASIO 独占生效 |
| **M3 取流** | 扫码登录 + 搜索 + 播在线曲 | 网上搜一首 SQ 曲并出声 |
| **M4 界面** | 设计稿落地：主页/搜索/歌单/播放页 + 开机画面 | 截图与设计稿一致 |
| **M5 打磨** | 歌词滚动、媒体键、托盘、每日推荐、体检 | 全判据绿 |
| **M6 Mac** | 跨平台构建 + 朋友实测 | 能出声（不承诺 bit-perfect） |
| **M7 发布** | GitHub Actions 双平台打包 + Release | ✅ [v0.1.0](https://github.com/TG-xian/yu-wuwang/releases/tag/v0.1.0) 已发布 |

> **当前进度与待办见 [HANDOFF.md](HANDOFF.md)**（这份是稳定架构，那份是易变状态）。
> Windows 已完整可用；macOS 代码就绪、CI 能出 dmg，但**未在真机运行过**，且设备选择菜单在 mac 上会导致静音。

---

## 13. 已知风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 取流服务归档（2024-02），接口签名可能失效 | 全盘不可用 | M3 第一件事就是打通 `/search` + `/song/url/v1`；不通则换 fork（musiche / YesPlayMusic 同源依赖） |
| 账号风控/封禁 | 你的会员号 | 已确认自担。控制请求频率（搜索/详情加 200ms 节流），不批量抓取 |
| ASIO 驱动 bug 崩引擎 | 播放中断 | 双进程隔离 + 自动重启；buffer 从 256 起调 |
| 返回 mp3 冒充无损 | 违背产品核心 | 强制校验 `br` 与后缀，不静默降级 |
| 直链过期 | 播放中途失败 | 播放前请求；失败重取一次 |
| 高采样率文件在 ASIO 下不支持 | 无法播放 | `SetRate` 失败即报错并提示切 WASAPI，**绝不偷偷重采样** |
| Mac 端无法验证 | 交付即盲盒 | 明确告知，M6 单独排期 |
| Electron 体积 150MB+ | 你已接受 | portable 打包 |

---

## 14. 下一步（M1 具体动作）

1. 建目录 `C:\Users\tianz\Program\yu-wuwang\`
2. `npm init` + 装 `electron`、`ws`、`koffi`、`better-sqlite3`
3. 写 `engine/index.js`：WS 服务 + 心跳 + `ping/pong`
4. 写 `app/main.js`：窗口 + 拉起 engine + 握手
5. 验收：启动出窗口，控制台打印 `engine ready`

M1 不碰音频、不碰网络，纯链路验证。

---

## 15. 实施记录（2026-10-22 夜）

| 里程碑 | 状态 | 证据 |
|---|---|---|
| M1 骨架 | ✅ | `[engine] ready pid=… port=47800` + `[main] handshake ok` + WS ESTABLISHED |
| M2 出声 | ✅ | 48 kHz FLAC → ASIO index 0 (Donner)，播放位置与墙钟同步、CPU 0%、播完释放；**用户人耳确认** |
| M3 取流 | ✅ | 扫码登录（读账号 uid / vipType 110）→ 搜索 278 条 → `level=lossless` 5/5 全 flac（**魔数 `fLaC` 验证**，CDN 的 `Content-Type: audio/mpeg` 是假 MIME）→ BASS 播网络流，源 24bit/44.1k，ASIO 由 48k 自动切 44.1k |
| M4 界面 | ✅ 骨架 | `main.html` + `app.css` + `js/logo.js` + `js/app.js`；主页与播放页均经 headless 1280×800 截图验证 |
| M5 打磨 | 🟡 进行中 | ✅ 歌词解析+跟随滚动（`parseLrc`）、✅ 主页真实推荐歌单（`/personalized`）、✅ 每日推荐页（`/recommend/songs`）、✅ 本地音乐页（主进程扫系统音乐文件夹，实测 55 个文件）<br>⬜ 全局媒体键、托盘、真无损体检、私人漫游 |
| M6 Mac | ⬜ | 需真机 |

### M2 踩的四个坑（都已在代码注释里标明）

1. **`BASS_ASIO_DEVICEINFO.name` 在 x64 DLL 里读出的是堆地址**（`0x0001FB…`），koffi 与 PowerShell P/Invoke 结果一致 → 不是 FFI 问题。
   对策：**设备名从 `HKLM\SOFTWARE\ASIO` 注册表读**；用驱动版本 `0x500` 与 Donner 驱动 `5.0.0.15510` 交叉验证索引 0 正确。
2. **`BASS_ASIO_SetRate(double)` / `BASS_ASIO_GetRate() → double`**。用 uint32 传 48000 时，x64 浮点参数走 XMM 寄存器，驱动收到垃圾（err=37）。
3. **`SetRate` 必须在 `ChannelEnableBASS` 之后**（官方 `contest.c` 顺序：Init → Enable → SetRate → Start）。
4. **中文/日文文件名打不开**（err=2 FILEOPEN）：仅设 `BASS_CONFIG_UNICODE(42)` 无效，必须**路径转 UTF-16LE + `BASS_UNICODE(0x80000000)` 标志**。

### 目录实况

```
app/main.js          Electron 主进程（拉起/守护引擎、IPC）
app/preload.js       contextBridge 白名单
app/renderer/        main.html · app.css · js/{logo,api,app}.js
engine/index.js      WS 服务 + 心跳（M2 起接 BASS）
native/win32-x64/    bass.dll · bassflac.dll · bassasio.dll
tools/               probe-bass.js · probe-asio2.js · play-test.js · shot-window.ps1
```

### 下次开工第一件事

M3 联调：在项目内装 `NeteaseCloudMusicApi@4.32.0` 并起服务 → 扫码登录 → `/cloudsearch` → `/song/url/v1?level=lossless` → 用 `BASS_StreamCreateURL` 播网络流（FLAC 直链）。
注意：网络流同样需要 `BASS_UNICODE` 之外的 URL 处理；先在 ASCII URL 上验证通路。
