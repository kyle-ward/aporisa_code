# 前端开发计划（F2 起）

> 范围：`aporisa_code/` 中的 harness core、host 层、CLI 和之后的 Electron app。和 `backend/DEVELOPMENT_PLAN.md` 一样，这是临时的开发文档：每个阶段完成后，把定稿的设计拆进 `docs/`（architecture、development、validation），本文最后删除。
>
> - 协议合同是 [docs/protocol.md](../docs/protocol.md)。harness 只通过 SDK 使用合同；需要改合同时，按合同第 13 节的流程进行。
> - 设计参考以 openai/codex 为主（只读克隆在 Studio 的 `~/Personal/references/codex`，本文引用的源码位置基于 HEAD `a933dd77`，路径相对于 `codex-rs/`）。刻意偏离 codex 的地方，在第 2 节和相关小节写明原因。
> - 状态（2026-10-02）：**F2、F3 完成**。F3 的真实验收 11/11 通过（docs/validation.md）。**F4（含 F4.5）完成**：用户简单验收，认为达到 MVP 预期。长期打磨的已知事项见第 11 节。

## 1. 目标与阶段

harness core 是项目的核心价值。F2 到 F4 的目标是：在本地后端上做出一个能日常自用的 agent app，边用边反馈地迭代前后端。之后再做 OpenRouter 对照和上下文管理研究。

| 阶段 | 内容 | 状态 |
|---|---|---|
| F0 | 合同 v0 | 完成（`d52f052`） |
| F1 | SDK、mock、stub driver、wire 层一致性测试 | 完成（`3f58fd8`）；W01–W30 对真实后端全部通过 |
| **F2** | **无界面 agent loop，直接对接本地后端**：host 层、工具、回合循环、会话持久化、CLI | 本文第 3–8 节 |
| F3 | 执行安全：沙箱（macOS Seatbelt）、权限策略、审批 | 完成：真实验收 11/11（第 9 节） |
| F4 | Electron UI MVP；L3（harness ↔ UI）合同；`frontend.sh dev/build/install` | 完成（第 10 节），用户验收达到 MVP 预期；从这里开始日常自用 |
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
| FD-07 | F2 的临时安全措施：CLI 默认在每次 `exec_command` 和 `apply_patch` 之前询问；`--auto` 跳过询问，只用于一次性的临时工作区。F3 用沙箱和审批策略取代 | F2 没有沙箱，模型的命令以用户身份直接运行；真实任务验收在临时仓库里由用户启动 | 用户已定（2026-10-01）；**已被 F3 取代**（第 9 节：沙箱 + `on-request`，`--auto` 改为不询问但沙箱照开） |
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

## 9. F3：执行安全

### 9.1 用户采纳的默认值（2026-10-01，F3 开始前的只读评估）

1. 默认 `workspace-write`：可写工作目录、`/tmp`、`$TMPDIR`，全盘可读；
2. 默认不联网，需要时模型申请（`sandbox_permissions: "require_escalated"` 加 `justification`），用户批准；
3. 审批默认 `on-request`，取代 F2 的「每次都问」；`--auto` 改为「从不询问、沙箱照开」；完全不设限需要显式的 `--dangerously-bypass-sandbox`；
4. 可写目录下的 `.git` 和项目元数据目录只读（与 codex 一致，提交需要申请）；
5. 额外禁读 `~/.ssh`、`~/.gnupg`、`~/.aws`、`~/Library/Keychains` 和 Aporisa 的数据目录；
6. 子进程环境变量默认剔除名字含 KEY、SECRET、TOKEN 的变量；
7. 「记住批准」只在本次会话内按命令前缀生效，持久化规则推迟。

### 9.2 实现

| 层 | 内容 |
| --- | --- |
| host（`src/host/sandbox/`） | `ExecRequest.sandbox`（`SandboxSpec`：可写根目录、受保护的目录名、禁读路径、网络）时以 `/usr/bin/sandbox-exec -p <策略> -D… -- <shell> -lc <命令>` 运行；沙箱进程就是命令本身，进程组和 F2 一样。策略 = codex 的基础策略、网络策略、偏好设置策略（原文移植，`codex-policies.ts`）+ 全盘可读 + 每个可写根目录的 `subpath`（排除 `.git` 等受保护名字的正则）+ 禁止删除可写根目录本身 + 禁读路径（放在最后）+ codex 的 fcntl 限制。额外放行 `com.apple.bsd.dirhelper`（查询本用户临时目录；否则 Python 每次启动都报警告，codex 只在开网络时放行）。`stripSecrets` 时剔除名字含 KEY / SECRET / TOKEN 的继承变量 |
| 策略（`src/harness/safety/policy.ts`） | 三种沙箱档位（`read-only`、`workspace-write`、`danger-full-access`）× 三种审批（`untrusted`、`on-request`、`never`）。所有路径取真实路径（`/tmp` → `/private/tmp`，符号链接展开，尚不存在的文件按最近的已存在祖先解析）。受保护的名字：`.git`、`.agents`、`.codex`、`.aporisa`。命令判定照 codex：危险命令（强制 rm，包括 `sudo`、`env`、`sh -c` 包裹）总要询问、审批关闭时拒绝；申请越权时询问（会话内记住的前缀不再问）、审批关闭时拒绝；`untrusted` 对只读命令以外的一切都询问；其余在沙箱里直接运行 |
| 命令切分（`src/harness/safety/shell.ts`） | 自写的保守切分器：按 `|`、`||`、`&&`、`;`、`&`、换行切成简单命令；遇到展开、重定向、子 shell、通配符、注释、前置赋值、未闭合引号即标为「复杂」。复杂命令不匹配记住的前缀，也不算只读命令，最多多问一次。「本会话允许」记住的前缀：`git`、`npm`、`cargo` 这类带子命令的工具取两个词，其余取程序名 |
| 工具 | `exec_command` 在可以越权时才提供 `sandbox_permissions` 和 `justification` 参数（`never` 或无沙箱时不提供）；沙箱内失败且输出像沙箱拒绝时：`on-request` 在输出末尾提示如何申请（codex 不自动重试），`untrusted` 询问是否在沙箱外重跑（codex 的做法）。`apply_patch` 和 `view_image` 在 harness 进程里执行，按同一策略检查真实路径：补丁写到可写范围外或受保护目录时询问（`never` 拒绝），写到禁读位置一律拒绝；不能查看禁读位置的图片 |
| 回合循环 | 会话开始时解析策略；开头的 developer 消息说明权限（codex 的 permissions 模板）；会话元数据记录档位，恢复时档位不同就在历史末尾追加新的权限说明（前缀不变）。审批的结果改为三种：批准、本会话允许、拒绝；没有审批者时需要审批的一律拒绝并告诉模型 |
| 命令行 | `--sandbox`、`--approval`、`--network`、`--auto`（= `--approval never`）、`--dangerously-bypass-sandbox`（不能与其他安全参数同用）；审批提问 `[y] / [a] 本会话允许 / [N]` |

### 9.3 验收

- 确定性（`check.sh frontend`，真实 Seatbelt）：
  - 逃逸测试：工作区外写入、经符号链接写出、`.git` 的写入、删除、改名与新建、删除工作区根目录、禁读目录的读取与列目录、本机回环网络（默认被拦、开网络后可达）、密钥变量剔除、沙箱下按进程组结束、路径中的正则字符；
  - 策略、切分、危险命令（codex 用例）、只读命令、前缀；
  - 回合循环中的权限说明、越权申请与会话记忆、无人审批与审批关闭、`untrusted` 的拒绝后重跑、补丁审批、禁读图片、恢复时追加权限说明。
- 真实验收（用户运行 `npm run agent-tasks`）：F2 的 8 个任务改在默认档位下运行，脚本自动批准每次询问并记录；新增 3 个必须越权才能完成的任务：`network-fetch`（本机回环服务）、`write-outside`（仓库外的文件）、`git-commit`（`.git` 只读）。标准：11 个任务跑完不崩溃；F2 的 8 个任务最好不需要审批（作为观察指标）；F3 的 3 个任务通过且至少经过一次审批。
- 命令行交互模式（审批提问、`a` 记住、Ctrl-C）的真人测试：用户决定推迟到 F4 完成之后，通过界面一起验收；在此之前只运行无交互的测试。
- 结果（2026-10-02）：11/11 通过；F2 的 8 个任务在沙箱里没有触发任何审批；F3 的 3 个任务各经过一次越权审批，其中两个先撞墙再按提示申请，`git-commit` 根据权限说明直接申请。

## 10. F4：Electron UI MVP（2026-10-02 完成，用户验收达到 MVP 预期）

> 来源说明：界面风格以用户提供的 ChatGPT.app 截图和用户的决定为准。ChatGPT.app 是闭源的，**不等同于**开源的 openai/codex 仓库；本节界面部分不引用 codex 作为依据。codex 仓库只作为 harness 逻辑与协议（L3 合同的形状、上下文压缩）的参考。

### 10.1 范围与边界

- **做**：单用户、无登录；连接本地后端（固定 key，钥匙串加密）；会话列表与会话视图；设置界面；英文（默认）与简体中文；浅色 / 深色 / 跟随系统；基础的上下文压缩；`frontend.sh dev / build / install / uninstall`。
- **不做，但留接口**：账号登录（以后的形态类似 ChatGPT、Claude 的桌面 app：登录后看到自己的本地会话和偏好，同时用个人凭证访问后端，需要一个独立的账号服务；推理后端保持无状态）；数据库（以后只作索引，JSONL 仍是会话的原始记录）；多个连接（F5 的 OpenRouter 会用到）。
- **不做，也不留接口**：跨设备同步会话（用户明确不需要：会话只在本机，工作目录是本地文件夹）；回合中追加指令（steer）、完整的 diff 视图、多窗口、系统通知、MCP、代码语法高亮。
- 推迟到 F4 结束时由用户一起验收的真人交互：F2 / F3 的审批提问、「本会话允许」、取消，改在界面上进行。

### 10.2 决定（用户 2026-10-02 确认）

| # | 决定 |
| --- | --- |
| FD-13 | agent 可以直接安装依赖（`npm install --save-exact`，更新 lockfile）：electron、react、react-dom、vite、@vitejs/plugin-react、esbuild、react-markdown、remark-gfm、@electron/packager、lucide-react（图标）、@types/react 等，版本精确锁定 |
| FD-14 | 界面用 React；渲染进程由 Vite 构建，主进程和 preload 由 esbuild 打包 |
| FD-15 | L3 合同放在新的顶层模块 `src/app-protocol/`，文档 `docs/app-protocol.md`；更新 AGENTS.md 的文档清单和 `check-boundaries.ts` 的规则；传输为 Electron IPC |
| FD-16 | 后端 key 用 Electron `safeStorage`（系统钥匙串）加密后存进数据目录；开发模式下没有配置时退回读 `aporisa_code/.env`；渲染进程永远拿不到凭据（只能写入，读到的只有「已配置」和末四位） |
| FD-17 | 基础的上下文压缩，能用即可（10.5）；以后单独优化，F6 再做成可插拔的策略 |
| FD-18 | 打包用 `@electron/packager`，ad-hoc 签名用系统的 `codesign -s -` |
| FD-19 | 界面多语言：默认英文，设置里可切换为简体中文；自写类型化的字典模块，不引入 i18n 库。L3 只传结构化数据，句子由界面按语言拼出；给模型看的文字（工具结果、权限说明）和日志保持英文 |
| FD-20 | 设置界面（MVP 保持简洁）六项：语言、外观（跟随系统 / 浅色 / 深色）、连接（后端地址、API key、测试连接）、新会话的推理档位、新会话的权限（沙箱、审批、网络）、关于（版本、数据目录） |
| FD-21 | 回车发送、Shift+回车换行，固定行为、不做设置项；输入法组字（IME composition）期间的回车不发送 |
| FD-22 | 会话放在 `数据目录/profiles/local/sessions/`，为以后的多账号留位置；之前 F2 / F3 验收留在 `数据目录/sessions/` 的测试会话不迁移 |
| FD-23 | 设置分两份并带版本号：设备级（语言、外观、连接）在 `数据目录/settings.json`，账号级（新会话默认值等偏好）在 `profiles/local/preferences.json`，经 `SettingsStore` 接口读写 |
| FD-24 | 凭据经「凭据提供者」取得（MVP 只有钥匙串里的固定 key）；SDK 的 native driver 改为也能接受每次请求时取凭据的函数；设置里的连接写成列表（MVP 只有一项）；L3 的 `initialize` 返回合同版本，以后的 `account/*` 等只做加法 |

### 10.3 架构

- **主进程**：应用服务端，承载 harness（每个会话一个 Thread、一个 SDK 客户端、一个进程管理器）、设置与凭据、会话索引（MVP 扫描 JSONL）。
- **preload**：只暴露 `request(method, params)`、`onNotification`、`onServerRequest` / `respond` 几个函数（contextBridge）。
- **渲染进程**：只经桥通信；`contextIsolation`、`sandbox`、严格 CSP，不加载远程内容；Markdown 不经 innerHTML。
- **L3 合同**（形状参照 codex app-server v2 的子集）：
  - UI → 主进程的请求：`initialize`、`model/list`、`thread/start`（选工作目录）、`thread/resume`、`thread/list`、`thread/read`、`thread/settings/update`（推理档位、沙箱、审批、网络）、`thread/compact`、`turn/start`（文字 + 图片）、`turn/interrupt`、`settings/read`、`settings/update`、`connection/test`。
  - 主进程 → UI 的通知：`thread/started`、`turn/started`、`item/started`、`item/*/delta`、`item/completed`、`turn/plan/updated`、`thread/tokenUsage/updated`、`thread/compacted`、`turn/completed`。
  - 主进程 → UI 的请求：命令审批、补丁审批，回答为 accept / acceptForSession / decline（对应 F3 的三种决定）。
  - item（结构化，供界面渲染）：用户消息；agent 消息（文本、过程说明还是最终回答）；思考（原文、耗时）；命令执行（命令、工作目录、**归类**、状态、退出码、耗时、是否在沙箱外、给界面的输出：去掉给模型的头部，超长截断并注明）；文件修改（文件列表、补丁原文）；计划；图片查看；上下文压缩。回合带开始和结束时间。
- **实现时的调整**（定稿以 [docs/app-protocol.md](../docs/app-protocol.md) 为准）：名字按本项目简化：`thread/read` 合并进 `thread/resume`（返回回合）；用量通知为 `thread/contextUsage`；delta 统一为 `item/delta`（带 `kind`）；计划作为 `plan` item 而不是单独的通知；压缩作为 `compaction` item；审批的回答沿用 F3 的 `approved` / `approved_for_session` / `denied`。另加 `dialog/selectFolder`、`shell/reveal` 和菜单用的 `app/command` 通知。**L3 不导出 JSON Schema、不做漂移测试**：两端都在同一次构建里从同一份 TS 类型编译，不存在两份定义；跨进程边界的请求参数由 zod 在主进程校验（`schema.ts`）。这和 L1（后端是 Python，所以需要提交的 schema 和漂移测试）不同。
- **命令归类**放在 harness（CLI 和评估也能用）：复用 F3 的切分器，跳过 `cd 路径 &&` 前缀；`cat`、`sed -n`、`head`、`tail`、`nl` 归为读文件（带文件名），`rg`、`grep`、`find` 归为搜索（带搜索词和路径），`ls` 归为列目录，其余归为运行命令。认不出时退回「运行命令」，只影响摘要的细致程度。codex 有同类的 `parse_command`（协议里的 `ParsedCommand`：Read / ListFiles / Search / Unknown），这里是简化版。

### 10.4 界面规格

- **布局**：左侧会话列表（标题取第一条用户消息，按最近更新排序，新建会话时用系统的文件夹选择框选工作目录）；右侧会话视图；顶栏显示工作目录、推理档位、权限（沙箱 / 审批 / 网络）、上下文用量（已用 token / 窗口）、手动压缩。
- **回合的显示**（按用户提供的 ChatGPT.app 截图）：
  - 回答上方一行「Worked for 7m 59s」加箭头，控制整个过程的展开和收起；收起时只看到这一行和最终回答。
  - 过程里按顺序穿插：模型的过程说明（commentary 消息）；「Thought for 12s」思考行（默认收起，点开显示原文，**默认不展示思考**）；活动摘要行（相邻的工具调用合并成一行，如「Read files, ran commands」，配图标）。
  - 点开活动摘要，逐条列出：「Ran …」（命令单行显示、过长时省略号截断）、「Read 文件名」、「Searched for … in …」、「Edited 文件名」。
  - 点开某条命令，显示 Shell 面板：`$ 命令` 和输出，最大高度固定，超出时面板内部滚动，带复制按钮；补丁显示为按 `+` / `-` 着色的原文。
  - 运行中过程保持展开、实时更新，结束后自动收起（这是 agent 的建议，不是从截图或 codex 得来的依据）；用户中途手动展开或收起过的，保留用户的选择。
  - 待审批的卡片固定显示在过程下方，不受折叠影响：显示原因、模型给的理由、命令或文件，以及三个按钮。
  - 没有最终回答的回合（失败、中断）：过程保持展开，末尾显示错误或「已中断」。
- **输入框**：多行文本，回车发送、Shift+回车换行、组字期间不发送；粘贴或拖入图片（PNG / JPEG）；运行中显示中断按钮。
- **最终回答**：Markdown（GFM），行内代码与代码块用等宽字体；文件路径以后再做成可点击。
- **设置**：FD-20 的六项；外观即时生效；语言即时切换。

### 10.5 基础的上下文压缩（FD-17）

参照 codex 的 `core/src/compact.rs` 和 `prompts/templates/compact/`：

- **触发**：请求前估算的输入 token 达到阈值时自动压缩；阈值 = min(模型的 `auto_compact_token_limit`（未给出时为窗口的 90%，codex 的规则），可发送上限的 90%)。本地后端的阈值约为 194K。另有手动压缩（顶栏按钮、`thread/compact`）。
- **做法**：把当前历史加一条压缩指令（codex 的交接摘要提示词）发给模型，得到摘要；新历史 = 会话开头的固定内容（环境、权限说明、AGENTS.md）+ 最近的用户消息（从新往旧取，最多约 20K token，codex 的 `COMPACT_USER_MESSAGE_MAX_TOKENS`）+ 一条以 codex 的摘要开头语引出的摘要消息。推理档位的基线改为当前档位。
- **代价**：压缩之后前缀缓存从头失效，下一次请求要重新预填充；这是 F6 要研究的取舍，F4 只求能用。
- **记录**：会话记录写入 `compacted` 行（新历史的完整内容），恢复会话时从最后一次压缩开始重建；完整的旧轨迹仍然保留在文件里，供 F6 回放。
- 回合进行中触发时，在两次请求之间压缩，压缩结束后继续当前回合。

### 10.6 工程

- 新增 `src/app-protocol/`（zod 合同，可导出 schema）、`src/main/`、`src/preload/`、`src/ui/`；构建产物在 `aporisa_code/dist/`（不进 Git）。
- `frontend.sh`：`dev` 前台启动开发模式（Vite 热更新 + Electron）；`build` 离线打包出 `Aporisa Code.app` 并 ad-hoc 签名；`install` / `uninstall` 放进或移出 `~/Applications`；`doctor` 增加 Electron 二进制的检查。
- 数据目录的路径集中在一处：数据目录由 host 的 `info().dataDir` 给出，`profiles/<id>` 和会话目录由 `src/harness/store.ts` 的 `profileDir` / `defaultSessionsDir` 推出，设置和凭据只接收数据目录。
- Electron 的二进制和发布压缩包由 `prepare` 显式安装（npm 11 不运行依赖的安装脚本），压缩包缓存在项目的 `.cache/electron/`，`build` 离线使用并先核对 SHA256（`tools/electron-zip.ts`、`tools/package-app.ts`）。
- 从访达启动的 app 只有 launchd 的精简环境：主进程启动时用登录 shell 取一次环境变量（`src/main/shell-env.ts`），供命令使用。这是实现中补充的。

### 10.7 测试与验收

- 确定性（`check.sh frontend`）：L3 合同的 schema 与漂移测试；主进程应用服务端用 stub driver 无界面测试（请求、通知、审批往返、设置、会话列表、恢复）；界面的状态逻辑（过程分组、折叠状态、流式更新）写成纯 TS 并单独测试；命令归类；字典两种语言的键完全一致；压缩的触发与新历史的构成；设置的版本迁移。
- agent 的界面检查：用 Vite 把渲染进程单独开在内置浏览器里，背后接一个假的桥，用来截图、对照用户给的截图（只用于开发检查，不是产品模式）。
- 用户的验收（F4 结束时）：`./frontend.sh build && ./frontend.sh install`，在 app 里按清单走一遍，包括 F2 / F3 推迟的真人交互（审批、本会话允许、中断）、语言和外观切换、图片、压缩；`npm run agent-tasks` 仍然 11/11。

### 10.8 步骤

1. F4.1 L3 合同、主进程的应用服务端、命令归类、设置与凭据、会话索引、`profiles/local` 路径；无界面测试。
2. F4.2 Electron 外壳：窗口、preload 桥、安全设置、`frontend.sh dev / build / install / uninstall`。
3. F4.3 界面：布局、回合显示、审批、输入框、设置、多语言、深浅色。
4. F4.4 基础的上下文压缩。
5. 收尾、文档，交给用户验收。

和 F2、F3 一样连续完成，只在需要用户决策或运行权限外的命令时停下。

### 10.9 F4.5：项目与对话（2026-10-02 用户提出，同日确认）

用户试用后提出：左侧做成「项目 → 对话」两级，对话可以删除，项目可以移除；「项目」和「文件夹」分开，一个项目有一个主文件夹和若干参考文件夹；可以开不属于任何项目的对话；界面上放产品名。

| # | 决定 |
| --- | --- |
| FD-25 | 参考文件夹是**软只读**：写在环境说明里并注明不要修改；除此之外和工作目录之外的任何路径一样（沙箱里不可写，越权写入要用户批准）。不做额外的强制拒绝 |
| FD-26 | 删除对话 = 把会话记录移到系统废纸篓（不是归档）；不使用项目的对话，私有工作目录一并移走 |
| FD-27 | 移除项目只删项目记录；它的对话移到「对话」分组（不属于任何项目，也不再有参考文件夹），磁盘上的文件夹不受影响 |
| FD-28 | 不使用项目的对话各有一个私有工作目录，在 `~/Library/Caches/Aporisa Code/scratch/<id>/`（数据目录被沙箱禁读，所以不放在那里） |
| FD-29 | 界面里 thread 改叫 Chat（中文「对话」）；L3 仍叫 thread。MVP 不做 app 图标 |

agent 的建议、用户未反对的：对话在发出第一条消息时才创建；主文件夹创建后不可改；AGENTS.md 只读取主文件夹的；项目功能之前的会话（以及命令行的会话）按工作目录归到主文件夹相同的项目；CLI 增加 `--reference`。

实现：harness 的 `references` / `setReferences` 和环境更新（`context` 行）；压缩后重新说明与开头不一致的权限和参考文件夹；`src/main/projects.ts`；L3 新增 `project/*`、`thread/delete`，`thread/start` 改为 `projectId`；侧边栏、新建对话视图（项目选择器）、项目设置对话框、确认对话框。

## 11. 留给后续阶段的事

- **长期打磨（F4 之后，与 F5 起的阶段并行）**：用户验收 MVP 时指出，界面流畅度、细节处理和生产稳定性还不够，需要进一步测试。方式：用户日常使用中发现问题并反馈，agent 分析原因、提出优化方案，确认后再改；每个问题修复时补上能复现它的测试（确定性测试，或打包 app 的检查）。已知事项：
  - **回合结束后仍显示「运行中」**（用户验收截图中，回合已结束而输入框仍是停止按钮；agent 读代码确认了原因，尚未修复）：harness 先发出 `turn.completed`，等会话记录写完才把 `busy` 置回 false；主进程在 `turn.completed` 时补发的 `thread/updated` 读到的仍是 `running: true`，覆盖了 `turn/completed` 已经设好的状态。`turn/start` 在启动回合之后才发 `running: true`，极快的回合也可能出现同样的问题。修法：两处都显式给出运行状态，并加一个测试。
  - 尚未在真实 app 里逐项回报的验收清单（docs/validation.md 的 F4「尚未验证」）照常在使用中覆盖。

- F5：OpenRouter driver，录制回放。
- F6：上下文管理策略（压缩、工具输出裁剪、推理保留多少），以及「省 token」与「保住前缀缓存」之间的取舍。
- 待需要时：PTY、`apply_patch` 的 shell heredoc 形式、MCP、子 agent、持久化的命令规则（codex 的 execpolicy）、只开网络的细粒度越权（codex 的 `with_additional_permissions`）。

## 12. 变更记录

- **2026-10-02**：用户安装后首轮试用发现两个问题并已修复：所有 IPC 请求被拒（`untrusted sender`，可信地址没有按 file URL 编码）、按钮悬停颜色（通用悬停规则的优先级高于各变体）。之后按用户要求加入 F4.5（10.9）。
- **2026-10-02**：F4 代码完成（第 10 节）。实现中的调整见 10.3 的「实现时的调整」和 10.6；界面检查中修复了回合完成时内容被清空、单个文件的补丁显示了整个补丁两处问题；打包启动检查发现 preload 在沙箱里无法加载并修复（docs/validation.md）。真人验收等用户进行。
- **2026-10-01**：初稿。阶段顺序、工具集、会话存放位置、本文位置由用户确定；FD-05 到 FD-08 待用户决定。
- **2026-10-01**：用户采纳 FD-05 到 FD-08，开始 F2.1。
- **2026-10-02**：F4 计划（第 10 节）：用户确认 MVP 边界与 FD-13 至 FD-24；界面风格以用户提供的 ChatGPT.app 截图为准（闭源，与 codex 仓库不等同）。F4 等用户明确开始。
- **2026-10-02**：用户运行 F2 + F3 真实验收，11/11 通过。用户决定真人交互测试推迟到 UI 完成之后，此前只运行无交互的测试。
- **2026-10-01**：F3 代码完成（第 9 节）。实现中的取舍：沿用 codex 在 `on-request` 下不自动重试、只提示申请的做法（`untrusted` 才询问是否在沙箱外重跑）；额外放行 `com.apple.bsd.dirhelper`；「本会话允许」的前缀只对 git、npm 这类工具取子命令；新增 `tmpWritable` 选项（codex 的 exclude 开关，测试中用于构造工作区外的位置）。
- **2026-10-01**：用户运行真实验收，8/8 通过。按结果修订：FD-08 在没有完成的工具调用时丢弃失败响应的 item、原样重发（`rename` 任务中保留它们让前缀缓存漏掉 640 token）；验收指标的「首事件」（`response.created`，后端收到请求立即发出）改为首个输出 item 的时间；系统指令补充 macOS 的 BSD 命令行和「没有读文件工具」两句（模型用过 `cat -A`、调用过不存在的 `read_file`）。F3 的默认值按用户采纳的建议（见第 9 节），F3 等用户明确开始。
- **2026-10-01**：F2.1–F2.4 代码完成。实现中补充的设计：主进程退出后结束整个进程组、stdin 的 Ctrl-C / Ctrl-D 语义（4.2）；FD-08 细化为保留已完成的 item 后再请求；审批与回合取消赛跑（取消视为拒绝）；并行工具的审批按调用顺序逐个询问；会话恢复时按 codex 的规则补齐缺失的工具结果（每次加载重算，不写回文件）；图片按固定成本估算 token（1,100 / 4,200），不按 base64 字节数。
