# App 协议（L3）：界面 ↔ 主进程

本文定义 Aporisa Code 桌面 app 内部，界面（渲染进程）与主进程之间的合同。它和 [protocol.md](protocol.md)（harness ↔ 推理后端）是两层不同的合同：本文不涉及后端，后端也看不到本文的任何内容。

- 代码中的唯一源头是 `aporisa_code/src/app-protocol/types.ts`（TS 类型），请求参数的运行时校验在同目录的 `schema.ts`（zod）。
- 形状参照 openai/codex 的 app-server v2 的一个子集：客户端请求、服务端通知、服务端发起的请求（审批）。字段名和方法名按本项目的需要做了简化，不与 codex 逐字对应。
- 合同版本 `APP_PROTOCOL_VERSION = 1`，由 `initialize` 返回。演进只做加法（新方法、新通知、新的可选字段），不改已有字段的含义（FD-24）。
- 只传结构化数据：界面按用户选择的语言把代码拼成句子（FD-19）。给模型看的文字和日志不经过本层。

> 状态（2026-10-02）：版本 1 已实现，主进程侧有无界面测试（`tests/app-server.test.ts`），界面侧的状态逻辑有单独的测试（`tests/ui-state.test.ts`）。用户在 app 里简单验收，认为达到 MVP 预期，见 [validation.md](validation.md)。
>
> 版本 1 在用户验收之前补充了项目（F4.5）：新增 `project/*` 和 `thread/delete`，`ThreadInfo` 新增 `projectId`、`scratch`。`thread/start` 的参数从 `cwd` 改为 `projectId`，这是唯一一处非加法的修改。版本 1 当时尚未交付，所以没有提升版本号；交付之后只做加法。

## 1. 传输

Electron IPC，经 preload 的 `contextBridge` 暴露为 `window.aporisa`，渲染进程拿不到 Node、Electron 或 `ipcRenderer` 本身：

| 方向 | 形式 | 通道 |
| --- | --- | --- |
| 界面 → 主进程的请求 | `request(method, params)`，返回 Promise | `aporisa:request`（`ipcMain.handle`） |
| 主进程 → 界面的通知 | `onNotification(listener)` | `aporisa:notification` |
| 主进程 → 界面的请求（审批） | `onServerRequest(listener)`，界面用 `respond(id, result)` 回答 | `aporisa:server-request` / `aporisa:server-response` |

- 主进程对每个请求先用 zod 校验参数，未知方法返回 `unknown_method`，参数不合法返回 `invalid_params`。
- 错误跨桥时带一个代码：`invalid_params`、`unknown_method`、`not_found`、`busy`、`connection`、`internal`，界面据此显示。
- 审批请求在界面回答之前一直挂起；窗口关闭或 app 退出时，挂起的审批按拒绝处理。

## 2. 客户端请求

| 方法 | 参数 | 结果 | 说明 |
| --- | --- | --- | --- |
| `initialize` | — | `protocolVersion`、`appVersion`、`dataDir`、`development` | |
| `settings/read` | — | `SettingsView` | |
| `settings/update` | `device?`、`newThread?`、`connection?: { baseUrl?, apiKey? }` | `SettingsView` | `baseUrl: null` 恢复默认；`apiKey: ""` 删除存储的 key。key 只能写入，读出的只有「已配置」、末四位和来源 |
| `connection/test` | — | `{ ok: true, models }` 或 `{ ok: false, error }` | 用当前地址和 key 请求后端的模型列表 |
| `model/list` | — | `{ models: ModelView[] }` | 窗口、推理档位、默认档位、是否支持图片 |
| `project/list` | — | `{ projects: ProjectInfo[] }` | |
| `project/create` | `main` | `{ project }` | 主文件夹已属于某个项目时返回那个项目；路径须是 agent 能读的文件夹（不在禁读位置，也不在对话的私有文件夹里） |
| `project/update` | `projectId`、`name?`、`references?` | `{ project }` | `references` 整体替换，检查规则同上，不能包含主文件夹；该项目已打开的对话在下一轮开头得知变化 |
| `project/remove` | `projectId` | `{}` | 只移除项目记录；它的对话变为不属于任何项目，磁盘上的文件夹不受影响 |
| `thread/list` | — | `{ threads: ThreadInfo[] }` | 扫描会话目录（MVP 没有索引库） |
| `thread/start` | `projectId`（`null` 为不使用项目）、`settings?` | `thread`、`settings`、`turns: []` | 项目的对话在主文件夹里工作并带上参考文件夹；不使用项目时，主进程为这个对话新建一个私有文件夹作为工作目录。未给出的设置取「新对话默认值」。界面在发出第一条消息时才调用它 |
| `thread/delete` | `threadId` | `{}` | 对话正在运行时先中断并等它结束，再把会话记录移到废纸篓；不使用项目的对话，它的私有文件夹也一起移到废纸篓；项目的文件夹永远不动 |
| `thread/resume` | `threadId` | `thread`、`settings`、`turns` | 从会话记录重建回合；已在本次运行中打开的会话直接返回内存中的状态 |
| `thread/settings/update` | `threadId`、`settings`（部分） | `{ settings }` | 推理档位、沙箱、审批、网络；回合进行中修改时，从下一次请求起生效 |
| `thread/compact` | `threadId` | `{ compacted, error }` | 手动压缩上下文；回合进行中返回 `busy` |
| `turn/start` | `threadId`、`text`、`images`（data URL，PNG / JPEG） | `{}` | 立即返回，过程经通知送达；已有回合在进行时返回 `busy` |
| `turn/interrupt` | `threadId` | `{}` | 取消当前回合（结束本会话的全部进程，补齐缺失的工具结果） |
| `dialog/selectFolder` | — | `{ path \| null }` | 系统的文件夹选择框 |
| `shell/reveal` | `path` | `{}` | 在访达中显示 |

## 3. 通知

| 方法 | 参数 | 说明 |
| --- | --- | --- |
| `thread/started` | `thread`、`settings` | 新会话已创建 |
| `thread/updated` | `thread` | 标题、运行状态、更新时间变化 |
| `thread/settings` | `threadId`、`settings` | 会话设置已更新 |
| `thread/contextUsage` | `threadId`、`usage: { tokens, contextWindow, compactAt }` | 每次响应完成和每次压缩之后发送；`tokens` 是下一次请求预计携带的量 |
| `turn/started` | `threadId`、`turn` | `turn.items` 里已有用户消息 |
| `item/started` | `threadId`、`turnId`、`item` | |
| `item/delta` | `threadId`、`turnId`、`itemId`、`kind: "text" \| "reasoning"`、`delta` | 只用于显示 |
| `item/completed` | `threadId`、`turnId`、`item` | 以它为准，替换同 id 的 item |
| `turn/completed` | `threadId`、`turn` | 回合的最终状态与全部 item；`status` 为 `completed`、`interrupted` 或 `failed`（带 `error`） |
| `warning` | `threadId \| null`、`message` | 非致命问题 |
| `app/command` | `command: "openSettings" \| "newThread"` | 应用菜单（在主进程里）触发的界面动作 |

与 [protocol.md](protocol.md) 的流事件一样，delta 只用于显示，写入历史的以 item 完成为准。

## 4. 服务端请求：审批

`approval/request`，参数为 `threadId`、`turnId`、`itemId`、`request`；回答 `{ decision: "approved" | "approved_for_session" | "denied" }`，对应 F3 的三种决定。

| `request.kind` | 字段 | 原因（`reason`） |
| --- | --- | --- |
| `command` | `command`、`cwd`、`sandboxed`、`justification?`（模型给的理由）、`rememberPrefixes`（「本会话允许」会记住的命令前缀，`null` 表示不能记住） | `escalation`（申请在沙箱外运行）、`dangerous`（危险命令）、`untrusted`（`untrusted` 策略）、`sandbox_denied`（沙箱拒绝后询问是否在沙箱外重跑） |
| `patch` | `cwd`、`changes`、`paths`（需要批准的路径） | `outside_workspace`、`untrusted` |

## 5. 数据结构

### 5.1 设置

- `SettingsView`：`device`（`language: "en" | "zh-CN"`、`appearance: "system" | "light" | "dark"`）、`newThread`（`effort`（`null` 为模型默认）、`sandbox`、`approval`、`network`）、`connection`（`baseUrl`、`effectiveBaseUrl`、`keyConfigured`、`keyHint`、`keySource: "keychain" | "env" | null`）。
- `ThreadSettings`：`effort`、`sandbox: "read-only" | "workspace-write" | "danger-full-access"`、`approval: "untrusted" | "on-request" | "never"`、`network`。

### 5.2 会话与回合

- `ProjectInfo`：`id`、`name`、`main`（主文件夹，创建后不变）、`references`（参考文件夹）、`createdAt`。
- `ThreadInfo`：`id`、`title`（第一条用户消息）、`cwd`、`projectId`、`scratch`（在自己的私有文件夹里工作）、`model`、`createdAt`（ISO）、`updatedAt`（毫秒）、`loaded`、`running`。
- 对话属于哪个项目由主进程判定：会话记录里记了项目 id 且该项目仍在，就属于它；记录的项目已被移除，就不属于任何项目；项目功能出现之前的会话（以及命令行写的会话）没有记录，按工作目录归到主文件夹相同的项目。
- `Turn`：`id`、`startedAt`、`completedAt`、`status: "running" | "completed" | "interrupted" | "failed"`、`error: { code, message } | null`、`truncated`（回答在输出上限处被截断）、`items`。

### 5.3 item

| `type` | 字段 |
| --- | --- |
| `userMessage` | `text`、`images` |
| `agentMessage` | `text`、`phase: "commentary" \| "final_answer" \| null`、`status` |
| `reasoning` | `text`、`durationMs`、`status` |
| `commandExecution` | `command`、`cwd`、`actions`（命令归类）、`status`、`exitCode`、`durationMs`、`sandboxed`、`escalated`、`output`、`sessionId`（进程在调用返回后仍在运行时） |
| `stdinInteraction` | `sessionId`、`chars`（空串表示只读取输出）、`status`、`exitCode`、`output` |
| `fileChange` | `changes: { path, kind: "add" \| "update" \| "delete", movePath? }[]`、`patch`（补丁原文）、`status`、`message`（失败原因） |
| `plan` | `explanation`、`plan: { step, status }[]` |
| `imageView` | `path`、`status` |
| `toolCall` | `name`、`status`、`output`（其他工具，或模型调用了不存在的工具） |
| `compaction` | `reason: "auto" \| "manual"`、`status`、`tokensBefore`、`tokensAfter` |

工具类 item 的 `status` 为 `running`、`completed`、`failed`、`declined`（用户拒绝或策略拒绝）。

- **命令归类**（`actions`）由 harness 计算（`src/harness/activity.ts`），CLI 和评估也能用：按 F3 的切分器拆开命令，跳过 `cd`、`pushd`、`true`，管道之后的过滤命令和多段命令里的 `echo` 不计；`cat`、`sed -n`、`head`、`tail`、`nl` 等归为 `read`（带路径），`rg`、`grep` 等和带 `-name` 的 `find` 归为 `search`（带搜索词和路径），`ls`、`tree`、不带 `-name` 的 `find` 归为 `list`（带 `-exec`、`-delete` 的 `find` 算作 `run`），认不出的整条命令归为一个 `run`。归类只影响界面摘要的细致程度。codex 有同类的 `parse_command`，这里是简化版。
- **给界面的输出**（`output`）：不含给模型看的头部（退出码、耗时等），超过 128 KiB 时按头尾截断并注明；给模型的截断另按模型的 `truncation_policy` 进行，两者互不影响。

## 6. 凭据与隐私

- 后端 key 只在主进程里：存储时经 Electron `safeStorage`（系统钥匙串里的加密密钥）加密后写入 `数据目录/credentials.json`（0600）；开发模式下没有存储的 key 时，退回读 `aporisa_code/.env` 的 `APORISA_API_KEY`。
- SDK 在每次请求时向凭据提供者取 key，所以在设置里换 key 后，已打开的会话从下一次请求起使用新 key。
- 渲染进程的 bundle 里没有 key，`settings/read` 只返回末四位和来源；`settings/update` 写入后也不回显。
