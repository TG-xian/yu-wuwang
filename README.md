# 豫 · 无妄

网易云音乐桌面播放器。黑金视觉，**ASIO 独占 + 源采样率匹配**，不重采样。

名字取自六十四卦的「豫」与「无妄」，共用「震」爻，叠合为九爻印——也是应用图标。

## 功能

**播放**

- ASIO 独占输出（Windows），CoreAudio hog mode（macOS）
- 源采样率匹配，不做任何重采样；速率不符时直接报错而不是偷偷转换
- BASS 解码，FLAC / WAV / MP3 / APE / OGG / AIFF / DSF / DFF
- 黑胶拟物播放页：唱片、唱臂、底盘、换碟动画
- 上一曲 / 下一曲、随机 / 列表 / 单曲循环
- 直链失效自动重取并跳回原位

**在线（网易云）**

- 扫码登录（应用内出二维码）
- 搜索、每日推荐、私人漫游、排行榜
- 我喜欢的音乐、自己创建与收藏的歌单（侧栏）
- 歌词：原文 + 译文 + 粤拼/罗马音（用网易云自带的 `romalrc` 轨）
- 真无损体检：按码率体积标出「无损 / 偏低 / 疑似转码」

**本地**

- 多目录音乐库，可添加 / 移除 / 拖拽加入
- 元数据（时长、采样率、位深、标签）与内嵌封面
- 支持 `.m3u` / `.m3u8` / `.pls` 播放列表

## 平台

| 平台 | 状态 | 独占方式 |
|---|---|---|
| Windows 11 | 已验证 | ASIO（`bassasio.dll`） |
| macOS | **代码就绪，未在真机验证** | CoreAudio hog mode（`BASS_DEVICE_HOG`） |

macOS 版的实现已经完成，但没有在 Mac 上跑过。打包与验证方式见 [`docs/BUILD.md`](docs/BUILD.md)。

## 安装

从 [Releases](../../releases) 下载：

- **Windows**：`YuWuwang Setup x.y.z.exe`，双击安装
- **macOS**：`YuWuwang-x.y.z.dmg`

安装包**没有代码签名**，所以：

- Windows 会弹「未知发布者」→ 点「更多信息」→「仍要运行」
- macOS 首次打开要右键「打开」，或执行 `xattr -cr /Applications/YuWuwang.app`

## 开发

```bash
npm install
npm run dev
```

需要 Node 20+。音频引擎（`engine/`）和取流服务（`NeteaseCloudMusicApi`）由主进程以子进程方式拉起，用 Electron 自带二进制当 Node 跑。

## 打包

```bash
npm run dist        # Windows 安装包
npm run pack        # Windows 免安装版（快，用于验证）
npm run dist:mac    # macOS dmg（只能在 mac 上执行）
```

细节与踩过的坑见 [`docs/BUILD.md`](docs/BUILD.md)。

## 致谢与许可

音频引擎用 [BASS](https://www.un4seen.com/)（un4seen developments）。个人非商用免费，商用需购买授权。

取流层用 [NeteaseCloudMusicApi](https://github.com/Binaryify/NeteaseCloudMusicApi)（已归档）。

本项目仅供学习交流，不对第三方服务的可用性做任何保证。

**关于账号**：取流走官方接口，需要使用者自己的登录态；项目**不包含**任何破解、绕过付费或下载功能。
