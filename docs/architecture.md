# 架构：职责、进程、不变量与内部接口

本文描述 Aporisa Code 各部分的职责划分、进程模型和内部接口。公共协议只在 [protocol.md](protocol.md) 定义，这里只引用；已验证的事实见 [validation.md](validation.md)。

> 状态（2026-10-01）：后端 B1 已完成，B2 进行中；本文描述的是 B1 的实现加上 B2 P1 的 MTP 投机解码（小模型已验证，真实模型待验收）。前端 F1 已完成（SDK、mock、一致性测试），harness 和 UI 从 F2 起逐步加入，届时补充第 2 节。

## 1. 三块与边界

| 部分 | 位置 | 职责 | 不负责 |
|---|---|---|---|
| 协议合同 | `docs/protocol.md`，机器可读形式是前端 TS 类型导出的 `docs/schema/` | 前后端唯一的共同依据：请求、item、流事件、错误码、能力声明 | 任何实现细节 |
| 前端 | `aporisa_code/` | harness core（项目的核心价值）、SDK、Electron app | 模型推理 |
| 后端 | `backend/` | 通用、语义无状态的本地推理服务，对外只暴露公开模型别名 | 任何 harness 逻辑 |

合同变更的顺序固定为：协议文档 → 类型与 schema → mock → 一致性测试 → SDK 与兼容 driver → 后端（protocol.md 第 13 节）。

## 2. 前端

依赖方向是 `ui → (IPC) → main → harness → sdk → protocol`，由 `check.sh` 的 import 规则强制。F1 已有的目录（`protocol/`、`sdk/`、`mock/`、`conformance/`）及其允许的依赖，见 [development.md](development.md) 的「前端代码结构」。SDK 只有 native、openrouter、stub 三种 driver；OpenRouter 的映射差异只在 [compat-openrouter.md](compat-openrouter.md) 定义。

## 3. 后端进程模型

```
launchd (LaunchDaemon, KeepAlive=false)
  └─ scripts/service_entrypoint.sh backend        控制台输出写入 .runtime/services/backend/logs/
       └─ exec scripts/backend.sh run → scripts/lifecycle.py run
            └─ exec python -m aporisa_backend.lifecycle.cli run        网关进程（同一个 PID）
                 │  检查（与 doctor 同一套）→ 实例锁 → 模型目录共享租约 → JSONL 日志
                 │  uvicorn（127.0.0.1:18080）+ 手写路由的 ASGI 网关
                 │
                 └─ python -m aporisa_backend.engine.main --fd N               worker 进程
                        自己的进程组（start_new_session）；只继承 socketpair 的一端；
                        环境变量白名单，不含 API key；stdout 丢弃，启动阶段保留 stderr 尾部
```

- **网关**持有全部协议语义：认证、严格 JSON、按 schema 与语义校验、FIFO 准入（并发 1、排队 2）、计时与上限、事件组装（所有 id 和 `sequence_number` 都由网关生成）、SSE 与 WebSocket、WebSocket 续接的展开、worker 故障的有限次恢复。
- **worker** 只持有加速状态：MLX 模型与 MTP 草稿模型、会话缓存与快照、token 映射。它的状态丢失（崩溃、重启、淘汰）只影响速度，不影响结果。
- 一个 worker 同时只执行一个生成。worker 内有两个线程：
  - **主线程**独占 MLX，按顺序处理 generate、release_session、shutdown；
  - **控制线程**只收消息：interrupt 和 cancel 只设置标志，主线程在预填充块之间、等待 PLE 预取时、解码的每个 token 之间检查；count_tokens 和 status 在控制线程直接回答，不排在生成后面。

## 4. 内部接口：网关 ↔ worker

通道是 `socket.socketpair()`，帧为 4 字节大端长度加 UTF-8 JSON，单帧上限 20 MiB（`ipc/frames.py`）。KV 等大块状态从不经过 IPC。

| 网关 → worker | 字段 | 说明 |
|---|---|---|
| `init` | 模型目录、草稿模型目录与每轮草稿数、公开模型对象、适配层、KV 字节数、引擎策略 | 第一帧；路径不放进命令行 |
| `generate` | `id`、`response_id`、`request`（展开后的完整参数）、`session` | `generate:false` 即预热 |
| `count_tokens` | `id`、`request` | 与生成走同一套渲染 |
| `interrupt` / `cancel` | `id` | 优雅中断 / 硬取消 |
| `release_session` | `session` | WebSocket 连接关闭 |
| `status` / `shutdown` | — | 运行状态 / 停机 |

| worker → 网关 | 说明 |
|---|---|
| `ready` | 加载和预热全部通过，带启动信息与启动期间的内存压力 |
| `accepted` / `rejected` | 通过或未通过上下文检查；网关收到 `accepted` 才开始流 |
| `item_added` / `delta` / `item_done` | item 事件；`item_done` 是权威的完整 item |
| `finished` / `failed` | 终止，带 usage 与计量；`failed` 的 `tool_call_invalid` 带 `detail` |
| `cancelled` | 该 job 已停止且其他消息都已发出；网关收到后才释放准入名额，60 秒未确认则结束 worker 进程组 |
| `counted` / `status` | 对应请求的应答 |

## 5. worker 内部

- **加载**（`engine/runtime.py`）：先设置 MLX wired 上限和 0.5 GiB 的缓冲缓存上限，再惰性加载模型，逐层求值并逐层释放权重文件的页缓存（加载时不再需要两份权重的内存）；再加载 MTP 草稿模型（绑定目标模型的 embedding 和 lm_head，同样释放页缓存）；随后装上 PLE 预取，运行覆盖所有请求路径的预热（包括确认验证过草稿）。
- **模型适配层**（`engine/adapters/qwen38.py`）：
  - 渲染：与官方 chat template 逐 token 一致；中途的 `developer` 和 `configuration_update` 渲染为 system 段。
  - token 映射：记住「assistant 回合的渲染文本 → 生成时的 token id」，重新渲染历史时复现生成时的 id。
  - 增量解析：推理 → 回答 → XML 工具调用，按 schema 转换参数，确定 `phase`。
- **会话**（`engine/sessions.py`）：一个会话是一份 MLX cache、其中的 token 列表、草稿模型的状态和最多 16 个快照（循环层状态的拷贝加上该位置的目标隐藏状态，KV 通过截断恢复）。匹配顺序：活跃游标（live）→ 最深的可用快照（snapshot）→ 冷启动（cold）。草稿模型跟不上一次恢复时，该会话不再起草，直到下次冷启动。
- **内存预算**：所有会话的 KV 与快照可用的内存，每次请求前按当前实际余量计算（可用内存 + 会话已占用 + 缓冲缓存 − 激活预留 − 缓冲缓存上限 − 给桌面的余量），并且不超过按 wired 上限算出的值；不够时按 LRU 整个淘汰空闲会话。另外按内核的内存压力等级兜底：请求开始时若处于警告（活动监视器里的黄色），先丢掉全部空闲会话；worker 空闲时每 5 秒检查一次，处于警告就丢掉一个最久未用的空闲会话。
- **生成**（`engine/generate.py`）：预填充按 2048 分块，并在快照点切开，每块顺带喂给草稿模型；外置 PLE 表的页由线程池预取，与当前块的 GPU 计算重叠（`engine/ple_prefetch.py`）；解码使用模型卡片的采样参数，presence penalty 作用于全部已生成 token。
- **投机解码**（`engine/speculative.py`，B2-2）：解码按轮进行，采样出的 token 加上草稿模型的 argmax 草稿（上下文 16K 以下 2 个，以上 1 个：长上下文下一次验证 3 个 token 的开销陡增，见 validation.md），由目标模型一次前向验证；逐位置用请求的采样器采样，与草稿相同就继续。每个输出 token 都是目标模型的采样，草稿只决定一次前向覆盖几个位置，因此输出分布不变；与逐 token 解码之间只有 kernel 级的浮点差异（validation.md 的 B2 P1）。草稿有两个来源：上下文的末尾在更早处出现过（至少 3 个 token）时，复制那里之后的 token（提示词查找，B2-3，每轮最多 32 个）；否则用 MTP。验证 token 较多的轮次（16K 起 3 个以上，以下 8 个以上）走预填充路径，因为解码路径在长上下文把多 token 验证拆成一对一对计算，开销随 token 数陡增。

## 6. 模型配置、权重与生命周期

- **三者解耦**（AGENTS.md「模型配置与权重」）：
  - 配置：`configs/models.py` 的 `MODEL_LIST` / `POINTERS` / `PROFILES`；
  - 权重：`.runtime/model-assets/<目录>.json` 的身份记录是唯一记录，权重在 `.runtime/models/<目录>/<版本>/`；
  - 生命周期：`backend_service.sh`。

  换模型只改指针，不改网关、协议或脚本。细节见 [model-management.md](model-management.md)。
- **租约**：服务从加载到退出持有模型目录和草稿模型目录的共享租约；`model_weights.sh` 的下载、转换、删除需要独占租约，服务在用时直接拒绝。
- **检查**：doctor、prepare、run 共用 `lifecycle/checks.py`，结果分为 SYSTEM / MANUAL / REPAIRABLE / WAIT 四级。模型校验分两级：prepare 完整计算 SHA256 并写收据；start 和 run 只核对收据、文件清单、大小和小文件哈希。profile 引用的草稿模型身份与被服务的身份一起校验，缺失时直接失败，不退回普通解码。
- **服务**：LaunchDaemon 状态机、install/start/stop/uninstall 的语义和运维见 [macos.md](macos.md)。

## 7. 不变量

- **语义无状态**：每个请求都是完整输入。续接、预热、快照、token 映射都是尽力而为的加速，都能退化到冷启动且结果一致；快照恢复在真实模型上逐位一致。
- **取消与断连一路传到引擎**，确认之后才释放准入名额。
- **所有资源都有上限**：正文、准入队列、推理槽位、输出字节、各类超时、IPC 帧、会话内存、worker 恢复次数（2 次）。
- **停机顺序**：关闭准入 → 唤醒排队中的请求 → 限时 drain → 取消剩余请求 → 结束 worker 进程组。
- **隐私**：JSONL 日志字段走白名单，不含提示词、生成内容、推理、工具数据、密钥、请求头或 URL；有测试保证请求正文不会进入日志。
- **公共路由**不暴露真实型号、路径、原始错误或私有端口；故障时不切换到另一个模型。

## 8. 与参考实现的刻意差异

| 做法 | 原因 |
|---|---|
| 手写路由的 ASGI 网关，不用 FastAPI | 请求按已提交的 JSON Schema 校验，用不到 pydantic；FastAPI 会自动暴露 `/docs`，而协议要求未知端点一律 404 |
| socketpair 加 JSON 帧，而不是 local_llm 的私有 HTTP 端口 | 不占端口，不需要内部 token，其他进程接触不到 |
| 续接语义由网关持有 | worker 缓存丢失时续接仍然正确，不会出现 `previous_response_not_found` |
| 会话按 token 前缀匹配，不用哈希链 | 26 万个整数的比较开销可以忽略；哈希链留给 B2 的 SSD 层 |
| 权重目录不按平台分子目录 | 只支持 macOS |
| 快照预算按实际余量动态计算 | 96 GiB 的机器上模型占约 70 GiB，按 wired 上限算会把桌面程序挤进压缩（validation.md 的 P4 记录） |
