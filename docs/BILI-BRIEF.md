# 任务：豫·无妄 接入 B 站音源（第一版最小可用）

## 背景

Electron 播放器。渲染层在 `app/renderer/`，播放引擎是独立进程 `engine/`（WS 47800）。

播放链路：

```
renderer  eng.send({ cmd:'load', source, deviceIndex, mode })
   → engine/index.js  case 'load': engine.load(msg.source, ...)
   → engine/audio.js  _createStream(source)
        source 以 http(s) 开头 → BASS_StreamCreateURL
        否则 → BASS_StreamCreateFile（本地文件）
```

现有音源是网易云，走本机 `127.0.0.1:3000` 的 NeteaseCloudMusicApi（`app/renderer/js/api.js`）。

## 目标（第一版）

1. 新增 B 站音源：输入 BV 号或 B 站视频链接 → 取音频直链 → 用现有引擎播放
2. 音乐区排行榜列表（免登录即可看，点开就播）
3. B 站登录页：二维码扫码拿 SESSDATA，用于解锁 Hi-Res(30251)
4. 设置里可手动粘贴 SESSDATA，作为扫码失败时的兜底

## 已实测的技术事实（按这个实现，不要自己猜）

1. **取流**
   `GET https://api.bilibili.com/x/player/playurl?bvid=<bv>&cid=<cid>&fnval=4048&fnver=0&fourk=1`
   - 不需要 WBI 签名、不需要登录（带 buvid3 更稳）
   - **必须**带 `Referer: https://www.bilibili.com` 与浏览器 UA，否则 upos CDN 返回 403（只有 mcdn 节点不校验，不能依赖）
2. **拿 cid**
   `GET https://api.bilibili.com/x/web-interface/view?bvid=<bv>` → `data.cid`、`data.pages[]`
3. **排行榜（免登录）**
   `GET https://api.bilibili.com/x/web-interface/ranking/v2?rid=3&type=all`（rid=3 是音乐区）
4. **dash 结构**
   - 标准三档在 `data.dash.audio[]`：`30216`(64K HE-AAC) / `30232`(132K) / `30280`(192K)
   - Hi-Res 在 `data.dash.flac`（未登录为 `null`；大会员登录后是对象，内层字段可能叫 `dash` 也可能叫 `audio`，两种都判）
   - 杜比在 `data.dash.dolby`
   - 每条流有 `baseUrl` 与 `backupUrl[]`
   - **数组顺序不保证，必须按 id 匹配，不能按下标取**
5. **直链有效期**
   URL 带 `deadline=<unix秒>` 参数，实测 120 分钟。播放前若 `deadline - now < 300` 秒，视为过期需重取
6. **播放加头（关键：引擎零改动）**
   把请求头拼进 source 字符串即可：
   ```js
   source = `${url}\r\nReferer: https://www.bilibili.com\r\nUser-Agent: ${UA}\r\n`
   ```
   已实测 BASS 能解析这种内嵌头，且能建流、能拿长度、能 seek（seek 后要等 200ms 级缓冲，立刻读会得 0 字节）
7. **buvid3**
   `GET https://api.bilibili.com/x/frontend/finger/spi` → `data.b_3`
8. **二维码登录**
   - 生成：`GET https://passport.bilibili.com/x/passport-login/web/qrcode/generate` → `data.url`（要转成二维码图）、`data.qrcode_key`
   - 轮询：`GET https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=<key>`
     外层 `code:0`，内层 `data.code`：`86101` 未扫码 / `86090` 已扫码待确认 / `0` 登录成功
   - 成功时的 cookie 从 poll 响应里取（`data.url` 的 query 里有 `SESSDATA` 等字段，或看响应 `Set-Cookie`）

## 实现要求

### 1. 新增 `app/bili/api.js`（主进程侧 Node 模块，CommonJS）

- `getBuvid()`：取并缓存 buvid3（进程内）
- `parseInput(text)`：从输入里提取 BV 号，支持 `BV1xx411c7mD`、`https://www.bilibili.com/video/BV.../?p=2`；解析不出返回 null
- `getInfo(bvid)`：`{ bvid, title, cover, artist, duration, cid, pages }`
- `getPlayUrl(bvid, { sessdata })`：`{ url, headers:{Referer, 'User-Agent'}, qualityId, deadline, backups:[...] }`
  选档优先级：`30251`(Hi-Res) → `30250`(杜比) → `30280` → `30232` → `30216`
- `ranking()`：音乐区榜单前 30，元素 `{ bvid, title, cover, artist, duration }`
- `qrGenerate()` / `qrPoll(key)`：二维码登录，`qrGenerate` 返回 `{ url, key, qrDataUrl }`（用 `require('qrcode').toDataURL`）
- `saveSession(cookieObj)` / `loadSession()` / `clearSession()`：
  - 用 Electron `safeStorage.encryptString` 加密后写 `app.getPath('userData')/bili-session.bin`
  - `safeStorage.isEncryptionAvailable()` 为 false 时不落盘，返回明确提示
  - 只在主进程内调用（safeStorage 必须在 app ready 之后）
- 所有网络请求用 Node 内置 `https` 或 `fetch`（Node 22 自带 fetch），统一设 `Referer` + UA；超时 15 秒；失败抛出带 code 的错误

### 2. 改 `app/main.js`：注册 IPC（照现有 `ipcMain.handle` 风格）

- `bili:ranking`、`bili:info`、`bili:playurl`
- `bili:qr-generate`、`bili:qr-poll`
- `bili:session-get`（返回 `{ loggedIn, hasSessdata, member? }`，不返回 cookie 明文）、`bili:session-save`、`bili:session-clear`

### 3. 新增 `app/renderer/js/bili.js`

IIFE，风格照 `app/renderer/js/api.js`：

- 搜索框：输入 BV 号/链接 → 查详情 → 展示一张曲目卡 →「播放」按钮
- 榜单列表：加载 `bili:ranking`，点击即播
- 播放：调 `bili:playurl` 拿 `url` + `headers`，拼成带内嵌头的 source，然后
  `eng.send({cmd:'load', source, deviceIndex, mode})` 再 `{cmd:'play'}`
  —— 复用现有 `app.js` 里已有的播放/状态逻辑，不要另起一套引擎连接
- 登录态：显示「未登录 / 已登录（大会员）」+ 登录按钮 → 弹二维码面板，2 秒轮询，成功后关闭并刷新状态
- 音质标识：播放时把命中的 `qualityId` 显示出来（30251 显示「Hi-Res 无损」、30280 显示「192K」…）

### 4. 改 `app/renderer/index.html`

侧栏加「B 站」入口（与现有页签同风格）+ 页面容器。

### 5. 改 `app/renderer/app.css`

沿用现有 CSS 变量与黑金拟物风格，不引入新字体、新配色。

### 6. 新增 `tools/bili-probe.js`

纯 node 跑（不依赖 Electron），用于验收：

```
node tools/bili-probe.js                      # 打印 buvid + 榜单前 3
node tools/bili-probe.js BV17VZpY1ENA         # 打印该 BV 的选中档位 / deadline 剩余 / CDN host
node tools/bili-probe.js --qr                 # 打印二维码 key（验证接口通）
```

注意：`app/bili/api.js` 里引用 `electron` 的代码要能容忍「不在 Electron 里运行」（probe 直接在 node 里跑）。建议把 safeStorage 相关逻辑做成 lazy require 或 try/catch 后降级。

## 硬约束

- **不要改** `engine/audio.js`、`engine/index.js`
- **不要改** `app/renderer/js/api.js` 里现有网易云的任何函数
- **不许**从任何开源项目复制代码（尤其 AGPL/GPL 的 B 站播放器：NaivG/bilimusic、SaiErOscar/BiliMusic、zsakvo/BiliMusic、HanversionOvO/BiliMusic）。接口 URL、参数名、字段名这些协议事实可以照用，实现必须自己写
- 不引入新的 npm 依赖；`qrcode` 已在 node_modules，需要时显式加进 package.json 的 dependencies
- 注释用中文，简短，说明「为什么」而不是「做了什么」，风格与现有代码一致
- 不写测试框架，验收就用 `tools/bili-probe.js`

## 验收标准（我自己会跑）

1. `node tools/bili-probe.js` 能打印 buvid 与榜单前 3 条标题
2. `node tools/bili-probe.js BV17VZpY1ENA` 打印 qualityId（未登录应为 30280 或 30232）、deadline 剩余分钟、CDN host
3. `node -e "require('./app/bili/api.js')"` 无语法错误
4. `npx electron .` 能启动、无控制台报错（B 站页面能渲染出来）

## 完成后报告

- 改了哪些文件、各多少行
- `tools/bili-probe.js` 的实际输出原文
- 踩到的坑（CORS、safeStorage 时序、dash 结构差异等）
