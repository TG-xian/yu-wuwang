# 交接：豫 · 无妄

> 写给下一个接手这个项目的会话。读完这份就能接上，不必翻历史。
> 最后更新：2026-10-23（M1–M5 完成、Windows 版已发布、mac 版代码就绪未验证）

---

## 一句话现状

Windows 版**已完成并发布**（GitHub Release v0.1.0，功能完整、实测可用）。
macOS 版**代码就绪但从未在真机运行过**，且已知有一处会让用户静音的 bug。

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

### 已完成

- `engine/audio.js` 平台分支：`IS_WIN` 判断，mac 走 `outputMode = 'hog'`
- 独占用 `BASS_Init(dev, rate, BASS_DEVICE_HOG | BASS_DEVICE_FREQ, ...)`
  （`BASS_DEVICE_HOG = 0x10000`，在 macOS 版 `bass.h` 第 209 行，已下载核实）
- `native/darwin/libbass.dylib` + `libbassflac.dylib`（universal binary：x86_64 + i386 + arm64）
- BASSASIO 在 mac 上为 `null`，所有 ASIO 调用被 `if (a)` 包住
- `build/entitlements.mac.plist`（含 `disable-library-validation`，BASS 预编译库必需）
- `package.json` 的 `build.mac` + `dist:mac` / `pack:mac`
- **CI 实测：mac 上 `npm ci` + `npm run dist:mac` 成功产出 arm64 与 x64 两个 dmg**

### 已知 bug（会让用户静音，优先修）

**设备选择菜单是写死的 Windows 设备**（`app/renderer/main.html` 的 `#out-menu`）：

```html
data-mode="asio"   data-dev="0"   ASIO 独占 · Donner
data-mode="asio"   data-dev="1"   ASIO 独占 · Realtek
data-mode="wasapi" data-dev="2"   WASAPI 共享 · Livejack
data-mode="wasapi" data-dev="3"   WASAPI 共享 · Realtek
```

mac 上点击的后果：

| 选项 | 后果 |
|---|---|
| 前两个（asio） | `BASS_Init(0, ...)`，**BASS 设备索引 0 = 无声设备** → 直接没声音 |
| 后两个（wasapi） | 能出声，但走普通初始化，**不是独占**（bit-perfect 丢失） |

**修法**：引擎加 `listDevices()`（按平台：Windows 读注册表 `HKLM\SOFTWARE\ASIO` 拿 ASIO 名，mac 用 `BASS_GetDeviceInfo` 拿 CoreAudio 名）→ 渲染层动态生成菜单项。

**注意**：全项目 `grep GetDeviceInfo` 目前**零结果**，设备列表从未动态枚举过。

### 其他降级项

| 项 | 现状 | 影响 |
|---|---|---|
| 托盘图标 | `.ico` 加载失败后退 `icon-32.png`，但未 `setTemplateImage(true)` | mac 菜单栏里是彩色方块，观感差 |
| 本地元数据 | 依赖 `ffprobe`，mac 默认无 | 时长/位深/封面缺失，**播放不受影响** |
| 窗口按钮 | 在右上角 | mac 用户习惯左上，非标准但可用 |

### 从未验证的（必须真机测）

1. `npm run pack:mac` 能起，握手 `caps.exclusive === 'hog'`
2. 播歌时开「音频 MIDI 设置」，确认设备**真被独占**
3. 44.1k / 48k / 96k 各播一次，`snapshot().out.rate` 是否等于源采样率
4. `bitperfect` 字段是否为 `true`
5. 暂停 / 恢复 / 切歌后设备是否**正常释放**（不释放会让系统其他声音全哑）
6. 拔插 USB DAC 后能否恢复
7. 虚拟声卡（BlackHole 等）拒绝 hog 时能否降级
8. 拖拽（Finder 拖文件夹入窗）

---

## 待办（按优先级）

**P0 — mac 静音 bug**

- [ ] 引擎 `listDevices()` + 渲染层动态设备菜单（见上节修法）

**P1 — 让朋友能测**

- [ ] 托盘 Template 图标（单色 PNG + `setTemplateImage(true)`）
- [ ] 朋友在真 Mac 上跑一遍上节的验证清单

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

1. **先让朋友在真 Mac 上装 v0.1.0 试**，只验证两件事：能不能启动、放歌有没有声音
2. 如果能出声 → 修 P0 的设备菜单 + P1 托盘图标 → 发 v0.1.1
3. 如果出不了声 → 先查 hog 是否被拒绝（`BASS_ErrorGetCode`），可能需要降级到共享模式

**别在没确认「能出声」之前就去修设备菜单**——基础盘不通的话，菜单修了也没意义。
