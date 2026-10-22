# 打包（Windows）

## 一条命令

```bash
cd C:/Users/tianz/Program/yu-wuwang
npm run dist
```

产物：

```
dist/
├── YuWuwang Setup <version>.exe        安装包（NSIS，约 88 MB）
├── YuWuwang Setup <version>.exe.blockmap
└── win-unpacked/YuWuwang.exe           免安装版，可直接双击
```

只想要免安装版（改完代码快速验证，不打安装包，约 75 秒）：

```bash
npm run pack          # = electron-builder --win --dir
```

**打包前先关掉正在运行的应用**，否则 `dist\win-unpacked` 里的 exe 被占用会失败：

```bash
powershell -NoProfile -Command "Get-Process YuWuwang,electron -ErrorAction SilentlyContinue | Stop-Process -Force"
```

---

## 三个必须守住的约束

这三条任意一条破了，打包版就会启动失败或功能残缺，而 `npm run dev` 下一切正常——**开发和打包是两套路径**。

### ① 子进程一律用 `process.execPath` + `ELECTRON_RUN_AS_NODE`

应用要起两个子进程：BASS 引擎（`engine/index.js`）和取流服务（`NeteaseCloudMusicApi/app.js`）。

```js
// 对
spawn(process.execPath, [entry], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PORT: '3000' },
});

// 错：目标机器没装 Node 就 ENOENT
spawn('node', ['app.js'], { cwd: API_DIR });
```

`process.execPath` 在打包后是 `YuWuwang.exe` 自己，`ELECTRON_RUN_AS_NODE=1` 让它以纯 Node 模式跑脚本、不开窗口。

注意传**绝对路径**（`entry`），不要再用 `cwd` + 相对文件名——打包后 cwd 语义会变。

### ② 运行时数据写 `app.getPath('userData')`，不写安装目录

```js
const COOKIE_PATH = () => (app.isPackaged
  ? path.join(app.getPath('userData'), '.cookie')   // %APPDATA%\yu-wuwang\.cookie
  : path.join(__dirname, '..', '.cookie'));         // 开发时留在项目根
```

安装目录可能是 `C:\Program Files`（无写权限），而且升级/重装会整个覆盖掉。凡是「用户产生、要留存」的数据都走 userData：

| 数据 | 位置 |
|---|---|
| 登录 cookie | `%APPDATA%\yu-wuwang\.cookie` |
| 本地音乐内嵌封面缓存 | `%APPDATA%\yu-wuwang\covers\` |
| Chromium 缓存等 | 同目录 |

userData 的真实目录名取自 `package.json` 的 `name`（`yu-wuwang`），**不是** `productName`（`YuWuwang`）——排查时按前者找。

### ③ `asar: false`

```json
"build": { "asar": false }
```

两个原因：

- BASS 的三个 dll（`bass.dll` / `bassflac.dll` / `bassasio.dll`）由 `koffi` 按**真实磁盘路径** `LoadLibrary`，asar 虚拟文件系统里加载不了
- 取流服务要被 `spawn` 成独立进程，同样必须是真实文件

启用 asar 的话得把这两块 `asarUnpack`，还要在代码里把 `app.asar` 路径换成 `app.asar.unpacked`——多一层换算、多一处出错。个人自用直接关掉，代价只是文件可见、体积略大。

electron-builder 会警告 `asar usage is disabled — this is strongly not recommended`，**这条警告可以忽略**。

---

## macOS 打包（代码就绪，未在真机验证）

```bash
npm run pack:mac     # 免安装，先看能不能起
npm run dist:mac     # 出 dmg
```

⚠️ **必须在 macOS 上执行**。Windows 上跑 `--mac` 即使能产出文件，签名和公证也做不了，且无法运行验证。

### 平台差异：独占方式不是同一套

| | Windows | macOS |
|---|---|---|
| 独占机制 | ASIO（Steinberg） | **CoreAudio hog mode** |
| 实现 | `bassasio.dll` 插件 | BASS 原生 flag |
| 关键调用 | `BASS_ASIO_Init` → `ChannelEnableBASS` → `SetRate` → `Start` | `BASS_Init(dev, rate, **BASS_DEVICE_HOG \| BASS_DEVICE_FREQ**)` |
| 流的类型 | 解码流（`BASS_STREAM_DECODE`），由 ASIO 拉数据 | 普通播放流，BASS 自己往设备送 |
| 采样率匹配 | `BASS_ASIO_SetRate(源速率)` | `BASS_DEVICE_FREQ` 把**设备**切到源速率 |

`BASS_DEVICE_HOG = 0x10000` 在 macOS 版 `bass.h` 第 209 行（已下载核实）。

**采样率匹配的关键区别**：Windows 上是"告诉 ASIO 驱动用这个速率"，macOS 上是 `BASS_DEVICE_FREQ` 让 CoreAudio 把设备本身切过去。两者都是**设备跟随流**，不是"流被重采样"——后者的方向搞反就毁了 bit-perfect。

`engine/audio.js` 里的分支靠 `IS_WIN` 判断，macOS 走 `outputMode = 'hog'`。

### 依赖与文件

| 项 | 位置 |
|---|---|
| `libbass.dylib` | `native/darwin/`（874 KB，universal：x86_64 + i386 + arm64） |
| `libbassflac.dylib` | `native/darwin/`（250 KB，同上三架构） |
| BASSASIO | **macOS 没有**，`this.asio = null`，所有 ASIO 调用被 `if (a)` 包住 |

注意 mac 上动态库名带 `lib` 前缀（`libbass.dylib`），代码里用 `LIBP` 变量拼接。

### 签名与公证

`build/entitlements.mac.plist` 已备好，其中 `com.apple.security.cs.disable-library-validation` 是**必需**的——`libbass.dylib` 是 un4seen 的预编译库，没有我们的签名，不关掉库校验会被 Gatekeeper 拦掉。

- **本地自用**：可以不签名，右键「打开」绕过 Gatekeeper
- **给别人用**：需要 Apple Developer 账号（$99/年）+ 公证，否则对方打不开

### 真机验证清单（未做，必须补）

代码写完了，但**没有在 Mac 上跑过**，以下每一条都得实测：

1. `npm run pack:mac` 能起，引擎握手 `caps.exclusive === 'hog'`
2. 播一首歌，**同时**打开「音频 MIDI 设置」→ 看该设备是否被独占（其他 App 无法发声）
3. 44.1k / 48k / 96k 三种文件各播一次，`snapshot().out.rate` 是否等于源采样率
4. `bitperfect` 字段是否为 `true`
5. 暂停 / 恢复 / 切歌后设备是否正常释放（hog 不释放会让系统其他声音全哑）
6. 拔插 USB DAC 后能否恢复
7. 托盘、无边框窗口、拖拽（mac 上是 Finder 拖拽）是否正常
8. `ffprobe` 是否存在（mac 上默认没有，本地音乐元数据会退化）

### 已知未处理

- **设备选择菜单**：`out-menu` 里写死了 Windows 设备名（`ASIO · Donner` 等）。mac 上要用 `BASS_GetDeviceInfo` 动态枚举 CoreAudio 设备（设备名在 mac 上不会乱码，比 Windows ASIO 好办）
- **`ffprobe`**：mac 上需要 `brew install ffmpeg`，否则本地库没有时长/位深
- **`BASS_DEVICE_HOG` 需要设备支持**：虚拟声卡（BlackHole 等）可能拒绝 hog，要能降级到共享模式

---

## 改图标

图标由 `tools/make-icon.py` 生成，**不是**手绘资源，改动要走脚本：

```bash
py tools/make-icon.py         # 重新生成 assets/icon-*.png + icon.ico
npm run dist                  # 再打包，exe 与托盘图标才会更新
```

九爻印的两个几何约束（都踩过）：

- **九爻总高必须 ≤ 框内可用高度**。旧版用 `lw=0.082w / gap=0.045w`，总高算出 `1.098w`，`y` 偏移变负数，最下爻压到框线上。现在取 `9×lw + 8×gap = inner × 0.786`，上下留白各约 `inner × 0.107`。
- **界面内的 SVG 是另一份几何**（`app/renderer/js/logo.js`），`viewBox 96`、外框 `7.5→88.5`、`y0=12.2`。改了一处要记得另一处也对称，否则同一个印记在桌面图标和界面里长得不一样。

像素自检（改完跑一下，确认对称）：

```python
from PIL import Image; import numpy as np
a = np.array(Image.open('assets/icon-256.png').convert('RGBA'))
gold = (a[:,:,0].astype(int) - a[:,:,2].astype(int) > 40) & (a[:,:,0] > 90)
mid = gold[:, 64:192].sum(axis=1)          # 只看中间，避开左右框边
rows = [i for i in range(37, 219) if mid[i] > 3]
print('九爻', rows[0], '~', rows[-1], '| 上留白', rows[0]-37, '下留白', 218-rows[-1])
```

顶部留白与底部留白应相等。

---

## 改版本号

只改 `package.json` 的 `version`，安装包文件名和「添加/删除程序」里的版本都跟着变：

```json
{ "version": "0.1.0" }
```

---

## 安装包没有代码签名

```
Get-AuthenticodeSignature dist\YuWuwang Setup 0.1.0.exe → Status: NotSigned
```

electron-builder 日志里的 `signing with signtool.exe` 是默认流程的空调用，没证书就签不出东西。

后果：双击安装时 Windows SmartScreen 弹「未知发布者」，需要点「更多信息 → 仍要运行」。自己装自己用可以不管；要消掉得买代码签名证书。

---

## 依赖漏洞

`npm audit` 报 17 个（8 高危），**不要跑 `npm audit fix --force`**。

绝大多数的来源是 `NeteaseCloudMusicApi`（已 archived，最后提交 2024-02）的传递依赖：

| 包 | 问题 |
|---|---|
| `basic-ftp` | `Client.list()` 正则回溯 DoS |
| `music-metadata` | ASF 解析器死循环 |
| `get-uri` / `pac-proxy-agent` / `node-forge` | 其余高危 |

强升会把这个服务弄坏，3000 端口的取流整套就废了。

**风险评估**：取流服务只监听 `127.0.0.1`，不对外网暴露；数据入口只有网易云 API 的返回（可信源）。属于「已知不对外网的旧依赖」换「能用的服务」，这个取舍是刻意的。

`electron` / `extract-zip` 的高危是 devDependency，**不进最终产物**。

---

## 产物自检（打完包必查）

```bash
cd dist/win-unpacked
for f in \
  resources/app/native/win32-x64/bass.dll \
  resources/app/native/win32-x64/bassasio.dll \
  resources/app/native/win32-x64/bassflac.dll \
  resources/app/node_modules/NeteaseCloudMusicApi/app.js \
  resources/app/node_modules/koffi \
  resources/app/engine/index.js \
  resources/app/app/main.js \
  resources/app/assets/icon.ico ; do
  [ -e "$f" ] && echo "OK   $f" || echo "MISS $f"
done
```

再启动一次，日志里应该看到这几行（缺任何一条都说明对应环节没通）：

```
[api] 服务就绪
[engine] ready pid=... port=47800
[tray] 已就绪
BOOT_OK 登录态有效 nickname=... uid=...
HOME_OK 推荐歌单 100 个
```

端口自查：

```bash
netstat -ano | grep -E ":3000 |:47800 " | grep LISTENING
```

---

## 已知限制

**本地音乐元数据依赖系统 ffprobe**

`app/main.js` 的 `probeAudio()` 调 `ffprobe`（来自 scoop 装的 ffmpeg）。本机 PATH 里有，没问题；**换一台没装 ffmpeg 的机器**，本地页会退化成只读文件名——时长、位深、采样率、内嵌封面全部拿不到，但播放本身不受影响。

要彻底解决得把 `ffprobe.exe` 打进包（+80 MB），或在 `probeAudio` 里加降级提示。目前未做。

**和开发版并存**

`npm run dev`（项目目录）与装好的版本共用同一个 `%APPDATA%\yu-wuwang\.cookie`，但**端口会冲突**（3000 / 47800），不要同时开。

---

## 配置速查

`package.json` 的 `build` 段：

```json
{
  "appId": "com.tianz.yuwuwang",
  "productName": "YuWuwang",
  "asar": false,
  "directories": { "output": "dist", "buildResources": "assets" },
  "files": [
    "app/**/*", "engine/**/*", "native/**/*",
    "assets/**/*", "tools/**/*", "package.json",
    "!**/*.log", "!tools/*.png"
  ],
  "win": {
    "target": [{ "target": "nsis", "arch": ["x64"] }],
    "icon": "assets/icon.ico"
  },
  "nsis": {
    "oneClick": false,
    "perMachine": false,
    "allowToChangeInstallationDirectory": true,
    "createDesktopShortcut": true,
    "createStartMenuShortcut": true,
    "shortcutName": "豫 · 无妄"
  }
}
```

- `productName: "YuWuwang"` 用英文——中文会进 exe 文件名和安装路径，容易出编码问题
- `shortcutName` 保留中文，用户看到的快捷方式是「豫 · 无妄」
- `perMachine: false` 装到 `%LOCALAPPDATA%\Programs\YuWuwang`，不需要管理员权限
