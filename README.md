# Solution ledger

一个全局的问题解决账本：记下踩过的坑和做过的取舍，调试前先检索，工具报错时自动带出已确认的相关条目。

## 它解决什么

会话是独立的，坑却反复踩。这个插件把「症状 → 根因 → 解法 → 怎么验证」沉淀成跨会话可检索的条目，并且**不靠模型自觉去查**：只要一个工具调用失败，插件会拿报错原文去匹配账本，命中已确认条目时直接把摘要附在这次失败结果里，模型在同一个 step 就看到了。

## 两个工具

### `solution_log`

写入一条记录。新条目默认 `draft`（草稿），**草稿不参与自动推送**，只有被确认为 `confirmed` 之后才会被自动带出。

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

Host 半为此注册了三条路由：`GET /solution-ledger/list`、`POST /solution-ledger/update`、`POST /solution-ledger/delete`。

## 配置

在 `cordis.patch.yml` 的本行 `config` 里改：

| 键 | 默认 | 说明 |
|---|---|---|
| `pushOnToolError` | `true` | 工具失败时是否自动推送匹配条目 |
| `pushMinScore` | `4` | 自动推送的最低相关度 |
| `maxEntries` | `2000` | 硬上限；超出后按更新时间删除最旧的**已归档**条目 |
| `archiveAfterDays` | `90` | 超过这么多天未被命中的条目移出检索（不删除） |
| `statePath` | `''` | 空则用 `$DSH_HOME/solution-ledger.json` |

## 限制

- **没有语义检索。** 匹配基于词元与子串，靠的是 `signals` 写得准。写得越像真实报错，命中率越高。
- **没有 UI。** 确认草稿需要让模型调 `solution_log` 带上 `status: "confirmed"`，或直接改 JSON 文件。
- **单进程。** 存储是本地文件，两个 DSH 进程同时写会互相覆盖。
- **`decision` 类不做自动推送。** 选技术路线不产生错误事件，这类条目只能靠 `solution_search` 主动查。
