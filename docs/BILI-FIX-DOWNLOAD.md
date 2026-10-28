# 修复：B 站音源改为「下载到本地缓存再播」

## 现象（已实测，2026-10-28）

用户播 B 站榜单时大量报 `err=41`。

- `41` = **BASS_ERROR_FILEFORM（不支持的格式）**，不是解码器问题（装了官方 bass_aac 也一样）。
- 榜单前 10 个视频 × 三档实测：**17 成功 / 12 失败**，失败是「整个视频的所有档位一起失败」，与 codec（`mp4a.40.2` / `mp4a.40.5`）、与 `Content-Type`（`video/mp4` 也会挂）都无关。
- 把失败视频的音频**完整下载**后用 `BASS_StreamCreateFile` 打开：**全部成功**，`freq=44100/48000`、长度正确。
- 甚至**只保留前 1MB** 的文件，`StreamCreateFile` 也能正常建流并算出总长度（MP4 的 moov 在文件头）。

结论：`BASS_StreamCreateURL` 对这种 fMP4 流不可靠，**本地文件模式没问题**。所以改成先下载再播（同 NaivG/bilimusic 的做法，它是被同一个坑逼的）。

## 要改的

### 1. `app/bili/api.js`

新增：

```js
async function downloadAudio(bvid, opts = {})
// opts: { sessdata, cid, page, qualityId, onProgress }
// 返回 { path, qualityId, qualityLabel, bytes, fromCache }
```

- 内部先调现有 `getPlayUrl(bvid, opts)` 拿到 `{ url, headers, qualityId, deadline }`
- **缓存目录**：`path.join(app.getPath('userData'), 'bili-cache')`（Electron 不可用时回退到 `os.tmpdir()/yu-wuwang-bili-cache`，让 `tools/bili-probe.js` 在纯 node 下也能跑）
- **缓存文件名**：`${bvid}_${cid}_q${qualityId}.m4a`；文件已存在且 `size > 0` → 直接返回 `fromCache: true`（直链过期不影响缓存命中的播放；但 `force: true` 时重下）
- 下载：Node `fetch`，带 `Referer: https://www.bilibili.com` 与浏览器 UA（用模块里已有的 `UA`/`REFERER` 常量）；边下边写到 `<name>.part`，完成后 rename 成正式名，避免半截文件被当成完整缓存
- 下载失败/大小为 0 → 抛 `biliError('DOWNLOAD_FAILED', ...)`
- `onProgress` 可选，回调 `(received, total)`，用于 UI 显示「缓冲中」

新增缓存清理（在模块里导出，主进程启动时调一次）：

```js
function pruneCache({ maxBytes = 800 * 1024 * 1024, maxAgeDays = 7 } = {})
```
- 先删超过 `maxAgeDays` 的；再按「总大小超 `maxBytes` 时从最旧的删」

### 2. `app/main.js`

- `bili:playurl` 改为返回 `{ path, qualityId, qualityLabel, bytes, fromCache }`（内部调 `downloadAudio`）
  - 因为下载可能耗时数秒，**保持 IPC 不超时**即可；不需要额外进度通道（第一版）
- 启动时调一次 `pruneCache()`

### 3. `app/renderer/js/bili.js` / `app.js`

- `window.YW.bili.resolve(track)` 现在应返回 `{ source: <本地文件路径>, qualityId, qualityLabel }`
  - **`source` 不再拼 `\r\nReferer...` 头**，直接是本地路径（引擎会走 `StreamCreateFile` 分支）
- 取流期间状态文案改成「B 站缓冲中…」（下载可能 1–4 秒；24MB 的长音频约 3 秒）
- 播放页音质标识逻辑不变

## 硬约束

- **不要改** `engine/audio.js`、`engine/index.js`（本地路径本来就走 `StreamCreateFile`）
- 不要改网易云路径
- 不引入新依赖
- 不要从开源项目复制代码

## 验收（我会自己跑）

1. `node tools/bili-probe.js BV11eZ8Y5EVi --download` → 打印缓存路径、大小、耗时，且第二次调用命中缓存（`fromCache: true`）
2. `node tools/bili-probe.js BV1MXZJYpEuN --download` → 同上
3. 三条之前失败的视频（`BV11eZ8Y5EVi`、`BV1MXZJYpEuN`、`BV1DDZHYhE59`）都能拿到本地文件
4. 我再用 engine 的 WS 发 `load <本地路径>` 做端到端播放验证
