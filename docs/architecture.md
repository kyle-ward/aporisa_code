# 架构：职责、进程、不变量与内部接口

本文描述 Aporisa Code 各部分的职责划分、进程模型和内部接口。公共协议只在 [protocol.md](protocol.md) 定义，这里只引用；已验证的事实见 [validation.md](validation.md)。

> 状态（2026-10-01）：后端 v0（B0–B2）完成；本文描述的是 B1 的实现加上 B2 的投机解码、结构化输出、SSD 会话缓存、图片输入和调优，均已在真实模型上验收（validation.md）。前端 F2 已完成（harness core、host 层、命令行，真实任务验收通过）；执行安全（F3）和 UI（F4）尚未开始，计划见 `aporisa_code/DEVELOPMENT_PLAN.md`。

## 1. 三块与边界

| 部分 | 位置 | 职责 | 不负责 |
|---|---|---|---|
| 协议合同 | `docs/protocol.md`，机器可读形式是前端 TS 类型导出的 `docs/schema/` | 前后端唯一的共同依据：请求、item、流事件、错误码、能力声明 | 任何实现细节 |
| 前端 | `aporisa_code/` | harness core（项目的核心价值）、SDK、Electron app | 模型推理 |
| 后端 | `backend/` | 通用、语义无状态的本地推理服务，对外只暴露公开模型别名 | 任何 harness 逻辑 |

合同变更的顺序固定为：协议文档 → 类型与 schema → mock → 一致性测试 → SDK 与兼容 driver → 后端（protocol.md 第 13 节）。

## 2. 前端

依赖方向是 `ui → (IPC) → main → harness → sdk → protocol`，由 `check.sh` 的 import 规则强制。已有的目录及其允许的依赖，见 [development.md](development.md) 的「前端代码结构」。

harness（F2）以 codex 为蓝本，决策记录见前端开发计划（FD-01 至 FD-12）：

- **Thread**：一个会话对应一个 SDK 客户端（WebSocket 续接按连接保持）。请求的 `instructions`、`tools`、`prompt_cache_key`（会话 id）、`reasoning` 基线，以及开头的环境上下文和 AGENTS.md，在整个会话中不变；历史只在尾部追加，换档追加 `configuration_update`。会话开始时预热固定部分。这些规则是为了保住后端的前缀缓存：真实验收中，每次请求都命中上一次请求的全部输入和输出（只差回合结尾的 1 个换行 token）。
- **回合**：工具调用在各自的 item 完成时开始执行（并行工具同时执行，其余独占），结果按调用顺序写回；输出里没有工具调用时回合结束；每回合最多 200 次请求。`tool_call_invalid` 再请求一次：没有完成的工具调用时丢弃失败响应的 item 原样重发，否则保留 item 和工具结果（后端会把连续的 assistant item 合并渲染，保留不带工具调用的输出会改变历史的渲染）。取消时结束本会话的全部进程，并补齐缺失的工具结果。
- **工具**：`exec_command` / `write_stdin`（管道，非 PTY；主进程退出时结束整个进程组）、`apply_patch`（function 工具，补丁全部匹配才写盘）、`view_image`（PNG / JPEG）、`update_plan`。未知工具和错误参数作为工具结果交给模型。工具输出按模型的 `truncation_policy` 截断后进入历史，会话记录保留截断前的内容。
- **上下文**：F2 只做 baseline：请求前按上一次 usage 加新增内容估算，超出有效窗口就不发送；压缩与裁剪属于 F6。
- **会话记录**：`~/Library/Application Support/Aporisa Code/sessions/` 下每个会话一个 JSONL（目录 0700、文件 0600），可恢复；恢复时按 codex 的规则补齐缺失的工具结果。
- **事件**：harness 对外只输出事件（thread / turn / item / tool / approval / response.completed / warning），命令行是第一个消费者；F4 之前定稿为 L3 合同。
- harness 只通过 host 接口接触文件系统和进程，不能使用 Node 内置模块；F2 没有沙箱，命令以用户身份运行，默认逐条询问（F3 取代）。SDK 只有 native、openrouter、stub 三种 driver；OpenRouter 的映射差异只在 [compat-openrouter.md](compat-openrouter.md) 定义。

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
- **worker** 只持有加速状态：MLX 模型与 MTP 草稿模型、会话缓存与快照、token 映射，以及 SSD 上的会话缓存（`.runtime/kv-cache/`）。它的状态丢失（崩溃、重启、淘汰、缓存文件损坏或被删）只影响速度，不影响结果。
- 一个 worker 同时只执行一个生成。worker 内有两个线程：
  - **主线程**独占 MLX，按顺序处理 generate、release_session、shutdown；
  - **控制线程**只收消息：interrupt 和 cancel 只设置标志，主线程在预填充块之间、等待 PLE 预取时、解码的每个 token 之间检查；count_tokens 和 status 在控制线程直接回答，不排在生成后面。

## 4. 内部接口：网关 ↔ worker

通道是 `socket.socketpair()`，帧为 4 字节大端长度加 UTF-8 JSON，单帧上限 96 MiB（`ipc/frames.py`；最大的负载是带图片的完整请求，HTTP 正文上限 64 MiB）。KV 等大块状态从不经过 IPC；编码后的图片特征也只在 worker 内部。

| 网关 → worker | 字段 | 说明 |
|---|---|---|
| `init` | 模型目录、草稿模型目录与每轮草稿数、公开模型对象、适配层、KV 字节数、SSD 缓存目录与模型身份、图片尺寸策略、引擎策略 | 第一帧；路径不放进命令行 |
| `generate` | `id`、`response_id`、`request`（展开后的完整参数）、`session` | `generate:false` 即预热 |
| `count_tokens` | `id`、`request` | 与生成走同一套渲染 |
| `interrupt` / `cancel` | `id` | 优雅中断 / 硬取消 |
| `release_session` | `session` | WebSocket 连接关闭 |
| `status` / `shutdown` | — | 运行状态 / 停机（worker 先在 30 秒内把会话写入 SSD 缓存；网关断开时不写） |

| worker → 网关 | 说明 |
|---|---|
| `ready` | 加载和预热全部通过，带启动信息与启动期间的内存压力 |
| `accepted` / `rejected` | 通过或未通过上下文检查和图片解码（`rejected` 带 `code`，图片问题另带出错的部分 `param`）；网关收到 `accepted` 才开始流 |
| `item_added` / `delta` / `item_done` | item 事件；`item_done` 是权威的完整 item |
| `finished` / `failed` | 终止，带 usage 与计量；`failed` 的 `tool_call_invalid` 带 `detail` |
| `cancelled` | 该 job 已停止且其他消息都已发出；网关收到后才释放准入名额，60 秒未确认则结束 worker 进程组 |
| `counted` / `status` | 对应请求的应答 |

## 5. worker 内部

- **加载**（`engine/runtime.py`）：先设置 MLX wired 上限和 0.5 GiB 的缓冲缓存上限，再惰性加载模型，逐层求值并逐层释放权重文件的页缓存（加载时不再需要两份权重的内存）；再加载 MTP 草稿模型（绑定目标模型的 embedding 和 lm_head，同样释放页缓存）；然后用 `mlock` 锁定全部权重缓冲区（MLX 的 wired 上限只在 GPU 工作时保持常驻，长时间空闲后系统会把模型解锁并压缩；锁定失败则启动失败）；随后装上 PLE 预取，运行覆盖所有请求路径的预热（包括确认验证过草稿）。
- **模型适配层**（`engine/adapters/qwen38.py`）：
  - 渲染：与官方 chat template 逐 token 一致；中途的 `developer` 和 `configuration_update` 渲染为 system 段。
  - token 映射：记住「assistant 回合的渲染文本 → 生成时的 token id」，重新渲染历史时复现生成时的 id。
  - 增量解析：推理 → 回答 → XML 工具调用，按 schema 转换参数，确定 `phase`。
- **会话**（`engine/sessions.py`）：一个会话是一份 MLX cache、其中的 token 列表、草稿模型的状态和最多 16 个快照（循环层状态的拷贝加上该位置的目标隐藏状态，KV 通过截断恢复）。匹配顺序：活跃游标（live）→ 最深的可用快照（snapshot）→ SSD 缓存（ssd，比内存多复用至少一块时）→ 冷启动（cold）。草稿模型跟不上一次恢复时，该会话不再起草，直到下次冷启动。
- **内存预算**：所有会话的 KV 与快照可用的内存，每次请求前按当前实际余量计算（可用内存 + 会话已占用 + 缓冲缓存 − 激活预留 − 缓冲缓存上限 − 给桌面的余量），并且不超过按 wired 上限算出的值；不够时按 LRU 整个淘汰空闲会话。另外按内核的内存压力等级兜底：请求开始时若处于警告（活动监视器里的黄色），先丢掉全部空闲会话；worker 空闲时每 5 秒检查一次，处于警告就丢掉一个最久未用的空闲会话。
- **图片输入**（`engine/vision.py`，B2-6）：网关做结构检查（声明的格式、文件头里的尺寸、文件完整）和数量、原图大小上限；worker 按 `detail` 的像素上限确定尺寸（每 32×32 像素一个 token），在流开始前把还要预填充的图片完整解码一遍。渲染时每张图片展开为对应数量的 `image_pad`，并算好整个请求的 M-RoPE 三维位置；预填充到图片时，用视觉塔的特征替换 pad 的 embedding。会话匹配和 SSD 缓存用「键序列」：每张图片的第一个 pad 换成由图片内容得到的负数，两张不同的图片不会共用缓存。
- **SSD 缓存**（`engine/disk_cache.py`，B2-1）：会话因内存预算或内存压力被淘汰时、以及正常停机时，写入 SSD；之后的请求（包括服务重启之后）按内容匹配恢复。KV 按 2048 个 token 分块，文件名是 token 的链式哈希，相同前缀只存一份；检查点保存某个位置的循环层状态、logits、草稿模型隐藏状态和尾部 KV。磁盘上不存 token 列表，文件权限 0600，每次读入都校验 sha256，总量上限 64 GiB（LRU）。目录按布局摘要（模型身份、格式、MLX 版本等）区分，布局变了旧缓存不再读取并在启动时删除。
- **生成**（`engine/generate.py`）：预填充分块，块大小随上下文长度变小（64K 以下 2048，64K 起 1024，192K 起 512：长上下文时每块的内存峰值随上下文增长，小块速度相同而峰值低）；除 prompt 末尾外，只在最后一个「两侧都不短于 256 token」的条目边界切开存快照，也不留很小的尾块（每次前向有约 90 ms 的固定成本）。每块顺带喂给草稿模型；外置 PLE 表的页用 `F_RDADVISE` 一次性向内核请求，与当前块的 GPU 计算重叠（`engine/ple_prefetch.py`）；解码使用模型卡片的采样参数，presence penalty 作用于全部已生成 token。
- **投机解码**（`engine/speculative.py`，B2-2）：解码按轮进行，采样出的 token 加上草稿模型的 argmax 草稿（上下文 16K 以下 2 个，以上 1 个：长上下文下一次验证 3 个 token 的开销陡增，见 validation.md），由目标模型一次前向验证；逐位置用请求的采样器采样，与草稿相同就继续。每个输出 token 都是目标模型的采样，草稿只决定一次前向覆盖几个位置，因此输出分布不变；与逐 token 解码之间只有 kernel 级的浮点差异（validation.md 的 B2 P1）。草稿有两个来源：上下文的末尾在更早处出现过（至少 3 个 token）时，复制那里之后的 token（提示词查找，B2-3，每轮最多 32 个）；否则用 MTP。验证 token 较多的轮次（16K 起 3 个以上，以下 8 个以上）走预填充路径，因为解码路径在长上下文把多 token 验证拆成一对一对计算，开销随 token 数陡增。
- **结构化输出**（`engine/structured.py`，B2-4）：带 `text.format` 或 strict 工具的请求，回答部分（`</think>` 之后）按一份 Lark 语法约束解码（llguidance），每个 token 采样前加上允许 token 的掩码，受约束区域不投机；推理不受约束。完成的受约束 item 再按 schema 校验一次，不通过以 `structured_output_invalid` 结束（协议第 8.4 节）。

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

- **语义无状态**：每个请求都是完整输入。续接、预热、快照、SSD 缓存、token 映射都是尽力而为的加速，都能退化到冷启动且结果一致；快照恢复在真实模型上逐位一致，SSD 恢复得到的 cache 与写入时逐位相同。
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
| 图片先按 EXIF 方向旋转，再按模型的处理器缩放 | 参考处理器不处理 EXIF，手机照片会被横着看；按显示的方向看才是用户发图的本意 |
| SSD 缓存用按内容寻址的块和检查点、自定格式，而不是计划中「每个 key 一份 safetensors」 | 相同前缀只存一份、同一会话再写只写新增部分（SSD 写入量随新增 token 增长）；重启后 key 会变（WebSocket 的 `conn:<id>`），按内容匹配仍能命中；自定格式带整文件 sha256，读入时校验 |
| 快照预算按实际余量动态计算 | 96 GiB 的机器上模型占约 70 GiB，按 wired 上限算会把桌面程序挤进压缩（validation.md 的 P4 记录） |
