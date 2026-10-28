# 第一期后端：B 站 WBI 关键词搜索

## 目标

在 `app/bili/api.js` 增加：

1. `searchVideo(keyword, { page })` —— 视频搜索
2. `searchUser(keyword, { page })` —— UP 主搜索
3. 通过 `app/main.js` 暴露 IPC：`bili:search-video` / `bili:search-user`
4. `tools/bili-probe.js` 增加 `--search <关键词>` 与 `--search-user <关键词>`

**只做后端，不要动任何 HTML/CSS/渲染层。** 界面那部分我会在结构确认后单独派。

## 已实测事实

- `/x/web-interface/search/type` **不签名直调会被风控**，返回 HTML 错误页（不是 JSON）
- `nav` 接口未登录也能调，返回 `data.wbi_img.img_url` / `data.wbi_img.sub_url`
- 搜索接口的 WBI 版路径是 `/x/web-interface/wbi/search/type`
- 参数 `search_type`：`video`（视频/歌曲）、`bili_user`（UP 主）
- 风控错误码：`-352`、`-412`（HTTP 412）——需要**刷新口令后重签重试一次**

## WBI 签名（公开算法规范，自己实现）

1. `GET https://api.bilibili.com/x/web-interface/nav` → 取 `wbi_img.img_url`、`wbi_img.sub_url`
2. 从每个 URL 取文件名（`/bfs/wbi/7cd084941338484aae1ad9425b84077c.png` → `7cd084941338484aae1ad9425b84077c`）
3. `mixinKey = (img_key + sub_key)` 按 **mixinKeyEncTab** 重排后取前 32 个字符
4. 参数处理：加 `wts`（unix 秒）→ 按 key 升序排序 → 每个 value 过滤掉 `!'()*` 字符 → 拼成 query string
5. `w_rid = md5(query + mixinKey)`

**硬要求**：`mixinKeyEncTab` 那 64 个数字**必须从公开规范核对**（B 站 API 文档项目 bilibili-API-collect 的 wbi 章节），不许凭记忆写、不许编。在代码注释里注明来源 URL。写完请在 probe 里验证签名有效（能拿到 `code:0` 的 JSON 而不是 HTML）。

## 实现要求

- 口令缓存 **6 小时**（`wts` 有效期是每日更替，缓存 6 小时足够安全）；并发时共享同一次 `nav` 请求（in-flight 去重）
- 撞 `-352` / `-412` → `invalidate()` 清口令 → 重签重试**一次**；仍失败就抛错，不要循环
- 搜索请求带 `buvid3`（模块里已有 `getBuvid()`）+ `Referer` + 浏览器 UA
- 返回结构统一成：
  ```js
  // searchVideo
  [{ bvid, title, cover, artist, duration, play, danmaku }]
  // searchUser
  [{ mid, name, face, sign, videos, fans }]
  ```
  - **标题里的 `<em class="keyword">` 高亮标签要剥掉**
  - 封面 URL 可能以 `//` 开头，补 `https:`
  - `duration` 是 `"mm:ss"` 字符串，转成秒
- 失败时抛 `biliError(...)`，沿用模块里现有的错误风格
- 不引入新依赖

## 硬约束

- 不要改 `engine/`、网易云路径、渲染层（html/css/renderer js）
- 不要从开源项目复制代码；接口与参数是公开事实，实现自己写
- 注释中文，简短

## 验收（我会自己跑）

1. `node tools/bili-probe.js --search 起风了` → 打印前 5 条（bvid + 标题 + UP主 + 时长），且是真实结果
2. `node tools/bili-probe.js --search-user 买辣椒也用券` → 打印前 5 个 UP 主
3. 连续调用 3 次不同关键词，不报风控（验证口令缓存与补签逻辑）
4. `node -e "require('./app/bili/api.js')"` 无语法错误
