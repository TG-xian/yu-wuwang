# 第三期 A 实施与验收报告（2026-10-28）

已实现 UP 主主页、合集页、行内入口、IPC 和命令行探针。合集真实数据验证通过；UP 主非空投稿列表因 B 站风控未能验证，不能标为完整实网验收通过。未修改 engine/、网易云 API 文件或依赖，未执行 git commit。

## 接口真实返回

以下片段均来自本次运行，长响应只摘取相关字段，没有用测试数据冒充接口返回。

### 投稿 `/x/space/wbi/arc/search`

`mid=487766154` 返回 HTTP 200，但该账号没有公开投稿：

```json
{"code":0,"message":"OK","ttl":1,"data":{"list":{"slist":null,"tlist":null,"vlist":[]},"page":{"pn":1,"ps":30,"count":0},"is_risk":false,"gaia_res_type":0,"gaia_data":null}}
```

对 `mid=291066884`、`477676711` 的请求返回 HTTP 412，真实 HTML 片段：

```html
<div class="txt-item err-code">错误号: 412</div>
<div class="txt-item err-default">由于触发哔哩哔哩安全风控策略，该次访问请求被拒绝。
```

随后正式探针 `--user-videos 1696279451` 复用现有 WBI 工具（包括三件套 cookie、清口令/指纹后重签一次），最终输出：

```text
失败 [-352] B 站接口 code=-352 · 风控校验失败
```

到此停止投稿接口尝试，没有循环重试。非空 `vlist[]` 的字段映射依据 brief：`bvid/title/pic/author/mid/length/created/typeid`；其中 `length` 经现有 `parseDuration()` 转秒。真实非空列表字段尚未经实网确认。

### 合集 `/x/web-interface/view?bvid=BV1GJn26BExd`

HTTP 200、`code=0`，`data.ugc_season` 摘取：

```json
{
  "id":6362662,
  "title":"45分钟音乐合集（听完下课）",
  "cover":"https://archive.biliimg.com/bfs/archive/7b4ddee0777f4227205ec580bca641b853619355.jpg",
  "mid":1696279451,
  "ep_count":276,
  "sections":[{"title":"正片","episodes":[{
    "bvid":"BV1uVa5zXEyH",
    "cid":32074173077,
    "title":"45分钟马思唯音乐合集（纯享版）",
    "arc":{
      "pic":"http://i0.hdslb.com/bfs/archive/5139d66b805c1dc44306b009bcec255531a6d250.jpg",
      "duration":2650,
      "pubdate":1756693573,
      "author":{"mid":1696279451,"name":"Bobaya6"}
    }
  }]}]
}
```

合集元信息取 `ugc_season.id/title/cover/mid`；视频扁平化所有 `sections[].episodes[]` 并按 BV 去重，封面/时长取 `arc.pic/duration`，作者取 `arc.author.name`。实际解析 276 条。无合集的视频 `BV1ft4y1G7so` 返回中无 `ugc_season`，映射为 null。

### UP 资料 `/x/space/wbi/acc/info?mid=487766154`

首次原始响应 HTTP 200、`code=0` 的 `data` 摘取：

```json
{"mid":487766154,"name":"yxdQ47Aj","face":"http://i0.hdslb.com/bfs/face/member/noface.jpg","sign":"","silence":1}
```

随后通过新 `userProfile()` 验证时，该接口两次均返回以下原始错误字段（初次 + 现有工具允许的一次重签）：

```json
{"code":-352,"message":"风控校验失败"}
```

头像、名字取 `face/name`；acc/info 本身没有粉丝数，实现中另取 `/x/relation/stat` 的 `data.follower`，本轮因 acc/info 风控，未执行到该统计请求，不能声称已验证它。资料失败时页面保留来源行/搜索卡片的名字、头像、粉丝数；未知粉丝数不伪造为 0。

可选 `userSeasons()` 暂返回 []，没有请求合集目录接口。

## 页面与验证

- 原列表的 UP 主名和 UP 搜索卡片可进入主页；投稿分页采用加载更多，失败可手动重试，页码仅成功后推进。
- 榜单/推荐/搜索未提供合集字段时，只补查进入视口的行，最多两路并发，缓存结果；遇到风控停止本会话补查。只有确认有合集才展示标签。
- 合集页显示封面、标题和视频数，所有行复用原 `toTrack → play → playTrack` 接口；行内按钮用捕获事件阻止整行误播放。
- 两个页面都有返回按钮；保留来源页和详情上下文，可以逐级返回搜索、榜单、推荐、UP 页或合集页。
- Electron 隐藏测试窗口使用真实 main.html/preload 和 B 站渲染模块，未连接引擎进行音频操作。UP 投稿用显式测试数据验证分页/返回；合集用真实接口数据。

本轮测试输出：

```text
USER {"view":"bili-user","rows":30,"head":"测试 UP / UP 主 · 123 · 42 粉丝","plays":0}
MORE {"rows":31,"hidden":true,"plays":1}
RETURN_SAME 31
SEASON {"view":"bili-season","rows":276,"head":"45分钟音乐合集（听完下课） / 276 个视频"}
BACK {"view":"bili-user","rows":31,"plays":["BV1000000000","BV1uVa5zXEyH"]}
SOURCE search
PAGES_REQUESTED [1,2,1] ERRORS []
```

`head` 在此将测试输出中的换行改为 `/` 便于阅读，其余字段未改。`plays` 为测试记录的 playTrack 调用，不代表音频已经出声。

6 个相关 JS 文件 `node --check` 均通过；`git diff --check` 通过（仅 CRLF 提示）。`git diff --stat engine/` 和 `git diff --stat app/renderer/js/api.js` 均为空。

真实非空 UP 投稿列表、从该列表及合集页完整下载到出声，仍待风控解除后人工验收。测试没有替换或修改正在运行的播放器/引擎。

## 本次文件变更

工作区开始时已有大量未提交改动和未跟踪文件，下表只统计本次实现的净增行数（修改行另注明），不是对 HEAD 的累计差异。

| 文件 | 本次净增 | 内容 |
|---|---:|---|
| app/bili/api.js | 79 | 用户投稿/资料、合集映射与缓存、mid 元信息、统一风控识别 |
| app/main.js | 3 | 三个 IPC 处理器 |
| app/preload.js | 3 | 三个 IPC 转发 |
| app/renderer/js/bili.js | 160 | 两个详情页控制、返回/分页、行内入口、合集惰性补查；另替换 UP 主行 |
| app/renderer/js/app.js | 4 | 详情视图分支；另替换 UP 卡片和说明各一行 |
| app/renderer/main.html | 14 | 两个详情页容器 |
| app/renderer/app.css | 15 | 详情页与行内按钮样式 |
| tools/bili-probe.js | 12 | --user-videos / --season 及用法说明 |
| docs/PHASE3A-REPORT.md | 本报告 | 真实返回、验证证据与限制 |

命令请使用指定 Node，例如：

```powershell
& 'C:\Users\tianz\AppData\Local\hermes\node\node.exe' tools/bili-probe.js --user-videos 1696279451
& 'C:\Users\tianz\AppData\Local\hermes\node\node.exe' tools/bili-probe.js --season BV1GJn26BExd
```
