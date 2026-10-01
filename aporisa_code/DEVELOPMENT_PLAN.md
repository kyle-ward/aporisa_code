# 前端开发计划（F2 起）

> 范围：`aporisa_code/` 中的 harness core、host 层、CLI 和之后的 Electron app。和 `backend/DEVELOPMENT_PLAN.md` 一样，这是临时的开发文档：每个阶段完成后，把定稿的设计拆进 `docs/`（architecture、development、validation），本文最后删除。
>
> - 协议合同是 [docs/protocol.md](../docs/protocol.md)。harness 只通过 SDK 使用合同；需要改合同时，按合同第 13 节的流程进行。
> - 设计参考以 openai/codex 为主（只读克隆在 Studio 的 `~/Personal/references/codex`，本文引用的源码位置基于 HEAD `a933dd77`，路径相对于 `codex-rs/`）。刻意偏离 codex 的地方，在第 2 节和相关小节写明原因。
> - 状态（2026-10-01）：**F2 完成**。代码与确定性测试完成，用户在 Studio 上运行真实验收 8/8 通过（docs/validation.md）；验收暴露的 FD-08 问题已修订。下一阶段 F3 等用户明确开始。

## 1. 目标与阶段

harness core 是项目的核心价值。F2 到 F4 的目标是：在本地后端上做出一个能日常自用的 agent app，边用边反馈地迭代前后端。之后再做 OpenRouter 对照和上下文管理研究。

| 阶段 | 内容 | 状态 |
|---|---|---|
| F0 | 合同 v0 | 完成（`d52f052`） |
| F1 | SDK、mock、stub driver、wire 层一致性测试 | 完成（`3f58fd8`）；W01–W30 对真实后端全部通过 |
| **F2** | **无界面 agent loop，直接对接本地后端**：host 层、工具、回合循环、会话持久化、CLI | 本文第 3–8 节 |
| F3 | 执行安全：沙箱（macOS Seatbelt）、权限策略、审批 | 未开始；默认值到 F3 开始时再定 |
| F4 | Electron UI MVP；之前定 L3（harness ↔ UI）合同；`frontend.sh dev/build/install` | 未开始；从这里开始日常自用 |
| F5 | OpenRouter 兼容 driver（含图片映射） | 未开始 |
| F6 | 上下文管理：token 账本、可插拔策略 | 未开始 |
| F7 | 评估流水线 | 未开始 |

两条顺序原则：**先无界面，后 UI**；**先安全边界，再 UI**（F3 必须在 F4 之前完成，有了安全边界才开始日常自用）。集成节点 I1（Air 经 Cloudflare Tunnel 使用 Studio 后端）放在 F4 之后。

## 2. 已定决策与待定项

| # | 决策 | 依据 | 状态 |
|---|---|---|---|
| FD-01 | 阶段顺序如第 1 节 | 后端 v0 已完成，本地后端就是最真实的开发期服务端；OpenRouter 主要用于对照实验 | 用户已定（2026-10-01） |
| FD-02 | 工具集对齐 codex：`exec_command`（加 `write_stdin`）、`apply_patch`、`view_image`、`update_plan`。读文件、列目录、搜索都走 shell，不做专门的工具 | codex 的核心工具少而精；模型对 shell 的熟悉程度最高 | 用户已定 |
| FD-03 | 会话与轨迹存放在 `~/Library/Application Support/Aporisa Code/`，目录 0700、文件 0600，在仓库之外 | 会话恢复需要完整内容；macOS 的惯例位置 | 用户已定 |
| FD-04 | harness 对外只输出事件流，按 codex 的 Thread / Turn / Item 组织。CLI 是第一个消费者；F4 之前再定稿为 L3 合同 | codex 的 app-server v2；F2 先用、F4 再冻结，避免过早定死 | 建议 |
| FD-05 | **`apply_patch` 一律做成 function 工具**，只有一个字符串参数 `input`，内容是 codex 的补丁格式；即使模型声明了 `custom_tools` 也不用 custom 形态 | 偏离 codex（新版 codex 只提供 freeform 形态）。原因：本地后端没有 `custom_tools`；Qwen 的工具调用格式里字符串参数是原样文本（`<parameter=input>…</parameter>`），不需要 JSON 转义，function 形态没有额外代价；三种 driver 用同一份工具定义，轨迹可比 | 用户已定（2026-10-01） |
| FD-06 | `exec_command` 用管道而不是 PTY，不提供 `tty` 参数；保留 codex 的「到时间先返回、进程继续跑、用 `write_stdin` 跟进」语义 | 偏离 codex。PTY 需要 node-pty 这类原生依赖，要随 Node 和 Electron 版本编译；管道已经覆盖测试、构建、开发服务器这些主要场景。交互式程序（需要终端的编辑器、`git add -p` 这类）暂不支持，需要时再加 | 用户已定（2026-10-01） |
| FD-07 | F2 的临时安全措施：CLI 默认在每次 `exec_command` 和 `apply_patch` 之前询问；`--auto` 跳过询问，只用于一次性的临时工作区。F3 用沙箱和审批策略取代 | F2 没有沙箱，模型的命令以用户身份直接运行；真实任务验收在临时仓库里由用户启动 | 用户已定（2026-10-01） |
| FD-08 | 模型输出的工具调用损坏（`response.failed`，code 为 `tool_call_invalid`）时，harness 再请求一次；连续第二次失败才结束本回合并报错。按失败响应里有没有完成的工具调用分两种：**没有**（坏掉的调用之前只有推理或说明文字）时丢弃这些 item，原样重发同一份请求；**有**时这些调用已经执行，保留全部 item 和工具结果后再请求 | 这是重新采样，不是重放；协议禁止的是服务端自动重试，harness 自己决定是否再请求。真实验收中发现，保留「没有工具调用的 assistant 输出」会让它和下一次响应的 assistant item 被后端合并成同一个 assistant 回合渲染，历史的渲染随之改变，从那里起前缀缓存失效（`rename` 任务漏掉 640 token）；丢弃则请求不变。已执行的调用不能丢弃，否则历史会缺少真实发生过的副作用；有工具结果隔开时渲染不受影响 | 用户已定（2026-10-01），2026-10-01 按真实验收修订 |
| FD-09 | F2 的上下文管理只做 baseline：工具输出按模型的 `truncation_policy` 截断后写入历史；请求前估算 token，超过有效窗口就不发送，明确报错；不做压缩 | 压缩和裁剪属于 F6 的研究内容。F4 开始自用时是否先加一个最简单的压缩，到 F4 再定 | 用户已定（F6 的范围） |
| FD-10 | 系统指令自写（英文），结构参考 codex 的 `protocol/src/prompts/base_instructions/default.md`；环境上下文和项目 AGENTS.md 作为会话开头的 user 消息，会话期间不变 | 前缀稳定是本地后端性能的关键（续接首 token 0.12 秒，冷启动 3.4K token 要 4.6 秒） | 建议 |
| FD-11 | 从 codex 移植的代码（apply_patch 的解析与匹配、截断格式）在文件头注明来源和 Apache-2.0 许可证，并在 `docs/models-and-licenses.md` 登记 | codex 是 Apache-2.0，需要保留署名 | 建议 |
| FD-12 | CLI 的连接参数沿用一致性测试已有的环境变量：`APORISA_BASE_URL`、`APORISA_API_KEY`、`APORISA_MODEL`，放在 `aporisa_code/.env`（新增 `.env.example`） | 后端地址和 key 是部署差异，符合 AGENTS.md 对 `.env` 的规定；不另起名字 | 建议 |

## 3. F2 的架构

```
cli/  ──▶ harness/ ──▶ sdk/ ──▶ protocol/
              │
              └──▶ host/（只有这里能碰文件系统和进程；F3 在这一层加沙箱）
```

`check-boundaries.ts` 已经预留了这些目录的规则：`harness` 只能导入 `harness`、`host`、`sdk`、`protocol`，**不能直接使用任何 Node 内置模块**；`host` 和 `cli` 可以。所以 harness 里的路径计算、文件读写、计时以外的系统操作，全部经过 host 接口。

| 目录 | 内容 |
|---|---|
| `src/host/` | `Host` 接口和 `NodeHost` 实现：文件、进程会话、环境信息、数据目录 |
| `src/harness/tools/` | 工具注册表、各工具的定义（JSON Schema 在协议第 8.3 节的子集内）和处理器、输出截断 |
| `src/harness/` | Thread（会话）、Turn（回合循环）、上下文组装、token 估算、事件流、会话存储（经 host 写文件） |
| `src/cli/` | `aporisa` 命令：`exec`（非交互）和交互模式；读取 `.env`；把事件流渲染成终端输出或 JSONL |

## 4. host 层（F2.1）

### 4.1 接口

- **文件**：`readFile`（字节）、`readText`、`writeFile`（原子写：先写临时文件再 rename）、`stat`、`exists`、`mkdir`、`remove`、`rename`、`realpath`。全部用绝对路径；相对路径由调用方按工作目录解析。
- **进程会话**：`spawn({ command, cwd, env, shell })` 返回一个会话句柄，可以 `read(yieldMs, maxBytes)`、`write(chars)`、`terminate()`。
- **环境**：工作目录、用户的默认 shell、平台信息、当前时间与时区、数据目录（默认 `~/Library/Application Support/Aporisa Code/`，测试时传入临时目录）。

### 4.2 进程会话（对应 codex 的 unified exec）

- 用户的 shell 执行命令：`$SHELL -lc <cmd>`（codex 默认用登录 shell）。
- **每个命令单独一个进程组**（`detached: true`），超时、取消和会话结束时按进程组结束，只结束自己创建的进程树（AGENTS.md）。
- 输出：stdout 与 stderr 合并，按 head + tail 各一半保留，总上限 1 MiB（codex 的 `UNIFIED_EXEC_OUTPUT_MAX_BYTES`），超出部分记为省略字节数。
- 环境变量：继承用户环境，再覆盖 codex 的一组非交互设置（`NO_COLOR=1`、`TERM=dumb`、`PAGER=cat`、`GIT_PAGER=cat`、`LANG`/`LC_*` 为 UTF-8 等，见 `core/src/unified_exec/process_manager.rs`）。F3 再决定是否收紧环境变量。
- 上限：同时最多 64 个后台会话（codex 的 `MAX_UNIFIED_EXEC_PROCESSES`）；单个后台会话无人跟进时最长保留 300 秒；回合被取消或会话关闭时全部结束。
- 主进程退出后，同一进程组里剩下的进程一并结束（先给 100 毫秒收尾输出）。所以模型想让服务一直运行，应当让命令本身保持在前台，再用 `write_stdin` 跟进，而不是用 `&` 放到后台。
- stdin 是管道，控制字符按终端的习惯处理：`write_stdin` 中的 Ctrl-C（U+0003）向进程组发 SIGINT，Ctrl-D（U+0004）关闭 stdin。这样读到 EOF 才结束的程序（如 `cat`）也能正常收尾。
- 被信号结束的进程，退出码按 shell 的惯例记为 128 加信号编号。

### 4.3 验收

- 单元测试（真实的 `NodeHost`，在临时目录里）：原子写；命令的退出码与输出；超过 yield 时间时先返回、`write_stdin` 继续读到后续输出；超时按进程组结束（包括子进程）；输出超过上限时保留头尾；会话数上限；取消时清理全部进程。
- 进入 `check.sh frontend`，不联网。

## 5. 工具（F2.2）

### 5.1 `exec_command` / `write_stdin`

- 参数与 codex 一致（去掉 `tty`、`login`、`shell` 和审批相关参数）：`cmd`（必填）、`workdir`、`yield_time_ms`（默认 10,000，范围 250–30,000）、`max_output_tokens`（默认 10,000）。`write_stdin`：`session_id`（必填）、`chars`、`yield_time_ms`、`max_output_tokens`。
- 返回给模型的文本格式照搬 codex（`core/src/tools/context.rs`）：

  ```
  Wall time: 1.2345 seconds
  Process exited with code 0        ← 或 Process running with session ID 3
  Original token count: 12345       ← 仅在截断时出现
  Output:
  …
  ```

- 允许并行（codex 的 `exec_command`、`write_stdin`、`view_image` 都允许并行；`apply_patch`、`update_plan` 串行）。
- codex 会识别 `apply_patch <<'EOF'` 形式的 shell 命令并转给 apply_patch 处理（`apply-patch/src/invocation.rs`）。F2 先不做，真实验收中如果模型经常这样调用再加。

### 5.2 `apply_patch`

- 补丁格式与 codex 相同（语法见 `core/assets/tools/apply_patch.lark`）：`*** Begin Patch`、`*** Add File:`、`*** Delete File:`、`*** Update File:`（可带 `*** Move to:`）、`@@` 上下文行、`*** End Patch`。
- 移植 codex 的解析器（`apply-patch/src/parser.rs`）和行匹配（`seek_sequence.rs`：先精确匹配，再依次放宽行尾空白、首尾空白、常见 Unicode 标点的差异）。codex 的测试用例一并移植。
- 先在内存里把所有文件的修改都算出来，全部成功后再写盘；任何一处匹配失败，整个补丁不生效，把失败原因返回给模型。
- 工具定义按 FD-05：function 工具，参数 `{"input": string}`；工具说明里写明补丁格式（codex 在系统指令里有一段同样的说明）。

### 5.3 `view_image`

- 参数 `path`（必填）。读取本地 PNG 或 JPEG（按文件头判断，不看扩展名），作为工具结果中的 `input_image`（data URL，`detail: "auto"`）交给模型。
- 只有模型的 `input_modalities` 包含 `image` 时才注册这个工具。
- 其他格式（WebP、GIF、HEIC 等）返回明确的错误，说明只支持 PNG 和 JPEG；不在客户端转码或缩放，缩放由后端按 `detail` 处理（P5 的上限：`auto` 约 100 万像素）。单个文件超过 20 MiB 时拒绝，远低于后端 64 MiB 的正文上限。

### 5.4 `update_plan`

- 参数与 codex 一致：`explanation`（可选），`plan` 是 `{step, status}` 的列表，`status` 为 `pending` / `in_progress` / `completed`，最多一个 `in_progress`。
- harness 记录当前计划并作为事件发出；返回给模型的只是一句确认。

### 5.5 输出截断与错误

- 写入历史之前，按模型的 `truncation_policy` 截断工具输出（后端 v0 为 10,000 字节）。截断保留头尾、去掉中间，并在开头注明原始大小，格式照搬 codex（`utils/output-truncation`）：`Warning: truncated output (original token count: N)` 加上 `Total output lines: N`。
- 未知工具名、参数不是合法 JSON、参数不符合 schema：都返回一条 `function_call_output` 说明错误，回合继续（codex 的做法；协议第 9.2 节：这些不属于 `tool_call_invalid`）。

### 5.6 验收

- 每个工具的单元测试：真实 `NodeHost` + 临时目录。apply_patch 覆盖新增、删除、修改、移动、多处修改、上下文不匹配时整体不生效、模糊匹配。
- 工具定义的 JSON Schema 通过 `schemaSubsetViolation` 检查。

## 6. 回合循环与会话（F2.3）

### 6.1 请求的组装

| 部分 | 内容 | 会话期间是否变化 |
|---|---|---|
| `instructions` | 自写的系统指令（FD-10） | 不变 |
| `tools` | 第 5 节的工具（按模型能力决定是否带 `view_image`） | 不变 |
| `input` 开头 | 一条 user 消息：`<environment_context>`（工作目录、shell、日期、时区）；如果工作目录到项目根之间有 AGENTS.md，再加一条 user 消息（codex 的 `# AGENTS.md instructions for <dir>` + `<INSTRUCTIONS>` 包裹，按目录从上到下拼接，总量上限 32 KiB） | 不变（日期取会话创建时，不在回合中刷新） |
| `input` 其余部分 | 用户消息、模型输出的 item（reasoning、message、function_call）、工具结果，按发生顺序排列；中途换档时追加 `configuration_update` | 只在尾部追加 |
| `reasoning.effort` | 会话的基线档位；中途换档按协议第 6.1 节追加 `configuration_update`，不改这个字段 | 不变 |
| `prompt_cache_key` | 会话 id | 不变 |
| `parallel_tool_calls` | 模型声明了能力时为 true | 不变 |

- **历史里的推理**：保留全部 reasoning item 原样回传。后端渲染时固定保留历史思考，丢弃会改变丢弃位置之后的渲染、让缓存失效；保留多少是 F6 的研究变量。
- **规范化**（codex 的 `context_manager/normalize.rs`）：每个工具调用都必须有对应的 output。回合被中断时，没有结果的调用补一条 `aborted` 的 output。

### 6.2 回合循环

参照 codex 的 `core/src/session/turn.rs`：

1. 把用户消息加入历史，组装请求，经 SDK 流式生成。
2. 每收到一个 `output_item.done`，就把这个 item 写入历史；如果是工具调用，**立即开始执行**，不等整个响应结束（codex 用 `FuturesOrdered`，结果按调用顺序写回）。能并行的工具同时执行，不能并行的串行执行。delta 只用于展示。
3. 响应结束后，等所有工具执行完，把结果按调用顺序写入历史。
4. 本次输出里有工具调用，就继续下一次请求；没有工具调用，本回合结束（协议第 7.3 节）。
5. 上限：一个回合最多 200 次模型请求（可配置），到上限后停止并报告。

异常情况：

| 情况 | 处理 |
|---|---|
| `response.incomplete`（`max_output_tokens`） | 已完成的 item 照常写入。有工具调用就执行并继续，否则结束本回合并提示输出被截断 |
| `response.failed`，`tool_call_invalid` | 按 FD-08 再请求一次（没有完成的工具调用时丢弃已完成的 item 原样重发，否则保留 item 和工具结果） |
| `response.failed`，其他 code | 已完成的 item 保留，结束本回合并报错；不自动重试 |
| 流开始之前的 429 / 503 | SDK 已按协议第 9.3 节重试 |
| `context_length_exceeded`（400） | 结束本回合并明确报错（FD-09）；harness 在发送前也会做估算，通常走不到这一步 |
| 用户取消 | WebSocket 上发 `response.interrupt`（HTTP 上中断连接），结束所有运行中的进程，补齐缺失的工具结果，回合以 `interrupted` 结束 |

### 6.3 token 估算（baseline）

- 按协议第 10 节的退化方式：上一次响应的 `usage`（输入加输出）加上此后新增 item 按每 4 字节 1 个 token 估算；会话的第一次请求，模型声明了 `input_tokens` 时用计数端点，否则按字节估算。
- 有效窗口 = `context_window × effective_context_window_percent / 100`，再减去本次请求预留的输出（请求的 `max_output_tokens`，不设时为模型的 `max_output_tokens`）。超出就不发送，报告上下文已满。

### 6.4 会话、预热与续接

- 创建会话时，用开头的固定部分发一次预热（`generate: false`，模型声明了 `prewarm` 时），让用户输入第一条消息之前就完成系统指令和环境上下文的预填充。
- 同一个会话复用同一个 SDK 客户端，WebSocket 续接由 SDK 处理（只发送新增 item）。
- 换档：用户改档时，在下一条用户消息之前追加 `configuration_update`（模型声明了 `reasoning_effort_updates` 时；否则改请求字段，代价是前缀缓存失效）。

### 6.5 会话存储（rollout）

- 位置：`<数据目录>/sessions/YYYY/MM/DD/<时间>-<会话 id>.jsonl`，参照 codex 的 rollout。目录 0700，文件 0600。
- 每行一个 JSON：`{"timestamp": …, "type": …, "payload": …}`。类型：`session_meta`（会话 id、工作目录、模型、driver、能力集合、基线档位、harness 版本）、`item`（写入历史的每个 item，原样保存，**工具输出保存截断之前的完整内容**，另外记录写入历史的截断版本）、`turn`（回合开始与结束、结束原因）、`usage`（每次请求的 usage 和计时）、`plan`、`approval`（F2 的询问结果）。
- 恢复会话：读回 `item`，重建与原来逐项相同的历史（因此前缀缓存可以继续命中，后端重启后也能从 SSD 恢复）。
- 会话文件是用户本机的数据，包含完整内容；AGENTS.md 中「日志不记录正文」的规定针对的是诊断日志，不适用于会话文件。CLI 的诊断输出仍然不打印正文。

### 6.6 事件流（FD-04）

harness 对外的事件（F4 之前不冻结）：`thread.started`、`turn.started`、`item.started` / `item.delta` / `item.completed`（item 种类：用户消息、agent 消息、推理、命令执行、文件修改、计划、图片查看）、`approval.requested`（F2 的询问）、`turn.completed`（含 usage、请求次数、耗时）、`turn.failed`、`warning`。

### 6.7 验收（确定性，进入 `check.sh frontend`）

用 stub driver 和脚本化的模型输出（`MockScript`），在临时工作区里运行。测试放在 `tests/`，可以导入 mock；harness 本身不导入 mock。

- 多步任务：读文件 → 打补丁 → 跑测试 → 给出最终回答，结束时文件状态符合预期。
- 并行工具调用：结果按调用顺序写回。
- 未知工具、参数错误：模型收到错误结果后继续。
- `tool_call_invalid`：重试一次后成功；连续两次失败时回合报错。
- 输出截断：写入历史的是截断版本，会话文件里是完整版本。
- 取消：运行中的命令被结束，缺失的工具结果被补齐，下一次请求的历史满足协议第 6 节的结构约束。
- 恢复：恢复后的第一次请求，`input` 与中断前的历史逐项相同。
- 换档：只在尾部追加 `configuration_update`，`reasoning` 字段不变。
- 上下文估算：超过有效窗口时不发送请求。
- 请求次数上限。
- 每次请求的 `instructions`、`tools`、`prompt_cache_key` 在会话内保持不变（前缀稳定）。

## 7. CLI 与真实验收（F2.4）

### 7.1 CLI

- 运行方式：`npm run aporisa -- <参数>`（用项目自带的 Node 直接运行 TS）。不加进 `frontend.sh`，因为它的模式是固定的。npm 会把工作目录切到 `aporisa_code/`，默认工作目录取 npm 被调用时的目录（`INIT_CWD`）；在别处工作时用 `--cwd` 指定。
- `aporisa exec "<任务>"`：非交互，跑完一个回合就退出。参数：`--cwd`、`--model`、`--effort`、`--driver native|stub`、`--transport`、`--resume <会话 id 或路径>`、`--image`、`--json`（逐行输出事件，供脚本和评估使用）、`--show-reasoning`、`--no-persist`、`--max-requests`、`--auto`（FD-07）。退出码：完成 0，失败 1，中断 130，用法错误 2。
- stdin 不是终端（管道、脚本）又没有 `--auto` 时，无法询问，命令和补丁一律拒绝，并提示一次。
- `aporisa`：简单的交互模式，一行一条消息，支持 `/effort <档位>`、Ctrl-C 取消当前回合。
- 连接参数按 FD-12 从 `aporisa_code/.env` 读取。

### 7.2 真实验收（不进 CI，由用户在 Studio 上运行）

- 脚本 `tools/agent-tasks.ts`（`npm run agent-tasks`）：每个任务在临时目录里新建一个 git 仓库，相当于 `--auto` 运行（不询问），对真实后端跑一个回合，结束后用确定的检查判断成败，然后删除临时目录。任务（id）：
  1. `fix-test`：修好一个失败的单元测试（不许改测试）；
  2. `add-function`：给模块加 `count_vowels` 和它的测试；
  3. `edit-config`：按要求改 JSON 配置；
  4. `rename`：跨文件改名，测试仍然通过；
  5. `debug-log`：从日志找到崩溃原因（配置里的键拼错）并修复；
  6. `view-image`：用 `view_image` 看一张红色圆形的 PNG，回答颜色；
  7. `long-command`：运行一个 15 秒才出结果的脚本，要经过 `write_stdin` 跟进；
  8. `many-steps`：逐个读 20 个文件、求和写入文件，产生 20 轮以上的工具调用。

  测试类任务用 `python3 -m unittest`（只用标准库）。每个任务最多 80 次模型请求、15 分钟。
- 记录（终端输出和 `../.runtime/agent-tasks/<时间>.json`，只有指标，不含提示词和模型输出）：成败与原因、请求次数、工具调用次数与失败次数、墙钟时间、每次请求的首个输出 item 时间（近似首 token）、token 用量与 `cached_tokens`，以及「漏掉的前缀」：上一次请求的输入加输出中没有被下一次请求命中的 token 数。会话文件照常写入数据目录，可以事后查看完整轨迹。结果写进 `docs/validation.md`。
- 验收标准：任务全部跑完不崩溃；除每个任务的第一次请求外，「漏掉的前缀」接近 0（前缀缓存按预期续接）；成功率作为基线记录，不设门槛（模型能力不是 F2 的验收对象）。

## 8. 实现顺序与检查点

| 步骤 | 内容 | 检查点 |
|---|---|---|
| F2.1 | host 层与进程会话 | 完成：`check.sh frontend` 通过（`tests/host.test.ts`） |
| F2.2 | 四个工具、截断、注册表 | 完成：`tests/tools.test.ts` |
| F2.3 | 回合循环、会话、存储、事件流 | 完成：第 6.7 节的测试全部通过（`tests/thread.test.ts`） |
| F2.4 | CLI、`.env.example`、验收脚本 | 完成：`tests/cli.test.ts`；用户运行真实验收 8/8 通过（validation.md） |

整个阶段连续完成，只在需要用户决策或运行权限之外的命令时停下（用户 2026-10-01 的要求）；提交只在用户要求时进行。F2 的定稿设计已写进 `docs/architecture.md` 第 2 节和 `docs/development.md`；本文保留 F2 各节作为决策记录，前端全部完成后与后端开发文档一样拆分删除。

## 9. 留给后续阶段的事

- F3：Seatbelt 沙箱（`/usr/bin/sandbox-exec`，参考 codex 的 `sandboxing/`）、网络开关、审批策略、命令切分与危险命令判定、环境变量收紧。用户 2026-10-01 采纳的默认值（F3 开始前的只读评估）：
  1. 默认 `workspace-write`：可写工作目录、`/tmp`、`$TMPDIR`，全盘可读；
  2. 默认不联网，需要时模型申请（`sandbox_permissions: "require_escalated"` 加 `justification`），用户批准；
  3. 审批默认 `on-request`，取代 F2 的「每次都问」；`--auto` 改为「从不询问、沙箱照开」；完全不设限需要显式的 `--dangerously-bypass-sandbox`；
  4. 可写目录下的 `.git` 和项目元数据目录只读（与 codex 一致，提交需要申请）；
  5. 额外禁读 `~/.ssh`、`~/.gnupg`、`~/.aws`、`~/Library/Keychains` 和 Aporisa 的数据目录；
  6. 子进程环境变量默认剔除名字含 KEY、SECRET、TOKEN 的变量；
  7. 「记住批准」只在本次会话内按命令前缀生效，持久化规则推迟。

  实现要点：命令切分自写保守版（复杂语法一律询问，不引入解析依赖）；沙箱路径按真实路径（`/tmp` → `/private/tmp`）；`apply_patch`、`view_image` 在 harness 侧按同一策略检查路径；移植 codex 的 `.sbpl`（注明 Apache-2.0）。已确认 agent 的环境里能运行 `sandbox-exec`，逃逸测试可以进入 `check.sh`。
- F4：L3 合同定稿；会话列表与恢复；是否先加最简单的压缩；图片粘贴与拖入。
- F5：OpenRouter driver，录制回放。
- F6：上下文管理策略（压缩、工具输出裁剪、推理保留多少），以及「省 token」与「保住前缀缓存」之间的取舍。
- 待需要时：PTY、`apply_patch` 的 shell heredoc 形式、MCP、子 agent。

## 10. 变更记录

- **2026-10-01**：初稿。阶段顺序、工具集、会话存放位置、本文位置由用户确定；FD-05 到 FD-08 待用户决定。
- **2026-10-01**：用户采纳 FD-05 到 FD-08，开始 F2.1。
- **2026-10-01**：用户运行真实验收，8/8 通过。按结果修订：FD-08 在没有完成的工具调用时丢弃失败响应的 item、原样重发（`rename` 任务中保留它们让前缀缓存漏掉 640 token）；验收指标的「首事件」（`response.created`，后端收到请求立即发出）改为首个输出 item 的时间；系统指令补充 macOS 的 BSD 命令行和「没有读文件工具」两句（模型用过 `cat -A`、调用过不存在的 `read_file`）。F3 的默认值按用户采纳的建议（见第 9 节），F3 等用户明确开始。
- **2026-10-01**：F2.1–F2.4 代码完成。实现中补充的设计：主进程退出后结束整个进程组、stdin 的 Ctrl-C / Ctrl-D 语义（4.2）；FD-08 细化为保留已完成的 item 后再请求；审批与回合取消赛跑（取消视为拒绝）；并行工具的审批按调用顺序逐个询问；会话恢复时按 codex 的规则补齐缺失的工具结果（每次加载重算，不写回文件）；图片按固定成本估算 token（1,100 / 4,200），不按 base64 字节数。
