# Solution ledger

[![dsh.so install](https://cdn.dsh.so/badge/install/dsh-solution-ledger@0.2.3-alpha.2.svg)](https://www.dsh.so/artifact/dsh-solution-ledger/?ref=badge-install)
[![dsh.so risk](https://cdn.dsh.so/badge/dsh-solution-ledger.svg)](https://www.dsh.so/artifact/dsh-solution-ledger/?ref=badge)

一个全局的问题解决账本：记下踩过的坑和做过的取舍，调试前先检索，工具报错时自动带出已确认的相关条目。

仓库：[Catwb/dsh-solution-ledger](https://github.com/Catwb/dsh-solution-ledger) · NPM：[dsh-solution-ledger](https://www.npmjs.com/package/dsh-solution-ledger)

## 它解决什么

会话是独立的，坑却反复踩。插件把「症状 → 根因 → 解法 → 怎么验证」沉淀成跨会话可检索的条目，并且**不靠模型自觉**：工具调用失败时，它拿报错原文去匹配，命中已确认条目就把摘要附在这次失败结果里，模型在同一个 step 就看到了。

## 安装

```bash
npm i dsh-solution-ledger                                              # 推荐
dsh plugin --profile <profile> add dsh-solution-ledger                 # 或让 DSH 装
dsh plugin --profile <profile> add github:Catwb/dsh-solution-ledger    # 跟最新提交
```

Web 的 **Plugins** 页点 Add 填包名也可以。装好后侧边栏顶部多一个账本图标。

改代码后要在 Plugins 页关掉再打开以重载 Host 半，浏览器端还要刷新页面。关闭插件时**面板路由立刻失效**（打开会提示「插件已被关闭」），但**侧边栏图标要刷新页面才消失**——前端没有「插件卸载」事件可订阅，这是宿主侧的限制，不是清理逻辑漏了。

本地开发：`git clone` 后在 profile 的 `package.json` 加 `"dsh-solution-ledger": "link:<绝对路径>"` 和 `bundles: ["dsh-solution-ledger"]`，再 `pnpm install`。零第三方依赖。

## 两个工具

`solution_log` 写入，`solution_search` 读取。

### `solution_log`

新条目默认 `draft`，**草稿不参与自动推送**，确认后才会被带出。

只记两类东西：**根因不明显的问题**，和**真正否决过可行方案的取舍**。实现说明、没否决过方案的决定、看一眼代码就有的信息都不该记——**如果一条记录永远不会出现在报错里、也不会改变下一步决定，它是日志，不是账本条目。**

草稿 30 天没被任何检索或推送命中会自动归档（`draftArchiveAfterDays`），不必手动清理。

| 参数 | 必填 | 说明 |
|---|---|---|
| `kind` | 是 | `troubleshoot` / `decision` |
| `domain` | 是 | `environment` / `tooling` / `code` / `config` / `process` / `other` |
| `title` | 是 | 一句话结论，不是话题标签 |
| `problem` | 是 | 症状原文，或面临的抉择 |
| `resolution` | 是 | 有效的解法 |
| `rejected` | decision 必填 | 否决的方案和原因 |
| `verify` | 否 | 怎么确认修好了 |
| `signals` | 否 | 能被报错原文**原样命中**的字符串，自动匹配靠它 |
| `tags` | 否 | 2–6 个小写复用词 |
| `scope` | 否 | `machine` / `project` / `general` |
| `platform` | 否 | 平台强相关时才填 |
| `status` | 否 | `draft` / `confirmed` / `deprecated` |
| `replaces` | 否 | 已有条目 id，原地更新 |
| `supersedes` | 否 | 另一条 id，本条目取代它 |

`replaces` 与 `supersedes` 的区别是旧内容**说错了**还是**过时了**：说错用 `replaces`（原地覆盖，不留历史），过时用 `supersedes`（旧条目留作历史、置 `deprecated`、停止推送，面板显示取代连线）。

### `solution_search`

`query` 可以是报错原文，也可以是你在权衡的选项。打分权重：

`signals` 5/条（上限 15）> `tags` 3/条（上限 9）> `problem` 2/词（上限 8）> 标题 2/词（上限 8）> `resolution`/`rejected` 1/词（上限 4）；`confirmed` +2，平台不符、跨目录 `machine`、`deprecated` 减分。

`problem` 单独一档，因为它本来就要求按报错原样写——一条逐字抄了报错的 `confirmed` 条目，光靠自己就能到 10 分，刚好过默认门槛。

`includeArchived: true` 把归档条目一起检索（归档 ≠ 删除）。

## 自动推送

`tools/post-execute`：工具失败时取报错文本（`error.message` / `error.info.code` / 结果文本块）匹配，命中 `confirmed` 且分数 ≥ `pushMinScore` 的条目，在结果尾部追加摘要。只推 `confirmed`；同一失败形态只推一次（工具名 + 报错前缀去重，留最近 20 条）；单条 ≤ 200 字；查找自身出错时静默返回，绝不把原错误变得更糟。

`hits` 和 `pushed` 是两回事：

| 字段 | 何时 +1 | 含义 |
|---|---|---|
| `hits` | `solution_search` 返回的**每一条** | 曝光，不管有没有被采用 |
| `pushed` | 真的被附到工具失败结果上 | 在你需要的那一刻被推到眼前 |

所以「命中最多」排的是曝光，「推送最多」才更接近「这条救过场」。

## 存储

`$DSH_HOME/solution-ledger.json`（`statePath` 可覆盖）。临时文件 + rename 原子写；文件损坏时以空库启动而不是让插件挂掉。计数只在内存累加，每 30 秒批量落盘。

**归档维护不跑定时器**：它挂在下一次 `solution_log` 写入上，面板里的编辑、确认、归档都不会触发。所以 `archiveAfterDays` / `draftArchiveAfterDays` 是「写入时判定」的条件，不是后台任务——一个长期没有新记录的账本，超期条目会一直留在原位，直到下一次 `solution_log`。

## 界面

侧边栏图标排里的账本图标（`order: 30`）打开中央面板：

- 搜索框 + 类型 / 状态筛选 + 排序（最近更新 / 命中最多 / 推送最多 / 最近命中）
- 浏览时上方固定「待确认」区，审核队列不随排序移动；搜索时不分块
- **列表 ↔ 详情两视图**：列表显示标题、徽标和一行摘要，点开进详情页编辑全部字段（失焦即保存）
- 徽标显示类型 / 领域 / 状态 / 归档，以及「命中 N」「推送 N」
- 状态操作：确认、退回草稿、弃用、归档、删除
- 有取代关系时详情页顶部显示「取代了 / 已被取代」，只读

六条路由（前缀 `/solution-ledger`）：`GET /list`、`POST /update`、`POST /delete`、`GET /update-check`、`POST /backup`、`GET /backups`。都先过 `ctx.connection.requestRejection()` 的 Host/Origin 围栏：跨站调用 403、无认证 401、拿不到 `connection` 服务时 fail-closed。拒绝响应是纯文本，不含任何账本内容。

## 更新检查

面板打开时查一次新版本，查到就提示，点**去更新**跳到 Plugins 页用原生 Update 安装——插件**不自己装**，因为 `updateBundle` 会先卸载承载这个请求的插件。

检查问官方源并比对镜像。国内 pnpm 默认走 `registry.npmmirror.com`，镜像滞后时会让 DSH 自己的版本列表回答「已是最新」，而那正是最需要看到新版本的时候。跳转前还有两道闸：目标版本的 tarball 真的取得到（`Range: bytes=0-0` 探测所有源，全不可用就拒绝），以及当前版本已备份到 `$DSH_HOME/solution-ledger-backups/`——那是个完整可安装的包，回退就一条 `dsh plugin add file:<备份目录>`。

检查结果缓存 5 分钟，「重新检查」带 `?force=1` 绕过。

## 配置

`cordis.patch.yml` 本行的 `config`：

| 键 | 默认 | 说明 |
|---|---|---|
| `pushOnToolError` | `true` | 工具失败时是否自动推送 |
| `pushMinScore` | `10` | 自动推送的最低相关度 |
| `maxEntries` | `2000` | 上限；超出后删最旧的已归档条目 |
| `archiveAfterDays` | `90` | 多少天未命中移出检索（不删除） |
| `draftArchiveAfterDays` | `30` | 草稿且从未命中，多少天后自动归档 |
| `statePath` | `''` | 空则用 `$DSH_HOME/solution-ledger.json` |
| `updateCheck` | `true` | 面板是否检查新版本 |
| `updateCheckTtlMs` | `300000` | 检查结果复用时长，别调大 |
| `updateCheckTimeoutMs` | `8000` | 单次 registry 查询超时 |
| `updateCheckPackage` | `'dsh-solution-ledger'` | fork 改名时才动 |
| `updateCheckRegistry` | `npmjs` | 权威源，先查 |
| `updateCheckMirror` | `npmmirror` | 对照镜像；空字符串则跳过 |
| `backupOnUpdate` | `true` | 跳转更新前先备份 |
| `backupPath` | `''` | 空则用 `$DSH_HOME/solution-ledger-backups` |

## 限制

- **没有语义检索**：靠词元与子串，`signals` 写得越像真实报错，命中率越高
- **界面不能新建条目**：新增必须走 `solution_log`
- **单进程**：两个 DSH 进程同时写会互相覆盖
- **`decision` 类不自动推送**：选路线不产生错误事件，只能主动查
- **更新检查不装、只报**：装不装、装哪个版本由 Plugins 页决定
- **图标残留到刷新**：关闭插件后前端代码仍在内存里，见「安装」

## 许可证

MIT，见 [LICENSE](LICENSE)。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
