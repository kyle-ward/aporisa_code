# Aporisa 后端开发文档

> **状态：设计阶段，尚未实现任何代码。** 本文随讨论和实测动态更新。标为「已定」的内容是和用户确认过的决策；标为「待 B0 实测」的数值只是估计，不能当作事实引用。
>
> - 协议合同是 [docs/protocol.md](../docs/protocol.md)。后端**实现**合同，不修改合同；需要改合同时，按合同第 13 节的流程，先在前端侧完成前几步。
> - 协作规则见 [AGENTS.md](../AGENTS.md)。
> - 本文是**临时开发文档**：后端完成后，稳定的内容拆分到 `docs/architecture.md`、`docs/macos.md` 等文件，然后删除本文。
> - 最后更新：2026-09-29

---

## 1. 目标与范围

**目标**：在 Mac Studio（M3 Ultra，96GB）上提供一个通用、无状态语义的本地推理服务，完整实现 Aporisa 协议，并通过前端仓库中 W01–W22 的 wire 层一致性测试。重点是把**本地独有的状态控制**做好，包括精确续接、快照复用、预热，为 harness 的上下文管理研究提供底层能力。

**不做的事**：
- 不承载任何 harness 逻辑：会话管理、上下文压缩、工具执行都不在后端。
- 不提供多租户，也不做多并发调度。
- 不支持 DGX 或 Linux，也不使用 Docker。
- 不扩展到 262K 以上的上下文（已定）。

**运行前提**（已定）：Studio 以后**只运行这一个 LLM**。local_llm、local_asr 以及其他模型进程全部停用，把尽可能多的内存留给它。

---

## 2. 已定决策

| # | 决策 | 理由或来源 |
|---|---|---|
| D-01 | **从零开始写**后端，不复制 local_llm 再改。可以借鉴 local_llm 的工程做法（生命周期、准入、日志），但重新实现 | 用户决定 |
| D-02 | 模型：**Qwen3.8-Flash-Next** | 用户决定 |
| D-03 | 推理引擎：**MLX**，以 **mlx-vlm 作为库**来加载模型和使用算子，**不使用** `mlx_vlm.server`。mlx-vlm 锁定到具体的 git commit | 51B 表外置、混合缓存、MTP 都已在上游实现；状态可控；Python 技术栈与 local_llm 一致 |
| D-04 | **51B 的 N-gram/PLE 表放在 SSD 上**，使用 mlx-vlm 的 `ple_storage` 按行 mmap 读取 | 用户决定；可以省下约 30GiB 常驻内存 |
| D-05 | 量化文件**自己从官方 FP8 checkpoint 转换**，不用社区现成的 group size 32 版本。具体格式（affine 4-bit gs64 或 mxfp4）**待 B0 实测**后决定 | 社区版外置 PLE 后主体仍有约 77–80GB，太紧 |
| D-06 | **单并发**：同一时刻只有一个生成在运行 | 硬件约束，也是用户的使用场景 |
| D-07 | 上下文窗口 **262,144**（原生上限），不做 YaRN 扩展 | 用户决定 |
| D-08 | **双进程结构**：网关进程加引擎 worker 进程，通过私有 IPC 通信 | 引擎崩溃可以单独重启；网关与模型无关；延续 local_llm 的「网关 + 私有引擎」边界 |
| D-09 | **自研快照缓存**：只借鉴 `apc.py` 的思路，不直接复用它 | 用户决定；这是研究核心，需要完全可控、可观测 |
| D-10 | 两种传输都实现，**WebSocket 为默认**，HTTP 可以显式指定，也作为兜底 | 协议第 3 节 |
| D-11 | 协议不暴露 `temperature` 和 `seed`；采样参数按思考模式和非思考模式，使用模型卡片推荐的固定值 | 用户决定 |
| D-12 | 备选模型：**Qwen3.8-27B**。如果 Flash-Next 在可行的量化下质量或速度不达标，就切换过去，协议和网关都不用改 | 社区评测显示 4-bit 下两者质量相当 |
| D-13 | 提速采取「**架构一步到位，参数分步调优**」：精确续接、条目边界快照、SSD 溢出、token 一致性、预热、MTP 从设计阶段就纳入；各种数值由实测决定 | 用户要求优化一步到位 |
| D-14 | **推理强度由前端按请求控制**，对标 Claude Code 和 codex；`default_effort` 为 **medium**；**切换档位不能让已有的前缀缓存失效**（见第 5.2 节） | 用户决定 |

---

## 3. 硬件与模型事实

详细来源见课程目录下的调研笔记（不在本仓库）。以下数值来自公开资料，**尚未在本机实测**。

| 项目 | 数值 |
|---|---|
| 硬件 | Mac Studio M3 Ultra，96GB 统一内存；macOS 默认允许 GPU 锁定约 75% 的内存，可以用 `sysctl iogpu.wired_limit_mb` 提高，**由用户执行，重启后失效** |
| 参数 | 125B MoE，每 token 激活 6B（512 个专家中选 10 个，另有 1 个共享专家）；另外有 51B 的 N-gram/PLE 表、4B 的 MTP 层，以及视觉编码器 |
| 层结构 | 48 层，排列为 12 ×（3 × Gated DeltaNet + 1 × Qwen Sparse Attention），每层后接 MoE；隐藏维度 2560 |
| DeltaNet | 线性注意力，保存**大小固定的循环状态**，不能截断 |
| QSA | 稀疏注意力，2 个 KV 头，head dim 256，每个 token 只看 2048 个 token 的预算。另外维护一个索引键缓存 |
| PLE | 2000 万条 n-gram，在第 2 层注入。每个 token 按哈希读 16 行，约 2.7KB。Q4 group size 32 下约 30GiB |
| 上下文 | 原生 262,144 |
| 思考控制 | `enable_thinking`（默认开）、`preserve_thinking`（默认开）、`reasoning_effort`：xhigh / medium / low |
| 采样 | 思考模式：temperature 1.0、top_p 0.95、top_k 20；非思考模式：temperature 0.7、top_p 0.8、top_k 20、presence_penalty 1.5 |

**内存预算**（估计，待 B0 实测）：

| 部分 | 估计 |
|---|---|
| 主体权重（约 4.25–4.5bpw） | 66–70GB |
| PLE 表 | 0，放在 SSD 上 |
| 上下文：QSA 的 KV 加索引键，约 27KB/token | 262K 时约 7GB |
| DeltaNet 状态 | 约 100MB，大小固定 |
| 分块预填充的临时激活 | 约 3GB |
| macOS 和系统进程 | 约 6–8GB |
| **合计** | **约 82–88GB**，需要把 GPU 可锁定内存上限提高到约 88GB |

**速度参考**（社区数据，M3 Ultra，MLX 4-bit）：预填充 889 tok/s（2K 上下文），解码 24 tok/s，MTP 加速约 1.42 倍。长上下文下的预填充曲线**待 B0 实测**。

---

## 4. 总体架构

```
            Aporisa 协议（HTTP+SSE / WebSocket）
                          │
┌─────────────────────────▼─────────────────────────────┐
│ 网关进程（FastAPI + uvicorn，与具体模型无关）            │
│  认证 · 正文限制 · 严格 JSON · 按 schema 校验 · 语义校验  │
│  有界 FIFO 准入（并发 1）· 传输适配（SSE / WebSocket）   │
│  WebSocket 连接状态 · sequence_number · 流顺序自检       │
│  错误映射 · 健康检查 · 白名单日志                         │
└─────────────────────────┬─────────────────────────────┘
                          │ 私有 IPC（Unix domain socket，长度前缀加 msgpack）
┌─────────────────────────▼─────────────────────────────┐
│ 引擎 worker 进程（持有 MLX 模型和全部状态）               │
│  模型适配层：chat template 渲染 · tokenizer · 输出解析    │
│  状态管理：活跃游标 · 快照存储 · SSD 溢出                 │
│  生成循环：分块预填充 · 解码 · MTP / 提示词查找投机       │
│  PLE 行存储（mmap SSD）· 预热 · 统计                      │
└───────────────────────────────────────────────────────┘
```

### 4.1 职责划分

| 职责 | 网关 | worker |
|---|---|---|
| 协议形状校验、未知键、严格 JSON | ✅ | |
| 语义校验，例如调用与输出的配对、能力开关、schema 子集 | ✅ | |
| 上下文超长判定（需要真实的 token 数） | 发出请求 | ✅ 计算 |
| 准入、排队、超时、取消传递 | ✅ | 响应取消 |
| chat template 渲染、tokenize | | ✅ |
| 模型输出 → 协议 item（推理、消息、工具调用）的解析 | | ✅ |
| 事件编号、流顺序自检、传输分帧 | ✅ | |
| 续接和快照的匹配与恢复 | 传递连接信息 | ✅ |
| usage 统计 | 汇总 | ✅ 提供真实计数 |

**原则**：凡是和具体模型有关的逻辑（模板、tokenizer、输出格式、缓存结构），全部放在 worker 的**模型适配层**里。网关与模型无关，将来换成 27B 时网关不用改。

### 4.2 私有 IPC（草案）

- 传输：Unix domain socket，放在 `.runtime/` 下，权限 0600；帧格式为 4 字节长度前缀加 msgpack。
- 网关 → worker 的请求：

| 请求 | 作用 |
|---|---|
| `status` | 查询状态 |
| `count_tokens` | 统计 token 数 |
| `generate` | 发起生成，携带完整的请求参数，以及续接上下文：连接 id、`previous_response_id` 对应的状态句柄 |
| `interrupt` | 优雅中断 |
| `cancel` | 硬取消 |
| `release_connection` | WebSocket 连接关闭时释放它的活跃游标 |
| `shutdown` | 停机 |

- worker → 网关的事件：item 级事件（不带 `sequence_number`，由网关统一编号），以及 `usage`、`error`、`done`。
- worker 只接受来自网关的连接。每次启动随机生成一个内部 token，公共 API key 不传给 worker。

---

## 5. 协议到实现的映射

### 5.1 `/v1/models` 的取值（初值，B0 后修订）

| 字段 | 初值 | 说明 |
|---|---|---|
| `id` | 由 `.env` 中的公开别名配置，例如 `aporisa-local-v0` | 不暴露真实型号 |
| `context_window` | 262144 | D-07 |
| `max_output_tokens` | 32768（**待 B0**） | 思考模式在 xhigh 档可能很长 |
| `effective_context_window_percent` | 95 | 与 codex 一致 |
| `auto_compact_token_limit` | null，由 harness 按窗口的 90% 推导 | 实测延迟后再考虑给出建议值 |
| `truncation_policy` | `{"mode":"bytes","limit":10000}` | 与 codex 默认值一致 |
| `input_modalities` | B1：`["text"]`；B2 视情况加入 `"image"` | 视觉编码器放到 B2 |
| `reasoning.supported_efforts` | `["none","low","medium","high"]` | 映射见第 5.2 节 |
| `reasoning.summary` | false | 模型只输出原始推理 |
| `capabilities` | 见第 5.5 节 | 按阶段逐项开启 |

### 5.2 推理强度：由前端控制（D-14）

**接口**：协议已经预留好了，不需要新增字段。
- 请求中的 `reasoning.effort` 可以按请求设置，harness 或 UI 每一步都可以换档，对标 Claude Code 和 codex。
- `/v1/models` 返回 `reasoning.supported_efforts` 和 `default_effort`，前端据此渲染档位选择器（F5）。

| 协议 | 模型 | 采样参数 |
|---|---|---|
| `none` | `enable_thinking=false` | 非思考模式 |
| `low` | `reasoning_effort=low` | 思考模式 |
| `medium` | `reasoning_effort=medium` | 思考模式 |
| `high` | `reasoning_effort=xhigh` | 思考模式 |
| 未指定 | 使用 `default_effort` = **medium**（模型自身默认是 xhigh，太慢） | 思考模式 |

**缓存友好要求**（重要）：
- 如果模板把 `reasoning_effort` 或 `enable_thinking` 渲染在对话**开头**（例如 system 段），换一次档就会让整段前缀失效。262K 的会话要重新预填充，约需 8 到 10 分钟。
- codex 的做法：在历史**末尾**插入一个 `configuration_update` 条目来表达换档，参见 codex 的 `supports_reasoning_effort_updates`。Qwen 的相关文档中也出现了 `configuration_update` 这种输入条目，说明模型可能原生支持在对话中途换档。
- 要求：**换档只能影响渲染的尾部**。B0-6 必须查清楚档位在模板中的渲染位置，以及模型是否支持中途换档。如果模板把它放在开头，模型适配层要把它改到尾部来渲染，并用质量抽查确认模型能正确理解。
- 协议层面的待定项：协议第 3.3 节把 `reasoning` 列为 WebSocket 续接时必须一致的字段，所以换档会让本次请求退回完整发送。服务端的快照路径仍然可以复用前缀，正确性没有问题，只是多传一次完整历史。如果 B0 证实换档只影响尾部，就考虑把 `reasoning` 从续接一致字段中移除。这属于**合同变更**，要按合同第 13 节的流程，先在前端侧完成。

### 5.3 历史推理

- 模板里固定 `preserve_thinking=true`，也就是**后端按 input 原样渲染**：harness 在 input 里放了多少 reasoning item，就渲染多少。
- 保留多少历史思考，完全由 harness 决定（这是 F6 的研究变量）。后端不做任何隐式裁剪。

### 5.4 输出解析

- 解析器把模型的原始 token 流切分成协议规定的 item：思考内容 → `reasoning`（明文 `content`）；回答 → `message`；工具调用 → `function_call`。
- **具体的标记格式在 B0 阅读 chat template 之后确定**，例如思考标签、工具调用是 XML 还是 JSON。解析器必须是增量的，能边生成边产出 delta 事件。
- `phase`：B1 暂时省略（协议允许）；B2 再考虑判定 commentary 和 final_answer。
- 工具参数：必须是合法的 JSON 对象；声明了 `strict:true` 的工具，在生成阶段做约束（B2），完成后再校验一次。

### 5.5 能力开关与所属阶段

| 能力 | B1 | B2 | 说明 |
|---|---|---|---|
| `websocket` | ✅ | | D-10 |
| `prompt_cache` | ✅ | | 基于快照存储 |
| `prewarm` | ✅ | | `generate:false` |
| `input_tokens` | ✅ | | worker 用同一套渲染和 tokenize |
| `parallel_tool_calls` | 待 B0 确认模型是否支持 | | |
| `custom_tools` | ❌ | 待定 | 需要在模板里做适配（改写成只有一个字符串参数的 function），再把结果还原 |
| `structured_output` | ❌ | ✅ | mlx-vlm 有 `structured.py`，可以评估是否复用 |

---

## 6. 状态与缓存设计（核心）

### 6.1 基本事实

- **QSA 的 KV 是只追加、可以截断的**：恢复到任意长度 n，只需要截断到 n（索引键缓存同步截断）。
- **DeltaNet 状态不能截断**：只能恢复到保存过快照的位置。但它大小固定，约 100MB，**做快照的成本很低**。
- 所以快照 = 在位置 n 保存一份 DeltaNet 状态的拷贝，加上记录的长度 n。KV 本身不复制，用截断来恢复。

### 6.2 三层状态

| 层 | 内容 | 用途 |
|---|---|---|
| **活跃游标** | 每个 WebSocket 连接一个：完整的 token 序列加上活着的 cache 对象 | 精确续接：严格延长时直接追加，不需要重新渲染历史 |
| **快照存储**（内存） | 按 `prompt_cache_key` 分组：一份 KV 缓冲，加上若干个条目边界处的 DeltaNet 快照 | HTTP 请求的复用；harness 改写历史末尾后，从最近的快照恢复 |
| **SSD 溢出** | 内存放不下的 key：KV 和快照一起写成 safetensors | 切换会话、服务重启后快速恢复 |

### 6.3 条目边界快照

- 渲染时记录每个 input item 结束时的 token 位置。
- 每处理完一个 item，就在那个位置保存一次 DeltaNet 状态。每个 key 保留最近 K 个，K 的初值为 16，**待 B0 实测**。
- 同时保存一条前缀哈希链：`h[i] = H(h[i-1], 第 i 个 item 的 token 序列)`。

### 6.4 匹配流程

对每个请求：

1. **WebSocket 快速路径**：请求带 `previous_response_id`，并且和活跃游标一致 → 只渲染新增的 item，追加到游标之后。
2. **快照路径**：渲染完整请求，得到每个 item 边界处的哈希。从后往前找，第一个在快照存储中存在的边界就是可以复用的最深位置 → 把 KV 截断到这个位置、恢复对应的 DeltaNet 快照，然后预填充剩余部分。
3. **SSD 路径**：内存里没有、SSD 上有 → 先加载，再按快照路径处理。
4. **冷启动**：什么都没命中 → 从头预填充。

`usage.input_tokens_details.cached_tokens` = 恢复到的位置 n。另外，走的是哪条路径（live / snapshot / ssd / cold），会作为诊断指标记录下来。

### 6.5 token 一致性

- 模型生成的 assistant 内容，重新 tokenize 之后**不一定**等于它当初生成的 token id。一旦不一致，前缀就对不上，缓存会悄悄失效。
- 应对方法：worker 为每个输出 item 记录「内容哈希 → 生成时的 token id」的映射。之后渲染历史时，只要遇到内容相同的 assistant item，就直接使用记录下来的 token id。
- **增量渲染契约**要在 B0 验证：`render(前缀) + render(增量) == render(完整序列)` 必须在 item 边界处成立，尤其要注意生成提示符和结束标记的位置。不成立的地方，需要在适配层里修正。

### 6.6 预算与淘汰

- 快照存储有内存预算，初值 12GB，**待 B0 实测**。超出时按 key 做 LRU，把最久未用的整组溢出到 SSD。
- SSD 层有容量上限（例如 200GB），超出后同样按 LRU 淘汰。
- 预热（`generate:false`）的结果按普通请求处理：写入快照存储，并更新活跃游标。

### 6.7 正确性要求

- 缓存必须是**精确**的：从快照恢复后，前向计算的结果要和冷启动一致，误差只允许来自 kernel 分块形状不同导致的浮点差异。
- B0 要写一个对照测试：在同一个位置分别走「冷启动」和「快照恢复」两条路径，比较下一个 token 的 logits，最大差异要低于一个阈值（阈值由实测确定）。

---

## 7. 生成循环

1. **预填充**：分块处理，块大小的初值为 2048，**待 B0 调优**。每一块之间检查取消和中断信号。
2. **解码**：按思考模式或非思考模式使用固定的采样参数。
   - B2 启用 MTP 投机解码。
   - B2 评估**提示词查找投机**：mlx-vlm 没有实现，需要自研；草稿被拒时的 DeltaNet 状态回滚，复用 MTP 已有的代码。
3. **停止条件**：遇到结束标记、达到 `max_output_tokens`（以 `incomplete` 结束，原因 `max_output_tokens`）、收到中断（以 `incomplete` 结束，原因 `interrupted`，丢弃进行到一半的 item）、收到取消（直接结束，不发终止事件）。
4. **usage**：`input_tokens` 是完整的 prompt token 数；`cached_tokens` 是恢复到的位置；`output_tokens` 是实际生成的 token 数；`reasoning_tokens` 由解析器统计思考区间内的 token。

---

## 8. 准入、资源上限与停机

以 local_llm 的做法为参照，重新实现。所有数值集中放在 `configs/` 中。

| 项目 | 初值 |
|---|---|
| 实际并发 | 1 |
| 额外排队 | 2 |
| 排队等待超时 | 60 秒，超时返回 429 `queue_timeout` |
| 单次生成总期限 | 1800 秒 |
| 空闲超时 | 收到第一个 token 后，连续 180 秒没有新 token 就判定超时 |
| HTTP 正文 | 16 MiB |
| 输出字节 | 4 MiB |
| WebSocket 连接最长寿命 | 60 分钟，与 codex 一致 |

- **停机顺序**：关闭准入 → 唤醒排队中的请求 → 限时 drain → 取消剩余请求 → 结束 worker 进程组。
- **恢复**：worker 崩溃后，网关把状态标记为 recovering，拒绝新请求并返回 503；最多重启 2 次，每次都要重新预热。worker 重启后内存中的状态全部丢失，SSD 层的数据仍然可用。

---

## 9. 生命周期与部署

- **唯一公开入口**：`backend_service.sh`，模式为 `doctor / prepare / install / start / stop / restart / status / uninstall / help`，语义与 AGENTS.md 一致。在 macOS 上由系统 LaunchDaemon 管理。
- **`prepare`**，这是唯一联网的模式：
  1. 安装项目内的 uv，并用 Python 3.12 按 `backend/uv.lock` 安装依赖。mlx 和 mlx-vlm 都锁定到具体版本或 commit。
  2. 按固定的 revision 下载官方 FP8 checkpoint（**待确认实际大小**）。
  3. 转换成选定的量化格式。
  4. 生成外置 PLE 的模型视图（硬链接）；必要时把 PLE 重排成按行存储的格式。
  5. 拆出 MTP 草稿模型（B2）。
  6. 计算全部产物的 SHA256，写入准备收据。
- **`doctor`** 检查：
  - Apple Silicon、Metal 可用；
  - 空闲磁盘；
  - 准备收据和完整的 SHA256；
  - `.env` 配置；
  - **GPU 可锁定内存上限**：读取 `sysctl iogpu.wired_limit_mb`，低于要求时报 `[MANUAL]`，并给出需要用户自己执行的命令；
  - 启动前的可用内存；
  - 端口。
- **`start`**：完全离线；加载模型 → 运行预热（纯文本、工具调用、预热 + 续接、上下文超长的拒绝路径）→ 就绪。
- **`.env`**，放在 `backend/.env`，只放部署差异：API key、公共端口、公开模型别名。
- **日志**：JSONL，字段走白名单，不记录任何正文、思考内容或工具参数。控制台使用 `[Aporisa]` 标签。

---

## 10. 可观测性

B1 起，每个请求记录以下字段，这些数据同时也是报告的实验数据：

| 字段 | 含义 |
|---|---|
| `transport` | http 或 websocket |
| `restore_path` | live、snapshot、ssd 或 cold |
| `prompt_tokens`、`cached_tokens`、`prefilled_tokens` | 总 prompt 长度、复用长度、实际预填充长度 |
| `ttft_ms`、`prefill_tok_s`、`decode_tok_s` | 首 token 时间、预填充速度、解码速度 |
| `mtp_accept_rate` | MTP 草稿接受率（B2） |
| `peak_memory_gb` | 峰值内存 |
| `ple_bytes_read`、`ple_cache_hit_rate` | PLE 从 SSD 读取的字节数，以及行缓存命中率 |
| `snapshot_count`、`snapshot_bytes`、`ssd_spill_count` | 快照数量、占用、溢出次数 |

通过需要认证的 `GET /health/runtime` 查看运维状态。这不属于公共协议。

---

## 11. 代码结构（草案）

```
backend/
├── DEVELOPMENT_PLAN.md          本文
├── .env.example
├── pyproject.toml / uv.lock
├── src/aporisa_backend/
│   ├── configs/                 按主题拆分的策略：network / limits / model / cache / logging …
│   ├── gateway/                 app、http_sse、websocket、admission、validation、errors、health
│   ├── ipc/                     帧格式、消息类型、客户端和服务端
│   ├── engine/
│   │   ├── worker.py            进程入口与主循环
│   │   ├── loader.py            模型加载（外置 PLE、量化产物）
│   │   ├── adapter/             模型适配层：template、tokenizer、parser
│   │   ├── state/               活跃游标、快照存储、SSD 溢出、前缀哈希
│   │   ├── generate.py          预填充、解码、停止条件
│   │   └── speculative/         MTP、提示词查找（B2）
│   ├── lifecycle/               checks、artifacts、receipts、cli
│   └── logging_config.py
├── scripts/                     prepare、convert、benchmark、validate_runtime
└── tests/                       单元测试（worker 使用假模型），网关测试（使用假 worker）
```

- **合同校验**：网关用 `jsonschema`，对照 `docs/schema/aporisa-protocol-v0.schema.json` 校验形状，另外用 Python 重新实现语义规则。
- **最终判定**：前端的一致性测试 `npm run conformance`。

---

## 12. 测试与验收

| 层 | 内容 | 由谁运行 |
|---|---|---|
| 单元测试 | 模板的增量渲染契约、增量解析器、快照存储的匹配和淘汰（使用假 cache）、准入、错误映射 | `./scripts/check.sh backend`，**用户运行** |
| 网关测试 | 使用假 worker 覆盖两种传输、取消、中断、超时 | 同上 |
| 一致性测试 | 前端的 W01–W22，对真实服务运行 | 用户在 Studio 上运行 |
| 真实模型验证 | 文本、工具调用、续接、快照恢复的数值对照 | 用户运行 |
| 基准测试 | 第 13 节 B0 的各项测量，结果写进 `docs/validation.md` | 用户运行 |

---

## 13. 阶段划分

### B0：探路与实测

**目标**：把所有「待 B0 实测」的数值变成实测结果，并验证关键假设。**不写正式的服务代码**，只写一次性脚本，放在 `backend/scripts/`。

| # | 任务 | 验收标准 |
|---|---|---|
| B0-1 | 环境：安装 uv 和 Python 3.12，把 mlx 和 mlx-vlm 锁定到某个 commit；记录 macOS 版本和 `iogpu.wired_limit_mb` 的当前值 | 版本信息记录在案 |
| B0-2 | 下载官方 FP8 checkpoint，确认实际大小 | 大小和 revision 记录在案 |
| B0-3 | 转换两个候选格式：affine 4-bit gs64 和 mxfp4（PLE 都用 affine 4-bit gs32），各自生成外置 PLE 的视图 | 两份产物可以加载 |
| B0-4 | **内存**：分别在空上下文、128K、262K 下测峰值内存，并确定需要的 GPU 可锁定内存上限 | 262K 满上下文能运行，并给出余量 |
| B0-5 | **速度曲线**：在 2K、32K、128K、262K 四个点测预填充速度和解码速度；对比两种量化格式和不同的预填充分块大小 | 曲线和推荐配置 |
| B0-6 | **chat template 研究**：确认思考标签、工具调用格式、并行工具调用，以及 `preserve_thinking` 的渲染方式；**`reasoning_effort` 和 `enable_thinking` 在模板中的渲染位置，以及是否支持用 `configuration_update` 在对话中途换档** | 写入本文第 5.2 和 5.4 节；给出换档不影响已有前缀的渲染方案 |
| B0-7 | **增量渲染契约**：在 item 边界处验证 `render(前缀) + render(增量) == render(完整序列)`；验证重新 tokenize assistant 文本后与生成时的 token id 是否一致 | 列出不成立的地方，以及对应的修正方案 |
| B0-8 | **快照正确性**：在同一位置分别走冷启动和「截断 KV + 恢复 DeltaNet 快照」，比较 logits | 差异低于阈值；测出单个快照的实际大小 |
| B0-9 | **续接收益**：模拟一段 agent 循环（每步追加 2K token 的工具输出），对比有续接和每步冷启动的首 token 时间 | 量化收益 |
| B0-10 | MTP：比较开启前后的解码速度，以及接受率 | 决定 B2 是否默认开启 |
| B0-11 | 边界：在 262,144 个 token 附近测试是否正常 | 没有异常，或者记录异常位置 |
| B0-12 | 质量抽查：用一小组 agent 类任务，对比 Flash-Next 与 Qwen3.8-27B | 确认是否需要启用 D-12 的备选 |

**B0 的交付**：`docs/validation.md` 中的 B0 实测章节；本文中所有「待 B0」的数值都替换成实测值；确定量化格式。

### B1：协议核心

**目标**：一个可用的后端，通过全部一致性测试。

| # | 任务 | 验收标准 |
|---|---|---|
| B1-1 | 工程骨架：`pyproject.toml`、`uv.lock`、`configs/`、白名单日志、`scripts/check_backend.sh` 接入 `check.sh backend` | 用户运行 `./scripts/check.sh backend` 通过 |
| B1-2 | 生命周期：`backend_service.sh` 全部模式；LaunchDaemon 模板；准备收据；GPU 可锁定内存上限检查 | 状态机和 local_llm 同样严格；用户手动完成验收 |
| B1-3 | 网关：认证、严格 JSON、schema 和语义校验、准入、两种传输、错误映射、健康检查 | 使用假 worker 的网关测试通过 |
| B1-4 | IPC 以及 worker 的启动和恢复，恢复次数有上限 | 杀掉 worker 后能按规定恢复 |
| B1-5 | 模型适配层：模板渲染、tokenize、增量解析（推理、消息、工具调用） | 单元测试覆盖 B0-6 确认的格式 |
| B1-6 | 状态层：活跃游标（WebSocket 精确续接）、内存中的快照存储、前缀哈希、token 一致性映射 | 匹配和淘汰的单元测试；B0-8 的对照测试在正式代码中重跑并通过 |
| B1-7 | 能力：`prompt_cache`、`prewarm`、`input_tokens`、`websocket` | 对应的一致性用例（W14–W22）通过 |
| B1-8 | 启动预热和就绪检查 | `start` 只有在预热通过后才报告就绪 |
| B1-9 | 可观测性：第 10 节的字段，以及 `/health/runtime` | JSONL 中包含这些字段，且没有任何正文 |

**B1 的验收**：在 Studio 上运行 `npm run conformance`，W01–W22 全部通过；集成节点 I1 可以开始，即 Air 上的 native driver 指向 Studio，F1 的测试全部重跑通过。

### B2：性能与本地专属能力

| # | 任务 | 验收标准 |
|---|---|---|
| B2-1 | 快照溢出到 SSD，以及服务重启后的恢复 | 重启后恢复一个 200K 的会话，首 token 时间在秒级 |
| B2-2 | 默认开启 MTP 投机解码 | 解码速度的提升与 B0-10 一致 |
| B2-3 | 提示词查找投机（自研），可以和 MTP 组合 | 在代码编辑类任务上，解码速度有可测的提升 |
| B2-4 | 结构化输出（`structured_output`），以及工具参数的 `strict` 约束 | 对应的能力开启，测试通过 |
| B2-5 | 按 B0 数据调优：分块大小、快照数量 K、内存预算、PLE 行缓存 | 调优前后的对比数据 |
| B2-6 | 视情况实现：图片输入、`custom_tools`、`phase` 判定 | 逐项决定 |
| B2-7 | 长时间 soak：连续跑数小时的 agent 循环，观察内存是否泄漏、速度是否衰减 | 记录在 `validation.md` |

**B2 的验收**：集成节点 I2，即 F6 和 F7 的实验在「完整 C」下重跑，并与 OpenRouter 的结果对照。

---

## 14. 待定问题

- [ ] 量化格式：affine 4-bit gs64 还是 mxfp4（B0-3、B0-5）
- [ ] `max_output_tokens` 的取值
- [ ] 换档的渲染方案，以及是否把 `reasoning` 从 WebSocket 续接一致字段中移除（合同变更，B0-6 之后决定）
- [ ] 快照数量 K、快照存储的内存预算、SSD 层的容量
- [ ] 思考标签和工具调用的格式（B0-6）
- [ ] 私有 IPC 的最终格式（msgpack 还是其他）
- [ ] 图片输入是否在 B2 实现
- [ ] 官方 FP8 checkpoint 的实际大小和固定的 revision

## 15. 变更记录

- **2026-09-29**：初稿。记录 D-01 到 D-13；给出架构、缓存设计，以及 B0、B1、B2 的划分。
- **2026-09-29**：新增 D-14，推理强度由前端控制，默认 medium，并提出换档不能让缓存失效的要求。本文是临时开发文档，后端完成后会拆分到 `docs/` 并删除。
