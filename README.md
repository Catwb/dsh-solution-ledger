# Solution ledger

一个全局的问题解决账本：记下踩过的坑和做过的取舍，调试前先检索，工具报错时自动带出已确认的相关条目。

## 它解决什么

会话是独立的，坑却反复踩。这个插件把「症状 → 根因 → 解法 → 怎么验证」沉淀成跨会话可检索的条目，并且**不靠模型自觉去查**：只要一个工具调用失败，插件会拿报错原文去匹配账本，命中已确认条目时直接把摘要附在这次失败结果里，模型在同一个 step 就看到了。

## 安装

### 从 npm 安装（推荐）

```bash
npm i dsh-solution-ledger
```

或直接让 DSH 装上并启用：

```bash
dsh plugin --profile <profile 名> add dsh-solution-ledger
```

也可以打开 Web 的 **Plugins** 页面，点 Add，填 `dsh-solution-ledger`。

### 从 GitHub 安装

```bash
dsh plugin --profile <profile 名> add github:Catwb/dsh-solution-ledger
```

适合想跟最新提交的场合；npm 上的版本更稳。

安装后侧边栏顶部图标排会多出一个账本图标。修改插件代码后，在 Plugins 页面关掉再打开以重新加载 Host 半；浏览器端还需要刷新页面。

关闭这个插件时，侧边栏图标和面板会随 Host 半一起撤销，但**浏览器里已经加载的那份前端代码需要刷新页面才会消失**——这和插件的清理逻辑无关，是前端 bundle 的加载方式决定的。

### 本地开发

```bash
git clone https://github.com/Catwb/dsh-solution-ledger.git
```

在你的 profile 的 `package.json` 里加两条，然后在该目录执行 `pnpm install`：

```json
{
  "dependencies": {
    "dsh-solution-ledger": "link:<你 clone 的绝对路径>"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-solution-ledger"]
    }
  }
}
```

这个插件不依赖任何第三方包，`node_modules` 里只有它自己，所以上面两条就够了。

## 两个工具

两个工具的 `parameters` 都是**标准 JSON Schema**（`type: 'object'` + `properties` + 字符串数组形式的 `required`）。原因是 DSH 会把它**原样**交给 provider，不做转换：写成裸属性表、或给属性加布尔 `required`，在严格 provider 上会让整轮请求直接失败并报 `Invalid schema for function 'solution_log'`。0.2.7 之前就是这个错误。

### `solution_log`

写入一条记录。新条目默认 `draft`（草稿），**草稿不参与自动推送**，只有被确认为 `confirmed` 之后才会被自动带出。

它只收两类东西：**根因不明显的问题**，和**真正否决过可行方案的取舍**。下面这些不该记——

- 实现说明（「我们用 X 做 Y」「某文件里写了什么」）
- 没有否决任何方案的设计决定
- 一眼看代码或文档就能得到的信息

判据是三个问题，任一为否就别记：

1. 未来的会话会不会再撞上同一情况？
2. 答案能不能看一眼代码或文档就得到？
3. 不记的话，那个会话会不会真的浪费时间？

换句话说：**如果一条记录永远不会出现在报错里、也不会改变任何人下一步的决定，那它是日志，不是账本条目。**

写进去的草稿如果 30 天内**从未被任何检索或推送命中**，会自动归档（`draftArchiveAfterDays`）——即使模型偶尔写进一条实现说明，没人用的小记录也会自己沉底，不必手动清理。归档不等于删除：条目仍在文件里，可在界面里「取消归档」恢复。

| 参数 | 必填 | 说明 |
|---|---|---|
| `kind` | 是 | `troubleshoot`（修好的故障）或 `decision`（选定/否决的路线） |
| `domain` | 是 | `environment` / `tooling` / `code` / `config` / `process` / `other`，检索第一维 |
| `title` | 是 | 一句话结论，不是话题标签 |
| `problem` | 是 | 出现时的症状，或面临的抉择 |
| `resolution` | 是 | 有效的解法，或最终选择 |
| `rejected` | decision 必填 | 否决掉的方案和原因 |
| `verify` | 否 | 怎么确认修好了：跑什么命令、应该看到什么 |
| `signals` | 否 | 错误码、命令名、文件名等**能被未来报错原文原样命中**的字符串，自动匹配靠它 |
| `tags` | 否 | 2–6 个小写复用词 |
| `scope` | 否 | `machine`（本机路径/权限/已装工具）/ `project`（单个仓库约定）/ `general` |
| `platform` | 否 | 仅当条目与平台强相关时填 |
| `status` | 否 | `draft`（默认）/ `confirmed` / `deprecated` |
| `replaces` | 否 | 已有条目 id，原地更新而不是新增 |

写入前会做一次近似探测，若有高度相似的条目会在结果里列出 id，提示用 `replaces` 合并。

### `solution_search`

检索账本。`query` 可以是报错原文，也可以是你正在权衡的选项。

打分权重（高到低）：`signals` 命中 → `tags` → `domain` → 标题词元 → 正文词元；平台不符扣分，跨目录的 `machine` 条目扣分，`deprecated` 大幅降权。

## 自动推送

`tools/post-execute` 钩子：工具失败时取报错文本（`error.message` / `error.info.code` / 结果里的文本块）去匹配，命中 `confirmed` 且分数 ≥ `pushMinScore` 的条目时，在结果尾部追加一段摘要。

约束：
- 只推 `confirmed`，草稿和被推翻的永远不推
- 同一个失败形态只推一次（按工具名 + 报错前缀去重，保留最近 20 条）
- 单条摘要 ≤ 200 字
- 查找自身出错时静默返回，绝不把原来的报错变成更糟的报错

## 存储

`$DSH_HOME/solution-ledger.json`（可用 `statePath` 覆盖）。写入用「临时文件 + rename」保证原子性，读取失败或 JSON 损坏时以空库启动而不是让插件挂掉。

```json
{ "version": 1, "entries": { "<id>": { "id": "...", "title": "..." } } }
```

检索命中的计数只在内存累加，每 30 秒批量落盘一次——否则每次查询都要写磁盘。

## 界面

侧边栏图标排里多出一个账本图标（`order: 30`，在 `dsh-context` 与 `dsh-ppt.workbench` 之间；`sidebar.panellist` 的每一项都对应 `main` 里同 key 的面板）。点开即中央区域的账本面板：

- 搜索框 + 类型 / 状态筛选
- 每条点开可展开：标题、问题、解法、否决方案、验证方式、标签，全部可直接编辑，失焦即保存
- 状态操作：**确认**（草稿 → 已确认，只有确认过的才会参与自动推送）、退回草稿、弃用、归档、删除
- 顶部显示总数与各状态计数，底部显示存储文件的实际路径

Host 半为此注册了六条路由：`GET /solution-ledger/list`、`POST /solution-ledger/update`、`POST /solution-ledger/delete`、`GET /solution-ledger/update-check`、`POST /solution-ledger/backup`、`GET /solution-ledger/backups`。

### 路由访问控制

这六条路由监听在 loopback 上，用户浏览器里**任何一个网页**都能向 `127.0.0.1` 发请求。0.2.4 及之前的版本没有做访问校验，实测后果是：

```
无凭据 GET /list                        → 200，返回完整账本
Origin: evil.example + cross-site 的 GET → 200，照样返回完整账本
text/plain 的跨站 POST /delete           → 请求被处理（handler 自己回了 400）
```

浏览器会拦住跨域**读取**响应，但拦不住**写请求**——CSRF 简单请求不需要预检，任意网页都能清空账本。

从 0.2.5 起，六条路由共用一个护栏（`lib/guard.js`），进入任何 handler 之前先过 `ctx.connection.requestRejection()`：

- Host/Origin 围栏：挡 DNS rebinding 与跨站调用，`Sec-Fetch-Site: cross-site` 直接 403
- 登录 cookie：过了围栏但没有认证的调用回 401
- **拿不到 `connection` 服务时一律 403**（fail closed），检查自身抛错也按 403 处理

被拒绝的响应只有 `unauthorized` / `forbidden` 两种纯文本，不带任何账本内容。

## 更新检查

## 更新检查

面板打开时会查一次自己有没有新版本。查到就在顶部显示一条提示，点**去更新**跳到 **Plugins** 页里这个插件的详情页，用那里的 **Update** 完成安装。插件自己**不装**——`updateBundle` 会先卸载旧版再装新版，而承载这个请求的正是被卸载的那个插件，中途断线是必然的。跳转过去用 DSH 原生的确认框、进度和失败回滚，比自己实现一遍可靠。

### 为什么不用 DSH 自带的版本列表

`pluginManager.listVersions()` 底层跑 `pnpm view`，问的是 **pnpm 配置的 registry**。中国大陆的 `pnpm` 默认指向 `registry.npmmirror.com`，而镜像同步滞后：

| 源 | `dsh-solution-ledger` 的 latest |
|---|---|
| `registry.npmjs.org` | 0.2.3 |
| `registry.npmmirror.com` | 0.2.2 |

当时镜像上 `0.2.3` 的元数据和 tarball **都是 404**，加 `?t=` 时间戳、发 `no-cache` 都没用——不是 HTTP 缓存，是镜像服务端还没同步。所以刚发完版的这段时间里，走镜像的检查一律回答「已是最新」，这正是最需要看到新版本的时候。

于是这里：**官方源先查，镜像作对照**。两边都答上来且镜像落后时，提示里会直接写出 `npmjs v0.2.4 / npmmirror v0.2.3` 并提醒安装时把源切到 `registry.npmjs.org`，否则 Plugins 页会因为镜像拿不到这个版本而报错。

### 更新前的两道闸

点**去更新**不会立刻跳走，中间有两步，任何一步不过就不放行：

**第一道：源真的能下载吗。** `dist-tags` 里有版本号，不等于 tarball 拿得到——镜像上就出现过 tag 有、文件 404 的情况。所以对目标版本发一次带 `Range: bytes=0-0` 的 GET，官方源和镜像各问一遍，拿到真实状态码（`200` / `206` 算可用）。**所有源都取不到就拒绝跳转**，因为这时的更新会变成「卸载了旧版却没东西可装」，比不更新糟得多。面板上会直接显示每个源的实测状态，例如：

```
源状态 · registry.npmjs.org 206 / registry.npmmirror.com 404
```

**第二道：旧版留了底吗。** 跳转前把当前正在跑的包目录整个复制到 `$DSH_HOME/solution-ledger-backups/<版本>-<时间戳>/`，排除 `node_modules` 和 `.git`。`updateBundle` 只升不降，发布的版本也可能本身就是坏的，没有这份副本就没有本地退路。

备份目录**本身就是一个完整可安装的包**，所以回退只有一条命令：

```bash
dsh plugin --profile <profile> 名 add file:<备份目录>
```

目录里还写了 `backup.json`（版本、时间、文件数、来源）和 `RESTORE.md`（回退步骤，link 安装的情况给出 `git checkout` 的做法）。备份失败时会弹确认框问是否仍然继续，默认不继续。

### 缓存

一次检查结果复用 `updateCheckTtlMs`（默认 5 分钟）。刻意设得很短：窗口一长，「检查更新」就会退化成它本来要解决的谎话。**重新检查**按钮带 `?force=1`，直接绕过缓存。

## 配置

在 `cordis.patch.yml` 的本行 `config` 里改：

| 键 | 默认 | 说明 |
|---|---|---|
| `pushOnToolError` | `true` | 工具失败时是否自动推送匹配条目 |
| `pushMinScore` | `12` | 自动推送的最低相关度。低于它的匹配不打扰模型 |
| `maxEntries` | `2000` | 硬上限；超出后按更新时间删除最旧的**已归档**条目 |
| `archiveAfterDays` | `90` | 超过这么多天未被命中的条目移出检索（不删除） |
| `draftArchiveAfterDays` | `30` | 草稿且**从未被命中**，超过这么多天自动归档（不删除） |
| `statePath` | `''` | 空则用 `$DSH_HOME/solution-ledger.json` |
| `updateCheck` | `true` | 面板顶部是否检查新版本 |
| `updateCheckTtlMs` | `300000` | 一次检查结果复用多久。别调大，长了就看不见刚发布的版本 |
| `updateCheckTimeoutMs` | `8000` | 单次 registry 查询的超时 |
| `updateCheckPackage` | `'dsh-solution-ledger'` | 检查哪个包；改名 fork 时才需要动 |
| `updateCheckRegistry` | `'https://registry.npmjs.org'` | 权威源，先查。发布在这里最先可见 |
| `updateCheckMirror` | `'https://registry.npmmirror.com'` | 对照用的镜像；落后会被标出来。设为空字符串则跳过对照 |
| `backupOnUpdate` | `true` | 跳转去更新前是否先备份当前版本 |
| `backupPath` | `''` | 空则用 `$DSH_HOME/solution-ledger-backups` |

## 限制

- **没有语义检索。** 匹配基于词元与子串，靠的是 `signals` 写得准。写得越像真实报错，命中率越高。
- **界面不能新建条目。** 侧边栏面板可以查看、编辑、确认、弃用、归档和删除，但新增条目必须走 `solution_log`。
- **单进程。** 存储是本地文件，两个 DSH 进程同时写会互相覆盖。
- **`decision` 类不做自动推送。** 选技术路线不产生错误事件，这类条目只能靠 `solution_search` 主动查。
- **更新检查不装、只报。** 点**去更新**只是跳到 Plugins 页；装不装、装哪个版本由那里的确认框决定。镜像滞后时，安装那一步仍可能要求你把源切到官方源。
- **更新检查需要出网。** 查不到就是查不到，不会拿缓存冒充新结果——失败时明确显示失败原因。

## 许可证

MIT，见 [LICENSE](LICENSE)。
