# 利阳·随心听 (lx-music-web)

参考 **洛雪音乐 LX Music 移动版 1.9.1** 的音源架构，用纯 Web 技术重写的一版「随机播放热门歌曲」音乐播放器（类似汽水音乐风格）。
后端参考了 LX Music 的酷我(kw) 音源实现，破解并重写了其 `wbd` 加密契约与逐字歌词(lrcx)解码。

## 功能
- 🎲 **随机播放**：从热歌榜随机来一首，自动连播
- 🔍 **搜索**：按歌曲 / 歌手搜索
- 📋 **榜单**：网易云官方 65 个榜单（飙升 / 新歌 / 原创 / 热歌 / 古典 / 电音 / 说唱 …）
- 💿 **全屏播放器**：模糊封面背景 + 旋转黑胶 + 歌词 + 进度拖拽 + 上一首/下一首 + 随机/顺序切换
- 📱 **移动端优先**：手机浏览器竖屏体验最佳，底部迷你播放器
- 🎵 **洛雪音源管理**：内置洛雪自定义源脚本运行时，可**导入任意洛雪源脚本**扩展取址能力；每个音源都能**一键测试**取址是否可用，脚本可**删除**

## 目录结构
```
lx-music-web/
├── server.js            # 纯 Node 后端（零 npm 依赖）：音源 API + 媒体代理 + 音源编排
├── lxsource.js          # 洛雪自定义源脚本运行时（vm 沙箱 + lx.request/utils 桥接）
├── sources/             # 内置洛雪源脚本（lx-music-source.js，官方 5 源：kw/kg/tx/wy/mg）
├── data/sources/        # 用户导入的洛雪源脚本（docker volume 持久化）
├── web/                 # 前端（原生 HTML/CSS/JS，无构建步骤）
│   ├── index.html
│   ├── style.css
│   └── app.js
├── test/
│   └── frontend.test.js # 前端渲染冒烟测试（jsdom，仅开发期依赖）
├── package.json         # 仅用于跑测试；后端本身零运行时依赖
├── Dockerfile
├── docker-compose.yml
└── README.md
```

## 本地运行（开发 / 验证）
```bash
cd lx-music-web
node server.js          # 默认端口 3005
# 浏览器打开 http://localhost:3005
```
> 后端会自动识别 `HTTPS_PROXY` 环境变量：有代理则「直连优先、失败回退代理」，无代理则纯直连（路由器上即如此）。
> 静态资源设置了 `no-cache`，**没有 Service Worker 缓存陷阱**，改完前端刷新即更新。
> `index.html` 用 `app.js?v=版本号` 做缓存击穿，改前端后**递增版本号**，浏览器必定拉新文件。

## 前端渲染冒烟测试（重要）
```bash
npm install        # 只装 jsdom（开发期依赖，不进镜像）
npm test
```
用 jsdom 加载真实 `index.html` + `app.js`、桩掉 `fetch`，断言榜单 chips 与歌曲列表**真的被渲染出来**、无 JS 运行时错误，并覆盖"歌词竞态"场景。

> **为什么必须加这个测试**：曾经 `app.js` 里有一处 ASI 陷阱——`state.searchList = null` 漏了分号，
> 而下一行以 `[` 开头，解析器把它读成 `null[...els.boardChips.children]`（在成员访问里用扩展运算符是非法语法），
> 导致 **整个 app.js 语法错误、浏览器一行 JS 都不执行**，页面只剩 `index.html` 的静态骨架
> （标题 / 随机播放卡片 / 榜单标题 / 永远卡住的"加载中…"），后端接口全部正常却表现为「什么都不显示」。
>
> 还有一个是**歌词竞态**：`updateLyric` 闭包捕获 `idx` 却延迟 150ms 才读 `lyricLines[idx].text`，
> 期间换歌清空了 `lyricLines` → `undefined.text` → `Cannot read properties of undefined (reading 'text')`。
>
> 纯接口测试（curl `/api/hot` 返回 200）**发现不了**这两类问题，必须有真实 DOM 渲染验证。
> 改前端后请务必跑一遍 `npm test`。

## 部署到路由器（iStoreOS / OpenWrt + Docker）
目标主机：`hly1221.top`（局域网 `192.168.4.2`），端口 `3005`（原 al-music 已清理，端口空闲）。

### 方式 A：Docker Manager Web 界面（推荐，纯鼠标）
1. 用 Samba / 文件管理把 `lx-music-web` 整个文件夹上传到路由器，例如 `/mnt/docker/apps/lx-music-web`。
2. 打开路由器的 **Docker / 容器管理** 界面 → 拉取镜像 `node:20-alpine`。
3. 新建容器：
   - 镜像：`node:20-alpine`
   - 容器名：`lx-music-web`
   - 端口映射：`3005` → `3005`（TCP）
   - 目录挂载：主机 `/mnt/docker/apps/lx-music-web` → 容器 `/app`（只读可不加）
   - 运行命令 / 启动脚本：`node /app/server.js`
   - 重启策略：始终重启（unless-stopped）
4. 保存并启动。手机/电脑浏览器访问 `http://hly1221.top:3005` 或 `http://192.168.4.2:3005`。

### 方式 B：docker-compose（SSH 终端）
```bash
cd /mnt/docker/apps/lx-music-web
docker compose up -d --build
```

> 更新代码后：重新上传文件 → 在 Docker Manager 中「重新创建」容器（或 `docker compose up -d --build`）。
> 按你的习惯，更新完顺手清理旧镜像：`docker image prune -f`。

## 技术要点

### 各平台现状（2026-10 实测，重要）
主流平台的**免费网页取址接口已全部关闭**，这正是本项目做「多音源 + 洛雪源脚本运行时」的原因：

| 平台 | 状态 | 表现 |
| --- | --- | --- |
| 酷我 kw | ❌ 取址关闭 | `antiserver/anti.s` 返回**占位语音**（ASR 实测原话："当前歌曲仅在酷我音乐手机端最新版可播放…"）；`www.kuwo.cn/api/*` 整个网关被反爬拦截（`The request is illegal!`）。搜索 / 榜单 / 歌词 / 封面接口仍可用 |
| 网易云 wy | ✅ 可用 | `eapi/song/enhance/player/url` 取址正常，免费曲可播；会员曲返回 `url: null` |
| QQ tx | ❌ 需登录 | vkey 返回 `result:104003`（无登录态不授权） |
| 酷狗 kg | ❌ 需签名 | `play/getdata` 返回 `err_code:30020`；`mobile/api/song/url` 返回 `Access Deny !!!` |
| 咪咕 mg | ❌ 接口下线 | `music.migu.cn/v3/api/search/song` 等已变成 SPA 页面 |

因此本项目的策略：
1. **网易云作为默认可播放音源**（搜索 / 榜单 / 歌词 / 封面 / 取址全链路实测可用）。
2. **酷我歌曲自动跨源匹配到网易云**（按歌名 + 歌手打分匹配），尽量让"所有歌曲"都能播。
3. **内置洛雪官方源脚本 + 可导入任意洛雪源脚本**，用社区脚本补齐会员曲 / 各平台新取址方式。

### 音源选择如何作用于「列表」与「播放」（2026-10-26 修复）
曾经的问题：切换了音源，只有播放取址生效，**首页榜单和搜索结果始终是网易云**——
因为 `/api/search`、`/api/boards`、`/api/hot` 三个列表接口压根没接收音源参数，前端也没传。

现在的链路（前端 `sourcePick` → 列表接口 → 播放接口）：

| 环节 | 行为 |
| --- | --- |
| 列表数据（搜索 / 榜单） | 只能用**原生引擎**：洛雪协议里没有搜索/榜单动作，脚本只提供 `musicUrl`/`lyric`/`pic`。按所选音源的平台映射：`wy`→网易云、`kw`→酷我、`kg`/`tx`/`mg`/`qs`→网易云兜底 |
| 播放取址 | 用你指定的音源；列表 id 与目标平台不一致时先做跨源匹配 |
| 界面提示 | 列表标题下方常驻「列表：X / 播放：Y」，发生回退时追加黄色说明 |

响应里的 `source`（列表数据来自哪个平台）、`via`（`native:kw` 或 `lx:脚本id`）、`fallback`、`note`
就是为了让界面能如实说明"列表是谁给的、播放是谁给的"，而不是让两者混为一谈。

> 若将来导入了自带 `musicSearch` 的脚本，列表会自动改由脚本提供，此时 `via` 变成 `lx:脚本id`。

### 关键实现
- **网易 eapi 加密契约**：`data = ${url}-36cd479b6b5-${json}-36cd479b6b5-${md5}`，
  `digest = md5("nobody${url}use${json}md5forencrypt")`（**原文 md5，不做 URL 编码**），
  再 `AES-128-ECB`（**带 PKCS5 填充**）加密后取 hex 大写。
  > 两个易错点：① AES 必须带填充（洛雪原生 `AES.java` 里 `ECB_128_NoPadding` 实际映射到 Java 的 `"AES"` 别名 = ECB/PKCS5Padding，写成 NoPadding 会报 `wrong final block length`）；② `aesEncrypt` 必须返回 **Buffer**（洛雪的 `buf2hex` 会再按 hex 编码），返回 base64 字符串会导致签名全错。
- **洛雪自定义源脚本运行时**（`lxsource.js`）：用 Node `vm` 沙箱运行脚本，桥接洛雪协议
  （`globalThis.lx` = `EVENT_NAMES / on / send / request / utils`）；
  脚本 `send('inited', {status, sources})` 注册音源，宿主再以
  `send('request', {source, action:'musicUrl', info:{musicInfo, type}})` 索取播放地址。
  `lx.utils.crypto.aesEncrypt(buffer, mode, key, iv)` 返回 **Buffer**；
  `request` 的 `resp.body` 对 JSON 响应**自动解析成对象**（与洛雪原生一致）；
  脚本未在 15s 内发 `inited` 会被判为格式不符（不会让服务器永久挂起）。
- **音源编排**：`/api/song` 按「原生音源 → 洛雪源脚本 → 跨源匹配到网易云」回退，任一环节成功即返回。
- **媒体代理**：`/api/audio` 与 `/api/cover` 由后端代理并纠正 MIME、支持 Range（透传 `content-range/content-length/etag/last-modified`）；上游返回 HTML（版权提示页）时不再当音频流，改回 502 + 明确报错。
- **网络层重试**：`makeRequest` 做 3 次退避重试，只在"拿不到响应"的连接级错误时重试（4xx/5xx 不重试）；另有硬超时兜底（DNS/TCP 阶段 socket 未分配时 `req.setTimeout` 不生效）。
- **请求日志**：每个请求打印 `[req] METHOD path -> status 耗时`，排障时 `docker logs lx-music-web` 即可判断请求是否到达服务器。
- **零依赖**：后端仅用 Node 内置 `http/https/zlib/crypto/vm`，便于在路由器稳定长期运行。

## 音源管理面板用法

点右上角 **🎵**（或顶栏的音源 chip）打开面板：

- **播放音源（手动指定）**：下拉框按平台分组（网易云 / 酷我 / QQ / 酷狗 / 咪咕 / 汽水…），
  同一平台下可选**具体用哪个脚本实现**。选「自动」= 内置 → 洛雪脚本 → 跨源匹配 依次回退；
  手动指定后**优先用该音源**，取不到会自动回退，不会导致播不出。
  选择会记在浏览器 `localStorage`，顶栏 chip 会显示当前模式。
  **切换后首页榜单与搜索会立即刷新**：列表数据切到对应引擎（网易云 / 酷我），
  点播放时仍用所选音源取址，列表标题下的「列表：X / 播放：Y」会说明当前状态。
- **测试**：对单个音源发一次真实取址请求，就地显示 `✓ 可用 · 耗时 · via · 域名` 或 `✗ 失败 · 原因`。
  后端会自动换用该平台的 id 形态（`songmid` / `songId` / `id` / `hash`…）逐个尝试，
  因此像"汽水音乐"这类非标准 id 的源也能测出来。
- **测试全部音源**：并行测试所有音源，一次看完各源可用性。
- **删除**：删掉某个用户导入的源脚本（该脚本提供的所有音源一并移除）；内置脚本受保护。
  **初始化失败的脚本也会列出来**（标红「失败」），同样可以删除，避免残留文件堆在磁盘上。
- **导入**：支持 URL 或直接粘贴脚本内容；**同一份脚本重复导入会自动识别**，不会产生重复条目。

> 手动指定跨平台音源时，后端会先做**跨源匹配**（按歌名 + 歌手打分）把歌曲映射到目标平台再取址；
> 网易云与网易是同一套 id 空间，可直接互用。
>
> 测试结果的 `via` 字段会告诉你实际是哪个源出的地址。
> 例如 `kw` 测试显示 `via=lx-xxxx/kw` 表示酷我是通过你导入的洛雪脚本绕过去的
> （官方取址已关闭），这条路径才是当前酷我歌曲能播的原因。

## 音源自动搜罗与清理（每日定时）

脚本：`scripts/harvest_sources.js`（零依赖，`node` 直接跑）。已配置每日定时任务，也可手动执行：

```bash
node scripts/harvest_sources.js            # 发现 + 试运行 + 导入 + 清理
npm run harvest:dry                       # 只报告，不改线上状态
```

| 环节 | 做法 |
| --- | --- |
| 发现 | 内置已知源清单走 `raw.githubusercontent.com` 直连（**不消耗 GitHub API 配额**）；若配额可用，再补充 GitHub 仓库搜索与 fork 网络 |
| 试运行 | `POST /api/source/probe`：服务端在内存里加载脚本并对每个音源**真实取址**，不落盘、不改动线上状态 |
| 导入 | 只有取址成功的脚本才 `POST /api/source/import`（后端按内容 MD5 去重） |
| 清理 | 复测存量脚本，全部音源都取不到地址的 `DELETE /api/source/:id`（内置脚本与原生音源永不删） |

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--dry-run` | 关 | 只发现与试运行，完全不改线上状态 |
| `--repos=N` | 10 | GitHub 搜索命中的仓库上限 |
| `--files=N` | 1 | 每个仓库最多取几个脚本文件 |
| `--max-probe=N` | 6 | 单次任务最多试运行几个脚本（每次都要真实取址，控制耗时） |
| `--min-stars=N` | 5 | 仓库星标门槛 |
| `--only=discover\|clean` | all | 只搜罗导入 / 只复测清理 |
| `--base=URL` | `http://hly1221.top:3005` | 目标站点 |
| `GITHUB_TOKEN` | 空 | 环境变量；设置后 GitHub 配额 60 → 5000 次/小时 |

报告会打印到终端并落盘到 `data/harvest-report-YYYY-MM-DD.json`，包含新增 / 重复 / 未通过 / 清理 / 保留五类明细。

> ⚠️ 安全提示：脚本在服务端 Node `vm` 沙箱中执行，而 `vm` **并非强安全边界**——
> 自动导入本质上等于信任上游仓库。默认带 5 星星标门槛过滤，建议只放行有社区背书的源；
> 若不放心，先跑一段时间 `--dry-run` 观察会引入哪些脚本，再开启自动导入。

## API 速查
| 接口 | 说明 |
| --- | --- |
| `GET /api/boards?source=` | 榜单列表。`source` 可为 `auto`/`ny`/`kw`/`脚本id:音源名`，缺省等价 `auto`（网易云） |
| `GET /api/hot?board=3778678&limit=100&source=` | 某榜单歌曲（酷我榜用 `board=16`） |
| `GET /api/search?keyword=...&source=` | 搜索，同样支持 `source`（也兼容旧的 `from=kw`） |
| `GET /api/song?id=&source=&name=&singer=&prefer=&raw=` | 取播放地址（`prefer` 为手动指定的音源 id，`auto` 表示自动回退；`raw` 为列表项携带的脚本原始 id 字段 JSON） |
| `GET /api/audio?u=...` | 音频代理（支持 Range） |
| `GET /api/cover?u=...` 或 `?id=` | 封面代理 |
| `GET /api/lyric?id=&source=` | 歌词（LRC） |
| `GET /api/sources` | 列出所有可用音源（内置 + 洛雪脚本，含初始化失败的） |
| `POST /api/source/import` | 导入洛雪源脚本：`{url}` 或 `{code, id}`（内容重复会自动识别，不重复导入） |
| `POST /api/source/test` | 测试某个音源能否取到播放地址：`{id}`（`ny` / `kw` / `脚本id:音源名`） |
| `POST /api/source/probe` | 试运行一段脚本：`{code}`，内存加载 + 每个音源真实取址，**不落盘**，返回各源 `urlOk/via/ms/error` |
| `DELETE /api/source/:脚本id` | 删除用户导入的源脚本（内置脚本受保护，返回 403） |
