# 交接：豫 · 无妄

> 写给下一个接手这个项目的会话。读完这份就能接上，不必翻历史。
> 最后更新：2026-10-23（mac「开箱即用」改造完成，v0.1.1 待真机验证）

---

## 一句话现状

Windows 版**已完成并发布**（v0.1.0，实测可用）。
macOS 版已完成「开箱即用」改造：默认共享输出（装上就有声）、动态设备菜单（扬声器共享 / 声卡独占）、独占失败自动回落、外接声卡提示。
**仍未在真机运行过**——改造只做到静态正确 + Windows 回归通过，见下面「仍未验证」。

mac 打包只出 **arm64 单包**（朋友是 M 系）。要出 Intel 版改 `package.json` 的 `build.mac.target.arch` 即可。

---

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
| 3 | `#out-menu` 写死 Windows 设备 | `main.html` + `renderMacOutMenu` | mac 动态生成：首项「扬声器（共享）」，其后每台设备「<名>（独占）」 |
| 4 | hog 被拒直接抛错 | `load()` | 独占失败 → 同设备改共享重试，返回 `degraded:true`，界面说人话 |

其他改动：

- 引擎新增 `listDevices()`（仅 mac，`BASS_GetDeviceInfo` 遍历 1..N；枚举期间临时关 `BASS_CONFIG_UNICODE` 取 UTF-8 名，结束恢复旧值）
- 新增 WS 命令 `devices`
- `_ensureBass()` mac 用 `BASS_Init(-1, …)`
- `snapshot().out`：mac 独占报 `hogRate` + `bitperfect=(hogRate===info.freq)`；共享报 `info.freq`、`bitperfect=false`
- 独占可见性：LED 显示「独占 · 设备名」，首次独占一次性提示「其他程序暂时没声音是正常的」
- 外接声卡提示（**B 方案，不自动切**）：启动后检测到非内置/非蓝牙设备 → toast「检测到 X，要切到独占吗？」→「切换」/「忽略」（记住已忽略的设备名，换新声卡仍提示）
- 拔声卡 / 独占失败 → 自动回落「扬声器（共享）」并重试一次
- 托盘：mac `setTemplateImage(true)`（只取 alpha，变单色剪影）
- 退出：`before-quit` 发 `shutdown`（引擎 `BASS_Free` 释放 hog），`will-quit` 强杀兜底孤儿进程
- 打包只出 arm64 单包

### 仍未验证（必须真机）

以上只做了静态检查 + Windows 回归，**mac 一行都没在真机跑过**。按顺序验：

1. 打开应用**直接有声音**（默认共享，不用动任何设置）
2. 设备菜单列出 CoreAudio 设备（名字不乱码、默认设备带「· 默认」）
3. 切「<USB DAC>（独占）」→ 出声；「音频 MIDI 设置」里该 DAC 被独占
4. 44.1k / 48k / 96k 各播一次 → `snapshot().out.rate` 等于源采样率、`bitperfect: true`
5. 独占时切到采样率不同的下一首（会有 0.2–0.5s 静默，属正常）
6. 拔 USB DAC → 自动回「扬声器（共享）」，有提示，不断音
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
