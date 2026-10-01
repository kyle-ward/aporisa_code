# Aporisa 后端开发文档

> **状态：B0 已完成（2026-09-30），B1 实现中。** 本文随讨论和实测动态更新。标为「已定」的内容是和用户确认过的决策；标为「待 B0 实测」的数值只是估计，不能当作事实引用。
>
> - 协议合同是 [docs/protocol.md](../docs/protocol.md)。后端**实现**合同，不修改合同；需要改合同时，按合同第 13 节的流程，先在前端侧完成前几步。
> - 协作规则见 [AGENTS.md](../AGENTS.md)。
> - 本文是**临时开发文档**：后端完成后，稳定的内容拆分到 `docs/architecture.md`、`docs/macos.md` 等文件，然后删除本文。
> - 最后更新：2026-09-29

---

## 1. 目标与范围

**目标**：在 Mac Studio（M3 Ultra，96GB）上提供一个通用、无状态语义的本地推理服务，完整实现 Aporisa 协议，并通过前端仓库中 W01–W24 的 wire 层一致性测试。重点是把**本地独有的状态控制**做好，包括精确续接、快照复用、预热，为 harness 的上下文管理研究提供底层能力。

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
| D-03 | 推理引擎：**MLX**，以 **mlx-vlm 作为库**来加载模型和使用算子，**不使用** `mlx_vlm.server`。mlx-vlm 锁定到具体的 git commit：`00093678a1f6bd513212d94778ffc381d6d731bf`（v0.7.4 tag，2026-09-28），mlx 为 0.32.3（B0-1 已定） | 51B 表外置、混合缓存、MTP 都已在上游实现；状态可控；Python 技术栈与 local_llm 一致 |
| D-04 | **51B 的 N-gram/PLE 表放在 SSD 上**，使用 mlx-vlm 的 `ple_storage` 按行 mmap 读取 | 用户决定；可以省下约 30GiB 常驻内存 |
| D-05 | 量化文件**自己从官方 FP8 checkpoint 转换**，不用社区现成的 group size 32 版本。**格式定为 affine 4-bit gs64**（B0 结论）：128K 以内解码更快、每权重 4.5 bit、B0-12 的抽查中表现最直接；mxfp4 省 3.7 GiB，作为内存紧张时的备选。转换配方见 `backend/scripts/b0_convert.py`：PLE 固定为 affine 4-bit gs32，路由门控 8-bit，视觉编码器不量化；**必须绕过 mlx-vlm 通用加载器的 FP8→MXFP8 转换**，否则专家权重会停留在 8-bit | 社区版外置 PLE 后主体仍有约 77–80GB，太紧 |
| D-06 | **单并发**：同一时刻只有一个生成在运行 | 硬件约束，也是用户的使用场景 |
| D-07 | 上下文窗口 **262,144**（原生上限），不做 YaRN 扩展 | 用户决定 |
| D-08 | **双进程结构**：网关进程加引擎 worker 进程，通过私有 IPC 通信 | 引擎崩溃可以单独重启；网关与模型无关；延续 local_llm 的「网关 + 私有引擎」边界 |
| D-09 | **自研快照缓存**：只借鉴 `apc.py` 的思路，不直接复用它 | 用户决定；这是研究核心，需要完全可控、可观测 |
| D-10 | 两种传输都实现，**WebSocket 为默认**，HTTP 可以显式指定，也作为兜底 | 协议第 3 节 |
| D-11 | 协议不暴露 `temperature` 和 `seed`；采样参数按思考模式和非思考模式，使用模型卡片推荐的固定值 | 用户决定 |
| D-12 | 备选模型：**Qwen3.8-27B**。如果 Flash-Next 在可行的量化下质量或速度不达标，就切换过去，协议和网关都不用改。**B0-12 结论：暂不需要**，Flash-Next 通过了全部抽查任务 | 社区评测显示 4-bit 下两者质量相当 |
| D-13 | 提速采取「**架构一步到位，参数分步调优**」：精确续接、条目边界快照、SSD 溢出、token 一致性、预热、MTP 从设计阶段就纳入；各种数值由实测决定 | 用户要求优化一步到位 |
| D-14 | **推理强度由前端按请求控制**，对标 Claude Code 和 codex；`default_effort` 为 **medium**；**切换档位不能让已有的前缀缓存失效**（见第 5.2 节） | 用户决定 |
| D-15 | **模型配置、本地权重、服务生命周期三者解耦**，照搬 local_llm：configs 中维护 `MODEL_LIST` / `POINTERS` / `PROFILES`；权重由独立的 `model_weights.sh`（download / convert / list / delete）维护，并登记本地身份记录；`prepare` 只核验权重，不下载、不转换 | 用户决定；Qwen 系列之后可能出更强的模型，换模型只改指针。规则见 AGENTS.md「模型配置与权重」 |
| D-16 | GPU 可锁定内存上限**持久化**到 `/etc/sysctl.conf`，暂定 85 GiB（87040 MB）；doctor 和 start 仍然检查实际值 | 用户决定（2026-09-29 已设置并确认：文件内容与运行时的值都是 87040）；否则重启后后端无法开机自启 |
| D-17 | 换档采用**方案 C**，照搬 codex 的 `configuration_update`：请求的 `reasoning.effort` 是一个上下文窗口内固定的基线；换档由 harness 在历史尾部追加 `configuration_update` 输入 item 来表达；新增能力 `reasoning_effort_updates`。合同已按第 13 节的流程同步到前端（协议文档 → 类型和 schema → mock → 一致性测试 W23、W24 → SDK 和兼容文档） | 用户决定：缓存完全友好，且贴近 codex；前端开发暂停期间，由后端侧同步修改合同 |

---

## 3. 硬件与模型事实

详细来源见课程目录下的调研笔记（不在本仓库）。以下数值来自公开资料，**尚未在本机实测**。

| 项目 | 数值 |
|---|---|
| 硬件 | Mac Studio M3 Ultra，96GB 统一内存；macOS 默认允许 GPU 锁定约 75% 的内存，可以用 `sysctl iogpu.wired_limit_mb` 提高，**由用户执行**。单独执行 sysctl 重启后会失效，所以同时写入 `/etc/sysctl.conf` 做持久化（D-16） |
| 参数 | 125B MoE，每 token 激活 6B（512 个专家中选 10 个，另有 1 个共享专家）；另外有 51B 的 N-gram/PLE 表、4B 的 MTP 层，以及视觉编码器 |
| 层结构 | 48 层，排列为 12 ×（3 × Gated DeltaNet + 1 × Qwen Sparse Attention），每层后接 MoE；隐藏维度 2560 |
| DeltaNet | 线性注意力，保存**大小固定的循环状态**，不能截断 |
| QSA | 稀疏注意力，2 个 KV 头，head dim 256，每个 token 只看 2048 个 token 的预算。另外维护一个索引键缓存 |
| PLE | 2000 万条 n-gram，在第 2 层注入。每个 token 按哈希读 16 行，约 2.7KB。Q4 group size 32 下约 30GiB |
| 上下文 | 原生 262,144 |
| 官方 checkpoint | BF16：`Qwen/Qwen3.8-Flash-Next`，360.0 GB，revision `de4b8e4d43b917e7706784d8bb445c9af86a3540`；FP8：`Qwen/Qwen3.8-Flash-Next-FP8`，185.6 GB，144 个文件，revision `236dfdf285828023ca3bcd3f37366c58a3469b13`。数据来自 HF API（2026-09-29），许可证为 **Qwen Community License 1.0**（见下一行） |
| 许可证要点 | 允许使用、修改、衍生，包括量化；第 2 条规定：从事「AI Work Assistant」业务（定义为主要用于 AI 辅助编程或办公的独立产品，**Aporisa Code 正属于这一类**）的商业用途，需要另外取得 Qwen 的授权；**内部使用豁免**，前提是不把软件、它的输出或模型能力提供给第三方。本项目目前是个人本机使用。若将来对外发布或商用，需要重新评估。这不是法律意见，正式条款写入 `models-and-licenses.md` |
| mlx-vlm 实现 | 架构名 `qwen4_exp`；外置 PLE（`ple_storage.py`）只支持两种 PLE 量化布局：affine 4-bit gs32 和 nvfp4 gs16；FP8 转换（`fp8.py`）和 MTP 草稿模型（`split_mtp`）都在 v0.7.4 中 |
| 思考控制 | `enable_thinking`（默认开）、`preserve_thinking`（默认开）、`reasoning_effort`：xhigh / medium / low |
| 采样 | 思考模式：temperature 1.0、top_p 0.95、top_k 20；非思考模式：temperature 0.7、top_p 0.8、top_k 20、presence_penalty 1.5 |

**内存**（B0-4 实测，2026-09-30，外置 PLE，GPU 可锁定上限 85 GiB；详见 [validation.md](../docs/validation.md)）：

| 部分 | affine 4-bit gs64 | mxfp4 |
|---|---|---|
| 常驻权重（不含 PLE，视觉编码器占 0.84 GiB） | 66.8 GiB | 63.1 GiB |
| PLE 表（在 SSD 上按行读取） | 29.8 GiB，不常驻 | 同左 |
| QSA 的 KV 加索引键 | 约 29 KB/token，260K 时 7.0 GiB | 同左 |
| DeltaNet 状态（按参数计算） | 约 113 MB，大小固定 | 同左 |
| 峰值：2K / 32K / 128K / 260K | 70.3 / 71.4 / 75.3 / **80.0 GiB** | 65.9 / 66.9 / 70.8 / **75.6 GiB** |
| 260K 时距 85 GiB 上限的余量 | 约 5 GiB | 约 9.4 GiB |

- 满上下文在两种格式下都能运行。快照存储、PLE 行缓存等可变开销只能用余量，所以它们的预算必须随上下文长度收缩（第 6.6 节）。
- **MLX 默认不锁定任何内存**（wired 上限为 0）。worker 必须在加载模型之前调用 `mx.set_wired_limit`，否则 macOS 会压缩、换出权重，速度下降一个数量级（B0-4 第一次测量时实际发生过）。

**速度**（B0-5 实测，分块 2048；预填充括号内是扣除 PLE 读取后的纯计算速度，即 worker 把 PLE 读取和计算重叠后的上限）：

| 上下文 | affine 预填充 | affine 解码 | mxfp4 预填充 | mxfp4 解码 |
|---|---|---|---|---|
| 2K | 576（954） | 30.2 | 492（793） | 25.7 |
| 32K | 610（771） | 26.2 | 603（769） | 24.1 |
| 128K | 550（682） | 20.9 | 580（712） | 21.2 |
| 260K | 473（574） | 16.2 | 500（601） | 18.7 |

单位 tok/s。262K 冷启动预填充约 7.5–9 分钟。MTP（B0-10，mlx-vlm 的 `draft_block_size=3`，即每轮 2 个草稿；B0 记录中称「起草深度 3」）：贪心 49 tok/s（1.57 倍），思考模式 45 tok/s（1.47 倍），B2 启用。

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

### 5.1 `/v1/models` 的取值（B0 后已修订）

| 字段 | 取值 | 说明 |
|---|---|---|
| `id` | configs 中 `POINTERS` 的 key，例如 `aporisa-local-v0` | 不暴露真实型号；不放进 `.env`（D-15） |
| `context_window` | 262144 | D-07 |
| `max_output_tokens` | 32768（B0 定） | 长上下文下解码 16–30 tok/s（B0-5），32K 个输出 token 约需 18–34 分钟，和 1800 秒的单次生成期限相当；再大就会先触发期限。B2 启用 MTP 后重新评估 |
| `effective_context_window_percent` | 95 | 与 codex 一致 |
| `auto_compact_token_limit` | null，由 harness 按窗口的 90% 推导 | 实测延迟后再考虑给出建议值 |
| `truncation_policy` | `{"mode":"bytes","limit":10000}` | 与 codex 默认值一致 |
| `input_modalities` | B1：`["text"]`；B2-6 起 `["text","image"]` | 视觉塔随模型权重一起加载 |
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

**B0-6 结论：官方模板中档位的渲染位置**（依据 `chat_template.jinja`，revision `236dfdf`）：

| 档位 | 模板变量 | system 段开头注入的文字 | 生成提示符 |
|---|---|---|---|
| `high` | `reasoning_effort=xhigh`（模板默认值） | 一段 xhigh 指令 | `<\|im_start\|>assistant\n<think>\n` |
| `medium` | `reasoning_effort=medium` | **无** | 同上 |
| `low` | `reasoning_effort=low` | 一段 low 指令 | 同上 |
| `none` | `enable_thinking=false` | **无** | `<\|im_start\|>assistant\n<think>\n\n</think>\n\n` |

- 档位指令写在对话**最开头**的 system 段第一行，排在工具定义和 `instructions` **之前**。所以只要切换到 `low` 或 `high`，或者从它们切换回来，整段前缀都会失效。
- 例外：`medium` 和 `none` 在前缀中**都不注入任何文字**，两者的区别只在生成提示符（尾部）。它们之间来回切换，对缓存完全友好。
- 模板和模型卡片里**都没有** `configuration_update`，也没有任何在对话中途换档的机制。mlx-vlm v0.7.4 中同样没有。原先「模型可能原生支持」的假设**不成立**，下面按模型不支持中途换档来设计。
- 模型卡片提示：在多轮 agent 任务中，降低档位不一定缩短总耗时。

**已定：方案 C（D-17）**。协议见 [protocol.md](../docs/protocol.md) 第 6.1 节和第 7.1 节的 `configuration_update`；当初的四个候选方案：A 照搬模板、B 尾部临时指令、C 尾部指令写入历史、D 只保留缓存友好的档位。

**合同层面**：
- 请求的 `reasoning.effort` 是**基线**，harness 在一个上下文窗口内保持它不变；换档时在历史尾部追加 `{"type":"configuration_update","reasoning":{"effort":...}}`，这个 item 作为历史保存并原样回传。
- 生效强度 = 最后一个 `configuration_update` 的强度；没有时取基线；再没有时取 `default_effort`。生效强度为 `none` 时不得产生 reasoning item。
- `reasoning` 仍然是 WebSocket 续接的一致字段。换档不改这个字段，所以不会打断续接。原来「是否把 `reasoning` 从续接一致字段中移除」的待定项就此取消。

**后端渲染方案**（模型适配层）：
- **基线**按官方模板渲染在 system 段开头：`high` 渲染为 xhigh 指令，`low` 渲染为 low 指令，`medium` 和 `none` 不渲染文字。一个上下文窗口内基线不变，所以前缀稳定，最常见的情况下也完全贴合训练分布。
- **每个 `configuration_update`** 在它所在的位置渲染为一个短指令段（候选格式：`<|im_start|>system\n{指令}<|im_end|>\n`）。xhigh 和 low 的指令文字沿用官方模板的原文；medium 和 none 没有官方原文，需要自拟，例如「Reasoning effort is set to medium.」。它只依赖目标强度，和前一个强度无关，保证渲染是确定性的。
- **生成提示符**由生效强度决定：生效强度为 `none` 时用 `<think>\n\n</think>\n\n`，其他强度用 `<think>\n`。历史中这一轮的渲染（空的 think 块）与生成时一致，不破坏 token 一致性。
- 采样参数同样按生效强度切换：`none` 用非思考模式的参数，其他用思考模式的参数。
- **B0-12 结论**：中途的 system 段和 user 段都不会造成异常，中途切换到 `none` 时推理确实为 0。B1 采用**中途 system 段**，因为它和「harness 发出的配置」语义一致，也和 developer 的渲染方式相同。档位对推理量的实际影响在简单题上看不出差异，留到更难的任务上评估（F6 或 B2），指令文字届时可以再调。

### 5.3 历史推理

- 模板里固定 `preserve_thinking=true`，也就是**后端按 input 原样渲染**：harness 在 input 里放了多少 reasoning item，就渲染多少。
- 保留多少历史思考，完全由 harness 决定（这是 F6 的研究变量）。后端不做任何隐式裁剪。
- **B0-6 确认 `preserve_thinking=true` 是必须的**：设为 false 时，每条历史 assistant 消息是否渲染思考，取决于「最后一条真正的用户提问」在哪里。一旦来了新的用户消息，更早的历史的渲染结果就会改变，增量渲染契约随之失效。
- 设为 true 时，每条 assistant 消息都会渲染成 `<think>\n{reasoning|trim}\n</think>\n\n{content|trim}`；没有 reasoning item 时是一个空的 think 块。所以 harness 丢弃某些 reasoning item 也是确定性的，只影响丢弃位置之后的缓存。

### 5.4 输出解析与渲染映射

**输出格式**（B0-6 确认）：
- 思考模式下，生成提示符以 `<think>\n` 结尾；模型依次输出推理文本、`\n</think>\n\n`、回答文本，然后可以跟若干工具调用，最后以 `<|im_end|>` 结束。停止 token 为 248046 `<|im_end|>` 和 248044 `<|endoftext|>`（B0-6 确认）。`<think>` 248068、`</think>` 248069、`<tool_call>` 248058、`</tool_call>` 248059 都是**单个 token**（非 special 的 added token）；`<function=`、`<parameter=` 是普通文本，会拆成多个 token。tokenizer 不加 BOS。
- 工具调用是 **XML 格式**（Qwen3-Coder 风格），不是 JSON：
  ```
  <tool_call>
  <function=NAME>
  <parameter=ARG>
  VALUE
  </parameter>
  </function>
  </tool_call>
  ```
  渲染历史时，字符串类型的参数值原样写入，其他类型写成 JSON。解析时要按该工具的参数 schema 把值还原成正确的类型，才能得到协议要求的 JSON 对象字符串。
- 格式本身允许一条 assistant 消息包含多个 `<tool_call>` 块，每块之间用 `\n` 分隔。工具调用**之前**可以有自然语言，**之后**不允许有任何内容。

**解析器要求**：
- 增量解析：推理区间产出 `reasoning_text.delta`；回答产出 `output_text.delta`；每个参数闭合时，产出一段 `function_call_arguments.delta`，形如 `{` → `"k":v` → `,` … → `}`，保证所有 delta 拼起来等于最终的 arguments。
- 自己实现，不复用 mlx-vlm 的 `qwen3_coder.py`：它把任何类型的 `"null"` 都转成 None，并且对未知类型使用 `ast.literal_eval`，太宽松。我们的解析器按 schema 严格转换；无法得到合法 JSON 对象时，按错误处理（错误码待定）。
- `parallel_tool_calls=false` 时，第一个 `</tool_call>`（token 248059）就是停止条件，不让第二个调用生成出来。
- **`phase` 可以在 B1 实现，成本很低**：message item 结束时，要么后面紧跟 `<tool_call>`，要么是 `<|im_end|>`。前者判定为 `commentary`，后者判定为 `final_answer`，在发出 `output_item.done` 之前就能确定。

**输入渲染映射**（适配层自行渲染，不直接调用模板；token 必须和官方模板的输出逐字一致，除非下面明确说明偏离）：
- system 段的顺序：档位指令（按上面的方案）→ `# Tools` 区块 → `instructions`。
- 工具定义：模板对每个工具做 `tojson`。按 OpenAI 的嵌套形状 `{"type":"function","function":{name,description,parameters}}` 渲染（这也是模型训练时见过的形状），协议中的 `strict` 字段不渲染。
- 连续的 `reasoning`、assistant `message`、`function_call` item 合并成模板中的**一条** assistant 消息。
- `function_call_output` 渲染为 tool 角色：连续多条合并进同一个 `<|im_start|>user` 段，每条用 `<tool_response>` 包起来。注意：一条工具结果后面是否跟 `<|im_end|>`，取决于下一条是不是工具结果。所以 item 边界要以「一组工具结果」为单位来定义。B0-7 确认：两条连续工具结果之间是唯一不满足前缀性质的边界，其他边界在字符串和 token 两个层面都满足。
- **`developer` 角色模板不支持**（遇到会抛异常），而且 system 只允许出现在开头。**B0-12 结论**：在原位置渲染为 `<|im_start|>system` 段和渲染为 user 段，模型都会遵守；B1 采用在原位置渲染为 system 段。
- 模板要求至少有一条不是纯工具结果的 user 消息，否则抛异常。这条约束只是为 `preserve_thinking=false` 服务的，我们固定为 true，所以不强制。
- 历史中的 reasoning 和回答文本都会被 `trim`；生成结束于 `<|im_end|>`，历史渲染还会在它后面补一个 `\n`。这两点都可能让「重新渲染」和「生成时的 token」不一致，交给第 6.5 节处理。
- `tool_choice:"none"`：模板没有对应的机制。不渲染工具会改变前缀，所以倾向于保留工具定义，在解码阶段禁止生成 token 248058 `<tool_call>`（B0-6 确认它是单个 token）。

**采样参数**（模型卡片确认，与 D-11 一致）：思考模式 `temperature=1.0, top_p=0.95, top_k=20, min_p=0, presence_penalty=0, repetition_penalty=1.0`；非思考模式 `temperature=0.7, top_p=0.8, top_k=20, min_p=0, presence_penalty=1.5, repetition_penalty=1.0`。`presence_penalty` 需要在采样器中实现。

**输出长度**：模型卡片建议给足输出预算（在 1M 上下文下，推理 262,144、回答 131,072）。本项目的 `max_output_tokens` 仍然待定（第 15 节）。

### 5.5 能力开关与所属阶段

| 能力 | B1 | B2 | 说明 |
|---|---|---|---|
| `websocket` | ✅ | | D-10 |
| `prompt_cache` | ✅ | | 基于快照存储 |
| `prewarm` | ✅ | | `generate:false` |
| `input_tokens` | ✅ | | worker 用同一套渲染和 tokenize |
| `reasoning_effort_updates` | ✅ | | D-17；按上面的渲染方案实现 |
| `parallel_tool_calls` | ✅ | | B0-12：三个模型都能在同一回复中给出两个调用；为 false 时在第一个 `</tool_call>` 处停止 |
| `custom_tools` | ❌ | 待定 | 需要在模板里做适配（改写成只有一个字符串参数的 function），再把结果还原 |
| `structured_output` | ❌ | ✅ | B2 P3：llguidance 约束解码，语义见协议第 8.4 节 |

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
| **SSD 溢出** | 内存放不下的 key：KV 和快照一起写入 SSD（B2 P4 实现为按内容寻址的块和检查点，见下文 P4 要点） | 切换会话、服务重启后快速恢复 |

### 6.3 条目边界快照

- 渲染时记录每个 input item 结束时的 token 位置。
- 每处理完一个 item，就在那个位置保存一次 DeltaNet 状态。每个 key 保留最近 K 个，K=16（B0-8：单个快照 110 MiB，16 个约 1.8 GB；受第 6.6 节的动态预算约束，B2-5 调优）。
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
- **增量渲染契约**（B0-7 静态部分已验证，当时的脚本 `backend/scripts/b0_render.py` 已在 B1 收尾时删除，见提交 `c89d1b2`；正式代码中由 `tests/test_qwen38_adapter.py` 覆盖）：
  - 除「两条连续工具结果之间」外，所有 item 边界上 `render(前缀)` 在字符串和 token 两个层面都是 `render(完整序列)` 的前缀。
  - **必须按段 tokenize**：生成提示符以 `<think>\n` 结尾，推理为空时模型先生成 `\n` 再生成 `</think>`，整段重新 tokenize 时两个 `\n` 会合并成一个 `\n\n` token。所以适配层在生成提示符处切段，前后分别 tokenize，并按原样拼接生成的 token id。
  - 非字符串的工具参数按 Python `json.dumps` 默认格式（`", "`、`": "`）渲染；模型生成的 JSON 格式不同时，重新渲染会对不上，只能靠上面的映射。
  - 生成的 token 与重新渲染的对比（动态部分）由 B0-12 的 `quality` 子命令记录。

### 6.6 预算与淘汰

- 快照存储有内存预算。B0-4 实测：affine 格式在 260K 时只剩约 5 GiB 余量，**原定的固定 12GB 预算不成立**。预算改为「余量 − 安全边际」，随当前活跃上下文长度动态收缩（短上下文时可以用到十几 GB，满上下文时只保留当前会话的少量快照）。单个 DeltaNet 快照约 113 MB，K=16 约 1.8 GB。超出时按 key 做 LRU，把最久未用的整组溢出到 SSD。
- SSD 层有容量上限（B2 定稿为 64 GiB），超出后同样按 LRU 淘汰。
- 预热（`generate:false`）的结果按普通请求处理：写入快照存储，并更新活跃游标。

### 6.7 正确性要求

- 缓存必须是**精确**的：从快照恢复后，前向计算的结果要和冷启动一致，误差只允许来自 kernel 分块形状不同导致的浮点差异。
- B0 要写一个对照测试：在同一个位置分别走「冷启动」和「快照恢复」两条路径，比较下一个 token 的 logits，最大差异要低于一个阈值（阈值由实测确定）。

---

## 7. 生成循环

1. **预填充**：分块处理，块大小定为 **2048**（B0-5：32K 下 512 明显更慢；1024、2048、4096 相近，其中 2048 最快，4096 还要多占约 2.8 GiB 峰值）。每一块之间检查取消和中断信号。
   - **PLE 行读取必须和 GPU 计算重叠**（B0-5 发现）：上游外置 PLE 的读法按索引逐行读 numpy memmap，每行的 weight、scales、biases 分在三处，缺页串行，一次只发一个请求。冷读时占预填充时间约 70%（2K 块 11.2 秒中的 8.1 秒）。worker 要实现自己的 PLE 行存储：由下一块的 token 算出行号，用线程池并发预取，和当前块的 GPU 计算重叠；行改成连续存放（上游有 `materialize_interleaved_ple_store`），每行只触碰 1 个页；再加一个有界的行缓存。B0 微基准：并发预取把一个 2K 块的读取从 3.4–7.5 秒降到约 1.2 秒，而 GPU 算一个 2K 块约需 2–3 秒，完全可以掩盖。
   - **显式传入位置编码**：Qwen3.5 系列模型把 M-RoPE 的位置状态（`_position_ids`、`_rope_deltas`）缓存在模块上；从快照恢复到位置 n 之后如果不显式传 `position_ids`，位置会从 0 重新开始。worker 每次前向都显式传入。
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
| HTTP 正文 | 64 MiB（B2-6 起；原为 16 MiB，只够放约 5–10 张截图的历史） |
| 每个请求的图片 | 最多 64 张（含历史和工具结果）；单张原图最多约 6,700 万像素（约 8K×8K） |
| 输出字节 | 4 MiB |
| WebSocket 连接最长寿命 | 60 分钟，与 codex 一致 |

- **停机顺序**：关闭准入 → 唤醒排队中的请求 → 限时 drain → 取消剩余请求 → 结束 worker 进程组。
- **恢复**：worker 崩溃后，网关把状态标记为 recovering，拒绝新请求并返回 503；最多重启 2 次，每次都要重新预热。worker 重启后内存中的状态全部丢失，SSD 层的数据仍然可用。

---

## 9. 生命周期与部署

- **唯一公开入口**：`backend_service.sh`，模式为 `doctor / prepare / install / start / stop / restart / status / uninstall / help`，语义与 AGENTS.md 一致。在 macOS 上由系统 LaunchDaemon 管理。
- **`prepare`**，这是服务生命周期中唯一联网的模式（D-15）：
  1. 安装项目内的 uv，并用 Python 3.12 按 `backend/uv.lock` 安装依赖。mlx 和 mlx-vlm 都锁定到具体版本或 commit。
  2. 完整核验 `POINTERS` 实际引用的权重身份（SHA256），写入源码收据。**不下载、不转换、不修复权重**；缺权重时非零退出，并提示使用 `model_weights.sh`。
- **`model_weights.sh`**，独立的权重维护入口，不属于服务生命周期（D-15）：
  1. `download`：按固定的 revision 下载官方 FP8 checkpoint（185.6 GB，revision `236dfdf`），登记为源身份。
  2. `convert`：从源身份按固定配方派生产物，登记为新身份，记录源身份、配方和工具版本。配方包括：转换成选定的量化格式；生成外置 PLE 的模型视图，必要时把 PLE 重排成按行存储的格式；拆出 MTP 草稿模型（B2）。
  3. `list` / `delete`：只读列出，或按目录名删除。
  4. 每个身份的完整 SHA256 清单写在 `.runtime/model-assets/` 下的本地记录里。
- **`doctor`** 检查：
  - Apple Silicon、Metal 可用；
  - 空闲磁盘；
  - 准备收据和完整的 SHA256；
  - `.env` 配置；
  - **GPU 可锁定内存上限**：读取 `sysctl iogpu.wired_limit_mb`，低于要求时报 `[MANUAL]`，并给出需要用户自己执行的两条命令（sysctl 立即生效、写入 `/etc/sysctl.conf` 持久化）。开机自启时 LaunchDaemon 以普通用户运行，不能提权，所以只有持久化以后，重启后才能自启成功；
  - 启动前的可用内存；
  - 端口。
- **`start`**：完全离线；加载模型 → 运行预热（纯文本、工具调用、预热 + 续接、上下文超长的拒绝路径）→ 就绪。
- **`.env`**，放在 `backend/.env`，只放部署差异：API key、公共端口。公开模型别名在 configs 的 `POINTERS` 中（D-15）。
- **日志**：JSONL，字段走白名单，不记录任何正文、思考内容或工具参数。控制台使用 `[Aporisa Code]` 标签。

---

## 10. 可观测性

B1 起，每个请求记录以下字段，这些数据同时也是报告的实验数据：

| 字段 | 含义 | 状态 |
|---|---|---|
| `transport` | http 或 websocket | B1 |
| `restore_path` | live、snapshot 或 cold（B2 加 ssd） | B1 |
| `input_tokens`、`cached_tokens`、`prefilled_tokens`、`output_tokens`、`reasoning_tokens` | 总 prompt 长度、复用长度、实际预填充长度、输出与推理 token 数 | B1 |
| `queue_ms`、`duration_ms` | 准入排队时间、从准入到结束的总时间 | B1 |
| `ttft_ms`、`prefill_tok_s`、`decode_tok_s` | 首 token 时间、预填充速度、解码速度（worker 计时） | B1 |
| `peak_memory_gb` | 本次请求的 MLX 峰值内存（每个请求开始时重置） | B1 |
| `ple_bytes_read`、`ple_lookup_ms`、`ple_prefetch_ms` | 从外置 PLE 表取出的字节数（经过页缓存，不区分是否真的读盘）、主线程在 PLE 查表上阻塞的时间、预取线程的读取时间 | B1 |
| `snapshot_count`、`snapshot_bytes`、`session_bytes` | 请求结束时会话持有的快照数量、快照占用、会话总占用 | B1 |
| `prefill_max_chunk_ms` | 本次预填充中最长的一块（PLE 查表加 GPU 计算，不可中断，决定取消多快得到确认） | B1 |
| `sys_pageins`、`sys_pageouts`、`sys_compressions`、`sys_decompressions`、`sys_swapins`、`sys_swapouts`、`swap_growth_bytes`、`compressor_bytes`、`major_faults` | 本次请求期间的**系统级**内存压力（页数的变化量、swap 增长、请求结束时压缩器的占用）和 worker 进程的缺页次数；worker 就绪日志另带启动期间的同一组数字和 `released_cache_bytes` | B1 |
| `mtp_accept_rate` | MTP 草稿接受率：被接受的草稿数 / 验证的草稿数；本次没有验证任何草稿时不输出 | B2 P1 |
| `lookup_accept_rate`、`lookup_rounds` | 提示词查找草稿的接受率、用了查找草稿的轮数；本次没有用到时不输出 | B2 P2 |
| `ple_cache_hit_rate` | PLE 行缓存命中率 | B2（行缓存属于 B2-5） |
| `ssd_spill_count`、`ssd_bytes_written` | 本次请求期间写入 SSD 缓存的会话数和字节数（淘汰时写入）；没有 SSD 缓存时不输出 | B2 P4 |
| `ssd_load_ms` | 从 SSD 恢复会话的耗时（读入、校验、建 cache）；只在 `restore_path=ssd` 时输出 | B2 P4 |
| `image_count`、`image_tokens`、`vision_encode_ms` | 请求中的图片数、图片 token 数、本次视觉编码的耗时（已在缓存中的图片不再编码）；没有图片时不输出 | B2 P5 |

B2 的字段在实现之前不输出，不用 0 占位。

通过需要认证的 `GET /health/runtime` 查看运维状态：网关状态、准入、重启次数、计数，以及 worker 自己的视图（会话数与占用、快照预算、淘汰次数、token 映射条数、常驻权重、活跃内存、wired 上限、PLE 预取是否开启、最近一次请求的计量）。worker 在 2 秒内没有回答时，`worker` 为 null。这不属于公共协议，只含数字和枚举。

---

## 11. 代码结构（草案）

```
backend/
├── DEVELOPMENT_PLAN.md          本文
├── .env.example
├── pyproject.toml / uv.lock
├── src/aporisa_backend/
│   ├── configs/                 按主题拆分的策略：network / limits / models（MODEL_LIST、POINTERS、PROFILES）/ cache / logging …
│   ├── weights/                 权重维护：身份记录、下载、转换配方、目录锁（model_weights.sh 调用）
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
├── scripts/                     B0 一次性脚本、benchmark、validate_runtime
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
| 一致性测试 | 前端的 W01–W24，对真实服务运行 | 用户在 Studio 上运行 |
| 真实模型验证 | 文本、工具调用、续接、快照恢复的数值对照 | 用户运行 |
| 基准测试 | 第 13 节 B0 的各项测量，结果写进 `docs/validation.md` | 用户运行 |

---

## 13. 阶段划分

### B0：探路与实测

**目标**：把所有「待 B0 实测」的数值变成实测结果，并验证关键假设。**不写正式的服务代码**，只写一次性脚本，放在 `backend/scripts/`。

| # | 任务 | 验收标准 |
|---|---|---|
| B0-1 | 环境：安装 uv 和 Python 3.12，把 mlx 和 mlx-vlm 锁定到某个 commit；记录 macOS 版本和 `iogpu.wired_limit_mb` 的当前值 | 版本信息记录在案 |
| B0-2 | 下载官方 FP8 checkpoint，确认实际大小。B0 阶段 `model_weights.sh` 还不存在，下载到 `.runtime/` 下，并记录 revision，B1-2 再登记为正式身份 | 大小和 revision 记录在案 |
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

**B0 状态（2026-09-30）：全部完成。** B0-1 到 B0-12 的结果见 validation.md 的 B0 各节；B0-7 的动态部分由 B0-12 的 `quality` 子命令覆盖；量化格式为 affine 4-bit gs64（D-05）。遗留两项：B0-10 发现起草深度 1 异常，留给 B2-2 排查（B2 P1 已查明：「深度」是 mlx-vlm 的 `draft_block_size`，深度 1 即 0 个草稿）；档位对推理量的影响留到更难的任务上评估。

### B1：协议核心

**目标**：一个可用的后端，通过全部一致性测试。

| # | 任务 | 验收标准 |
|---|---|---|
| B1-1 | 工程骨架：`pyproject.toml`、`uv.lock`、`configs/`、白名单日志、`scripts/check_backend.sh` 接入 `check.sh backend` | 用户运行 `./scripts/check.sh backend` 通过 |
| B1-2 | 生命周期：`backend_service.sh` 全部模式；LaunchDaemon 模板；准备收据；GPU 可锁定内存上限检查。`model_weights.sh` 的 download / convert / list / delete、本地身份记录、目录锁，以及 configs 中的 `MODEL_LIST` / `POINTERS` / `PROFILES`（D-15）；B0 的产物登记为正式身份 | 状态机和 local_llm 同样严格；用户手动完成验收 |
| B1-3 | 网关：认证、严格 JSON、schema 和语义校验、准入、两种传输、错误映射、健康检查 | 使用假 worker 的网关测试通过 |
| B1-4 | IPC 以及 worker 的启动和恢复，恢复次数有上限 | 杀掉 worker 后能按规定恢复 |
| B1-5 | 模型适配层：模板渲染（按段 tokenize，见第 6.5 节）、增量解析（推理、消息、工具调用、`phase`）、换档指令段（D-17） | 单元测试覆盖 B0-6、B0-7 确认的格式和边界 |
| B1-6 | 状态层：活跃游标（WebSocket 精确续接）、内存中的快照存储、前缀哈希、token 一致性映射 | 匹配和淘汰的单元测试；B0-8 的对照测试在正式代码中重跑并通过 |
| B1-7 | 能力：`prompt_cache`、`prewarm`、`input_tokens`、`websocket`、`reasoning_effort_updates` | 对应的一致性用例（W14–W24）通过 |
| B1-8 | 启动预热和就绪检查 | `start` 只有在预热通过后才报告就绪 |
| B1-9 | 可观测性：第 10 节的字段，以及 `/health/runtime` | JSONL 中包含这些字段，且没有任何正文 |
| B1-10 | worker 运行时基础：加载前设置 `mx.set_wired_limit` 和缓存上限；每次前向显式传入位置编码；自己的 PLE 行存储（行连续存放、并发预取与 GPU 计算重叠、有界行缓存），替换上游的串行读法（第 7 节） | 满上下文预填充接近 B0-5 的纯计算速度；连续运行期间不出现 swap |

**B1 的验收**：在 Studio 上运行 `npm run conformance`，W01–W24 全部通过；集成节点 I1 可以开始，即 Air 上的 native driver 指向 Studio，F1 的测试全部重跑通过。

**B1 状态（2026-09-30）**：完成。对系统服务运行 W01–W24 全部通过（P3），真实生成验证与 B1-10 的长上下文验收通过（P4）；B1 收尾删除了 B0 的一次性脚本和迁移脚本（分别见提交 `c89d1b2`、`dfd2495`），并新增 `docs/architecture.md`。集成节点 I1 待在 Air 上进行，外网访问经用户在 Studio 上的 Cloudflare Tunnel 转发到 `127.0.0.1:18080`。B1-10 中「有界的 PLE 行缓存、行连续存放」未做：按 P4 的实测，页预取已让 132K 预填充达到 B0-5 纯计算速度的 90% 以上，留给 B2-5 按数据决定。

### B2：性能与本地专属能力

| # | 任务 | 验收标准 |
|---|---|---|
| B2-1 | 快照溢出到 SSD，以及服务重启后的恢复 | 重启后恢复一个 200K 的会话，首 token 时间在秒级 |
| B2-2 | 默认开启 MTP 投机解码，按上下文长度决定每轮草稿数（短上下文 2 个，即 B0-10 的「深度 3」：贪心 1.57 倍、思考模式 1.47 倍）；排查「深度 1」的异常（已查明，见下） | 解码速度的提升与 B0-10 一致 |
| B2-3 | 提示词查找投机（自研），可以和 MTP 组合 | 在代码编辑类任务上，解码速度有可测的提升 |
| B2-4 | 结构化输出（`structured_output`），以及工具参数的 `strict` 约束 | 对应的能力开启，测试通过 |
| B2-5 | 按 B0 数据调优：分块大小、快照数量 K、内存预算、PLE 行缓存 | 调优前后的对比数据 |
| B2-6 | 图片输入（用户决定必须支持）；`custom_tools`、`phase` 判定等 harness 需要时再定 | 图片输入：能力声明加入 `image`，一致性测试与真实模型验证通过 |
| B2-7 | 长时间 soak：连续跑数小时的 agent 循环，观察内存是否泄漏、速度是否衰减 | 记录在 `validation.md`（用户决定：脚本 `scripts/soak.py` 写好备用，v0 不跑，见「B2 状态」） |

**P3（B2-4 结构化输出）实现要点**：
- **合同**：协议新增第 8.4 节。推理不受约束；`text.format` 约束回答为一个符合 schema 的 JSON（`phase` 为 `final_answer`），带工具时回答要么是这个 JSON、要么是工具调用，不输出评论性 message；strict 工具的参数只含声明的属性、`required` 不缺；两者都按「封闭」理解对象（除非 schema 写明 `additionalProperties: true`）；未完成时写到一半的受约束 item 被丢弃；最终校验不通过以 `structured_output_invalid` 结束。
- **语法**（`engine/structured.py`）：每个请求一份 Lark 语法交给 llguidance（1.8.0，已随 mlx-vlm 锁定）。strict 调用是模板的 XML：参数按 schema 顺序、必填不可省；字符串参数是到 `\n</parameter>` 为止的原文（正是适配层 `convert` 读回字符串的方式），其他类型是子 schema 的 JSON（`%json`）；非 strict 工具的调用体不受约束；函数名限于本次声明的工具。JSON 一律单行输出、分隔符为 `, ` 和 `: `，其他位置的空白最多 8 个字符：允许任意空白时，采样的模型可能一直写空白直到用完输出预算（随机小模型上复现）。
- **解码**：约束从 `</think>` 之后开始（effort none 时从第一个 token 开始）。受约束区域每轮只采样 1 个 token，不起草；采样前加上语法允许的 token 掩码（llguidance 每个 token 约 0.07 ms）。投机的一轮里如果接受了 `</think>`，这一轮就此结束，因为之后的位置是在没有掩码的情况下验证的。
- **告知模型**：`text.format` 渲染为生成提示符之前的一个 system 段（写明 schema），历史的前缀保持可复用。strict 工具不需要额外说明（工具块里已有 schema）。
- **最终校验**：`protocol/structured.py` 的值校验器与前端的 `schemaValueViolation` 规则一致；语法正常时不会触发，是兜底。
- **测试**：随机小模型在语法下的回答必须是合法 JSON；推理不加掩码、回答每个 token 都加掩码（包括投机一轮跨过 `</think>` 的情况）；脚本想写的非法参数被掩码纠正；去掉掩码时由最终校验判为 `structured_output_invalid`。

**P3.5（B2-5 提前的一项：一轮一次采样）**：原来每个输出 token 单独采样一次（248K 词表上的 top-k / top-p / 分类采样，加一次同步，约 1.1 ms），一轮验证 32 个查找草稿时光采样就占约 35 ms。现在一轮验证之后，所有位置一次采样（`Sampler.rows`），只同步一次：第 j 个位置按「前 j 个草稿都已输出」计算 presence penalty，这也是它会被用到的唯一情况；走到第一个与草稿不同的采样就停，后面的位置丢弃。每个输出 token 仍按正确的条件分布采样，输出分布不变；只是随机数的消耗方式变了，同一个 seed 下开关 MTP 的采样输出不再相同（测试改用贪心比较）。受约束区域仍然逐个采样。

**P4（B2-1 SSD 溢出与重启恢复）定稿（2026-10-01，用户确认四项建议）**：
1. 读盘时校验：每个文件带内容的 sha256，每次读入都验证；不通过的文件删除，该请求退回预填充。
2. 停机时间预算：worker 停止等待改为 45 秒（`configs/limits.py`），launchd 的 ExitTimeOut 改为 120 秒（`configs/macos_service.sh`）；worker 停机时最多用 30 秒（`configs/engine.py` 的 `shutdown_spill_s`）按最近使用顺序写会话，写不完的放弃。
3. 系统提示跨会话复用这次不做，等 harness 出现多 thread 场景再加。
4. 不新增生命周期模式；清除缓存的方法写在文档里（停服务后删除 `.runtime/kv-cache/`），uninstall 保留它。

**P4 实现要点**：
- **存什么**：恢复到位置 p 需要 p 之前的 KV（目标模型 12 个注意力层的 K/V、indexer 键与位置，草稿模型一层），以及 p 处的循环层状态、logits 和草稿模型的隐藏状态。KV 只会追加，按 2048 个 token 一块存；后几项只能在固定位置保存，存成检查点。
- **按内容寻址**（`engine/disk_cache.py`）：块 i 的文件名是链式哈希 `H_i = sha256(H_{i-1} ‖ 第 i 块的 token)`，`H_0` 由布局摘要决定；检查点的文件名是 `sha256(H_k ‖ 最后一个整块之后的 token)`，文件里存它引用的块哈希、位置 p、循环状态、logits、隐藏状态和尾部 KV。磁盘上没有 token 列表：请求自己带着 token，哈希对上了，前 p 个 token 就是请求里的前 p 个。相同前缀的块只存一份，同一会话再次写入只写新增的块。
- **草稿模型的 KV 归属**：草稿模型第 t 项依赖 token 0..t+1，所以块 i 存草稿模型的 [(i−1)B−1, iB−1) 项（第一块少一项），它们依赖的 token 都在 `H_i` 覆盖的范围内。
- **何时写**：会话为了内存预算或内存压力被淘汰时，先写再释放；正常停机时，所有空闲会话按最近使用顺序写。每个会话写两个检查点：当前末尾，和最近一个早于末尾的快照（通常是上一轮 prompt 的末尾：重试、或重启后 token 映射丢失、历史重新渲染得到的 token 与生成时不同，都会从这里分叉）。不写：被客户端 release 的会话（WebSocket 连接关闭）；同一个 key 换成了无关前缀的会话（压缩上下文之后旧历史不会再发来，写了也只浪费 SSD）；不足一块（2048 token）的会话。
- **何时读**：内存匹配（live → snapshot）之后，SSD 上能比内存多复用至少一块时，从 SSD 恢复（`restore_path=ssd`）。按 key 无关、只按内容匹配：重启后 WebSocket 的 `conn:<id>` 变了也能命中。末尾检查点只在带 logits 时才能用于「请求恰好到 p 为止」。
- **文件**：魔数、sha256、头部 JSON（张量的 dtype、形状、偏移、token 轴）、张量数据；先写临时文件、fsync、再改名，写完和读完都释放页缓存（模型占用之外没有余量放第二份）。读入时先建好最终的 MLX 数组，4 个线程并行读块、校验，直接写进这些数组的内存（统一内存），峰值约为会话 KV 加 4 个块（先拼进主机内存再拷贝的第一版，在真实验收中让系统压缩了约 7 GB，见 validation.md）。indexer 的块摘要是派生数据，不写盘，恢复后的下一次前向重算（与快照恢复相同）。
- **容量**：总量超过 64 GiB 时，先删最久未用的检查点（按文件修改时间，恢复时会更新），再删不被任何检查点引用的块。写入前按实际字节数预留空间；单个会话超过整个容量时不写。
- **失效**：目录名是布局摘要（缓存格式、模型与草稿模型身份、适配层、MLX 和 mlx-vlm 版本、块大小）。任何一项变了，旧目录不再读取，并在下次启动时删除；中断留下的临时文件和没有检查点引用的块也在启动时清理。
- **计量**：每个请求 `ssd_spill_count`、`ssd_bytes_written`、`ssd_load_ms`；`/health/runtime` 的 worker 视图增加 `ssd_cache_bytes`、`ssd_checkpoints`、`ssd_written_bytes`、`ssd_read_bytes`、`ssd_errors`。
- **验收**（重启需要用户执行）：`validate_runtime.py --restart-prepare 200000` 建立约 200K 的会话，记下 key、长度和提示词的哈希；用户执行 `./backend_service.sh restart`；`validate_runtime.py --restart-resume` 发送同一个请求，要求 `restore_path=ssd`、全部 token 命中、首 token 在 10 秒内。

**P5（B2-6 图片输入）定稿（2026-10-01，用户确认四项建议）**：
1. 分辨率上限：`detail=auto` 最多约 100 万像素（约 1,024 个 token），`high` 最多约 400 万像素（约 4,096 个 token）；模型自己的上限 1,600 万像素不开放。视觉塔剖析后维持（一张 auto 图约 1.9 秒、high 图约 8.4 秒，见 validation.md）。
2. HTTP 正文、WebSocket 消息上限提高到 64 MiB，IPC 单帧 96 MiB；每个请求最多 64 张图片。
3. 顺序：图片输入在调优之前做（它改动位置计算和缓存的键）。
4. 前端这次只做合同层（一致性测试、mock、协议说明）；`view_image` 工具和 UI 上传放到对应的前端阶段，作为必做项登记（见下文）。

**P5 实现要点**：
- **合同**（protocol.md 第 7.1、11 节）：`image_url` 必须是与声明格式一致、能完整解码的 PNG 或 JPEG；`detail` 决定分辨率上限，保持宽高比缩放，从不裁剪；图片 token 计入 `input_tokens`、`cached_tokens` 和上下文检查；前缀缓存按图片内容区分；图片数超出上限返回 `invalid_request`，原图太大返回 `invalid_image`。前后端共用同一套结构检查（声明的格式、文件头里的尺寸、文件完整），worker 再完整解码。一致性测试新增 W27–W30。
- **渲染**（`engine/adapters/qwen38.py`）：按 template 的 `render_content`，图片在 user 消息和工具结果里渲染为 `<|vision_start|><|image_pad|><|vision_end|>`，pad 展开为图片的 token 数（模型的处理器对 template 文本做的就是这件事）；小模型测试中与「官方 template + 展开」逐 token 一致。占位用带随机数的私有字符标记，请求文本无法伪造。视觉 token 从采样中禁止。
- **尺寸与预处理**（`engine/vision.py`）：用 mlx-vlm 自带的 Qwen3-VL 处理器（numpy + PIL 的移植，不需要 torch，也是 mlx-vlm 服务这个模型时用的）：缩放到 32 的倍数，每 32×32 像素一个 token，最少 64 个 token。与参考处理器不同的一点：先按 EXIF 方向旋转，照片按显示的方向看。网关只读文件头；worker 在流开始前对还要预填充的图片完整解码（PNG 先校验每个块的 CRC：PIL 会宽松地解出损坏的数据），失败以 `rejected`（`invalid_image`，带出错的部分）结束，网关返回 400。
- **位置**：M-RoPE 三维位置（时间、行、列）。图片之后的文本从图片的最大位置 + 1 继续，所以位置不再等于 token 序号；整个请求的位置在渲染时算好，预填充按块切片，解码用「偏移 + 位移」。小模型上与 mlx-vlm 的 `get_rope_index` 逐项相同。
- **预填充**：覆盖图片 token 的块，以 embedding 输入，pad 的位置换成视觉塔的特征（每张图片在第一次需要时编码一次，用完即释放）；一块只装下一张图片的一部分也可以。小模型上整段一块时与 mlx-vlm 自己的图片路径（`get_input_embeddings` 加一次前向）逐位一致，把图片切在两块之间时只差 kernel 级的舍入。
- **缓存的键**：所有 pad 的 token id 相同，只按 token 比较会让两张同尺寸的不同图片共用 KV。渲染时生成一份「键序列」：每张图片的第一个 pad 换成由图片摘要（内容、`detail`、缩放后的尺寸）得到的负数，其余与 token 相同。会话匹配（live、snapshot）和 SSD 的链式哈希都用键序列，模型仍然收到真实的 token id；纯文本请求的键就是 token，原有的 SSD 缓存仍然有效。提示词查找的草稿遇到图片（负数键或视觉 token）就截断。
- **计量**：`image_count`、`image_tokens`、`vision_encode_ms`；`/health/runtime` 的 worker 视图增加 `image_input`。预热包括一次图片请求。
- **前端后续（必做，登记于此，按前端阶段实现）**：OpenRouter driver 的 `input_image` 映射（F2，见 compat-openrouter.md，待实测）；harness 参照 codex 实现 `view_image` 工具（读取本地图片，以工具结果中的 `input_image` 交给模型）；UI 支持在消息中粘贴或拖入图片。

**P6（B2-5 调优）定稿（2026-10-01，用户确认四项建议）**：
1. 范围：T1（缩短 agent 每轮的首 token 时间）、T2（长上下文的内存余量）做；T3（解码：长上下文 2 个草稿、短上下文 3 个草稿、解码流水线）先剖析，有收益才做；T4（PLE 行缓存）、T5（快照数量 K 与预算）这次不做。
2. 快照切分：只在最后一个条目边界和 prompt 末尾切，很小的段并入相邻的段（阈值按剖析定）。代价：改写较早的历史时命中位置靠前。
3. 长上下文：为了不压缩桌面程序，预填充可以慢 5–10% 以内。
4. 对比标准：`validate_runtime.py --agent-loop`（固定 commit 的仓库文件模拟 20 轮工具调用，记录每轮的增量、首 token 时间和预填充速度），调优前后各跑一次。

依据（P5 之后的服务日志）：短的增量预填充只有纯计算速度的 20–45%（16 token 142 ms，400 token 约 1 秒，3.2K 冷启动 644 tok/s，B0-5 在 2K 为 954 tok/s），推测是 MoE 每次前向读一遍全部专家权重的固定成本，加上在每个条目边界切分预填充；长预填充已到纯计算速度的 97–100%。剖析脚本 `.runtime/profile_tuning.py`（不进 Git）测前向成本与块大小、切分的代价、长上下文各块的内存峰值、解码各配置与 CPU 占比、PLE 冷读。

**P6 剖析结果与实现**（`.runtime/profile_tuning.py` v2，用户运行，2026-10-01；v1 的单次前向计时只测到了建图，作废，其内存峰值、切分、PLE 和解码数据有效）：
- **agent 循环基线**（`--agent-loop`，20 轮，上下文到 23K，按服务端首 token 时间）：中位数 1,623 ms，p90 5,055 ms，合计 42.6 秒；增量中位数 762 token，预填充 537 tok/s。
- **短增量的时间去向**（34K 上下文，一段预填充）：400 token 共 804 ms = PLE 预取等待 168 + 目标模型前向 628 + 草稿模型 6；1200 token 共 1,943 ms = 348 + 1,574 + 20。快照切分另加 12–16%（26K：400 token 切 3 段 887 ms，不切 781 ms）。单次前向：16 token 约 90 ms，64 token 约 200，256 token 约 440，1024 约 1,350（34K）。
- **PLE**：预取为每个 token 的 48 个随机页（16 行 × 3 个张量）各发一次 pread，开销几乎全是 Python 的每次调用（19,200 页：冷 234 ms、热 209 ms）。`F_RDADVISE` 一次性请求再读取，冷读 94 ms（57,600 页：279 对 637 ms）。页缓存里只有约 2% 的 PLE 表（29.8 GiB），所以按驻留检查跳过不划算（`mincore` 一遍 456 ms）；PLE 行缓存（T4）维持不做。
- **长上下文内存**：一块 2048 token 的前向峰值随上下文增长（34K 2.9、67K 3.2、129K 4.1、222K 5.7 GB），1024 token 为 2.1、2.2、2.6、3.5 GB，256 token 在 222K 为 1.6 GB；每 token 耗时 1024 与 2048 相同（67K 1.38/1.42 ms，129K 1.62/1.61，222K 2.00/1.96），256 在 222K 为 2.02。冷预填充 222K（2048 一块）峰值比权重多 17.7 GB，系统压缩 1,090 万页、swap 增长 1.2 GB、速度降到 447 tok/s；之后剖析脚本在 222K 上试 4096 一块时 GPU 内存不足（agent 的失误：不该在这个长度上试 4096）。
- **解码**（4 个种子 × 192 token，tok/s，1 / 2 / 3 个草稿，16K 起宽验证走预填充路径）：2K 41.9 / 45.5 / 46.2；34K 36.2 / 38.7 / 41.0；67K 35.0 / 37.9 / 39.9；129K 27.6 / 28.7 / 27.1。每轮 CPU 时间占 8–15%（一项 17.5%），低于 15% 的门槛，解码流水线不做。
- **实现**：
  - 块大小表 `prefill_chunk_schedule`：0 起 2048、64K 起 1024、192K 起 512（`configs/engine.py`）；块按起点选大小，剩余不足「块 + 256」时分成两半，不留很小的尾块。
  - 快照点：prompt 末尾，加上最后一个两侧都不短于 `snapshot_min_piece`（256）的条目边界；agent 的一轮增量通常一次前向完成。
  - PLE 预取改用 `F_RDADVISE`，被拒绝时退回 pread。
  - `draft_schedule`：0 起 2 个、16K 起 3 个、96K 起 2 个（原为 16K 起 1 个）。
  - 长上下文解码时临时放大 MLX 缓冲缓存（`decode_cache_from` 64K、`decode_cache_bytes` 2 GiB，请求结束后恢复 0.5 GiB 并清空）。`--long 200000` 的解码只有 11.0 tok/s（低于 B0-5 不投机的 18.0）；160K–200K 的剖析中 1 个与 2 个草稿互有胜负。追查发现：一轮解码的临时缓冲随上下文增长（单 token 前向峰值 2K 0.13 GB、67K 0.41、129K 0.68、222K 0.86 GB），超过 0.5 GiB 的缓存上限后每轮都还给系统再申请。222K、同样的 4 个种子（输出相同）：2 个草稿 0.5 GiB 24.1、2 GiB 33.2 tok/s；1 个草稿 20.7、28.9（+38–40%），2 GiB 时系统一次压缩约 1 GB。2 个草稿在两种上限下都更快，96K 起 2 个草稿维持。

**B2 状态（2026-10-01）**：后端 v0 完成（用户决定）。P1–P6（B2-1 至 B2-6）都已实现，并在真实模型上通过验证脚本、长上下文验收和 W01–W30；提交依次为 `943e814`、`722651b`、`bf5480f`、`b03f063`、`aa734fd`、`88482c0`。用户的判断：B2-7 是性能观测，不是后端核心逻辑的增量；从零到一的阶段尽力做好即可，之后前端完成、边用边反馈地迭代更合理。所以 soak 只写好脚本 `scripts/soak.py`（在假 worker 上跑通），需要时再对真实服务运行。

**后端 v0 之后的已知事项**（不阻塞，前端完成后边用边定）：
- 集成节点 I1（Air 上的 native driver 经 Cloudflare Tunnel 连接 Studio，重跑 F1 测试）与 I2（F6、F7 的实验在完整 C 下重跑，对照 OpenRouter），都依赖前端。
- 开机后服务自启的冷启动耗时、锁定权重后空闲过夜 worker 是否仍全部常驻：都没有实测，用户决定默认它们在合理预期内，出现问题时再查（`scripts/soak.py --idle-hours` 可以覆盖后者）。
- 200K 解码只比门槛高 4%：草稿接受率很低的回答在 200K 上仍可能接近 B0-5 不投机的速度。
- 超过 200K 时内存依然紧：222K 冷预填充压缩约 128 万–400 万页（不写 swap）。
- 图片输入的前端部分（OpenRouter 映射、harness 的 `view_image`、UI 上传），见 P5 要点。
- `custom_tools`、`phase` 判定等，harness 提出需求时再定。

**B2 的验收**：集成节点 I2，即 F6 和 F7 的实验在「完整 C」下重跑，并与 OpenRouter 的结果对照。

**B2 定稿（2026-10-01，用户确认）**：
1. 顺序：P1 MTP（B2-2）→ P2 提示词查找（B2-3）→ P3 结构化输出（B2-4）→ P4 SSD 溢出（B2-1）→ 图片输入（B2-6，暂排在 SSD 之后、调优之前，届时再确认）→ 调优（B2-5）→ soak（B2-7）。每个阶段做完都停下来，由用户验收并决定是否提交。
2. profile 引用的 MTP 草稿模型缺失时，start 直接失败，不退回无 MTP 的解码（与「缺任何一项直接失败，不回退」一致）。
3. strict 工具的 XML 参数只允许 schema 中的顺序。
4. 第一版在约束区间内关闭投机，只在自由文本区间投机。
5. SSD 缓存：容量上限 64 GiB（放在 `configs/`）；只在淘汰和正常停止时写；磁盘上只存哈希、不存原始 token，文件权限 0600，用户知情「由提示词算出来的 KV」会落盘。
6. 图片输入必须支持：harness 暂时用不到是 harness 的问题，最终 harness 和前端 UI 都要适配。`custom_tools`、`phase` 判定等 harness 提出需求时再定。

**P1（B2-2 MTP）实现要点**：
- **「深度 1 异常」已查明**：B0 的 `b0_bench.py` 把「深度」直接传给 mlx-vlm 的 `draft_block_size`，它的含义是「每轮验证的 token 数 = 草稿数 + 1」。深度 1 等于 0 个草稿，mlx-vlm 的 MTP 循环一开始就退出（`bs <= 1`），所以没有接受率统计。这不是模型或 mlx-vlm 的 bug。B0 的「深度 2 / 3」分别是 1 / 2 个草稿；本项目的配置直接写草稿数 `draft_tokens=2`。
- **配置**：profile 新增 `draft_identity`（`Qwen3.8-Flash-Next-affine4g64-mtp`）、`draft_schedule=((0, 2), (16384, 1))`（从该上下文长度起每轮的草稿数，由 P1 剖析定）、`draft_kv_bytes_per_token=2380`（草稿模型只有 1 个注意力层，按目标模型 12 层的 28,560 折算，只用于会话估算）。草稿模型的身份和被服务的身份一样：prepare 完整校验并写进同一份收据，start 快速校验，服务期间两个目录都持有共享租约。
- **解码按轮进行**：采样出 bonus token b；草稿模型按 (b, 目标在上一位置的隐藏状态) 起草 2 个 token；目标模型一次前向验证 [b, d1, d2]（验证事务用 mlx-vlm 的 `start_speculative_cache`，DeltaNet 状态可以提交到任意位置）；逐个位置用本次请求的采样器采样，与草稿相同就继续，不同就停下。每个输出 token 都是目标模型在该位置的采样，采样器每个位置只调用一次；草稿取草稿模型的 argmax，此时「采样等于草稿才接受」与投机解码的拒绝采样是同一条规则，输出分布就是目标模型的分布。没有草稿模型时，每轮只有 1 个 token，即普通解码。
- **不是逐位一致**：一次验证多个 token 走的是多 query 的注意力 kernel，舍入与单 token 的 kernel 不同，偶尔会翻转 MoE 路由或稀疏块选择里的「近似平局」。小模型上 110 次随机续写中有 6 次出现 logits 差异，最大 0.37。这属于第 6.7 节允许的 kernel 级浮点差异，mlx-vlm 自己的 MTP 也一样；每个输出 token 仍然是目标模型的采样。贪心模式下，小模型上开启和关闭 MTP 的输出一致（确定性测试）。
- **草稿模型的状态**：草稿模型有自己的一层 KV cache，第 t 个位置存 (token t+1, 目标在 t 的隐藏状态) 这一对。会话持有 T 个目标 token 时，草稿模型已消费位置 0..T−2 的对，并保存目标在 T−1 的隐藏状态。预填充时每块顺带喂给草稿模型（约增加 1/48 的计算）。快照同时保存该位置的隐藏状态（20 KB），恢复时草稿模型截断到 o−1；跟不上时（快照里没有隐藏状态）丢掉草稿状态，该会话在下次冷启动前不起草，结果不受影响。
- **计量**：`mtp_accept_rate`；`/health/runtime` 的 worker 视图增加 `draft_schedule`。预热会检查确实验证过草稿。
- **预填充只投影最后一个位置**（P1 真实验证中发现）：原先 lm_head 对整块 2048 个位置都算 logits（约 1 GB），只取最后一行；MLX 的切片共享原数组的内存，这一行让会话和保存 logits 的快照各钉住整块 1 GB，且不计入会话占用。现在模型只返回预混合的隐藏状态，混合层和 lm_head 只作用于最后一个位置。草稿模型状态保留的隐藏状态行也改为独立拷贝。
- **B2-5 的候选**：草稿数 3（mlx-vlm 对这个 MTP 头的运行上限）是否更快。

**P2（B2-3 提示词查找）实现要点**：
- **找草稿**（`speculative.lookup_drafts`）：上下文（缓存中的 token 加上刚采样出的 bonus）的末尾，在更早的位置最长匹配多少个 token（至少 3 个，最多比较 8 个；长度相同取最近一次），就把那个位置之后的 token 当作草稿：匹配 3 个给 2 个草稿，每多匹配 1 个翻倍，每轮最多 `lookup_schedule` 个（当前 32）。按匹配长度给草稿数是第一次真实验证后加的：普通文本里 3–4 个 token 的短语重复很常见，这类误中几乎不被接受，却让一轮验证最多 32 个 token，把普通回答的解码拖慢了约 15%。numpy 向量化，262K 上下文约 0.1 ms。会话同时维护一份 int32 的 token 数组（`Session.extend`）。
- **与 MTP 组合**：先试查找，找到就用查找的草稿，找不到再用 MTP；某轮查找草稿一个都没被接受，接下来 2 轮只用 MTP（`lookup_cooldown`）。匹配不足 6 个 token 时，只有 MTP 预测的下一个 token 与查找草稿的第一个 token 一致才用查找草稿（P3.5 验证中普通文本的短匹配误中让普通回答慢约 6%）。两种草稿走同一条验证路径，每个输出 token 仍然是目标模型的采样。
- **宽轮次走预填充路径**（`verify_prefill_schedule=((0, 8), (16384, 3))`）：解码路径在长上下文把多 token 验证拆成一对一对计算，111K 时 16 个 token 要 1000 ms；预填充路径（prompt 分块时用的那条）只要 107 ms。它与逐 token 解码之间只有 kernel 级的浮点差异，与 prompt 的处理方式相同。
- **效果**（改代码基准，复述约 730 token）：短上下文 / 16K / 111K 分别为 138 / 129 / 116 tok/s，是普通解码的 4.5 / 4.9 / 5.5 倍，是只用 MTP 的 2.6 / 3.1 / 3.4 倍。
- **B2-5 的候选**：有了预填充路径，长上下文里 MTP 用 2 个草稿（验证 3 个 token 约 67 ms）可能与现在的 1 个相当或略好；查找草稿数随匹配长度调整（短匹配少猜几个，降低猜错的代价）；非复述类任务上查找误中的代价（冷却轮数）。

---

## 14. B1 详细设计

> 2026-09-30 起草，此时 B0 已基本完成（B0-8 到 B0-12 仍在运行）。实现按本节进行；实现中需要偏离时，先修改本节。本节定稿后，第 4.2 节和第 11 节的草案以本节为准。

### 14.1 设计原则（在第 4 节基础上补充）

- **网关持有语义，worker 只持有加速状态。** 网关为每个 WebSocket 连接保存「上一次以 completed 结束的 response 对应的完整请求和输出」，所以续接在语义上总能由网关自己展开成完整请求。worker 的缓存丢失（崩溃、重启、淘汰）只影响速度，不影响结果，也不会导致 `previous_response_not_found`。
- **HTTP 完整请求是正确性的基线。** 所有加速路径（活跃游标、快照、token 映射）都要能退化到冷启动，并且结果一致；B0-8 证明了在真实模型上这种一致是逐位的。
- 不引入 harness 逻辑；所有与模型有关的代码都放在 worker 的适配层。

### 14.2 代码结构（定稿，取代第 11 节草案）

```
backend_service.sh              唯一的服务入口（仓库根目录）
model_weights.sh                权重维护入口（仓库根目录）
scripts/
  backend_service.sh            分派，拒绝 sudo 运行整个脚本
  macos_service.sh              LaunchDaemon 状态机（移植 local_llm）
  service_entrypoint.sh         launchd 调用的内部入口
  lifecycle.py                  只用标准库的引导：项目内的 uv、Python、uv sync
backend/src/aporisa_backend/
  configs/                      network、limits、models（MODEL_LIST/POINTERS/PROFILES）、
                                engine、cache、logging_policy、console、settings、macos_service.sh
  protocol/                     合同的 Python 侧：严格 JSON、按已提交的 schema 校验形状、
                                语义校验（移植 validation.ts）、错误码表、生效强度
  gateway/                      app、boundary（中间件）、admission、http_sse、websocket、
                                events（事件组装）、worker_client（IPC 客户端与恢复）、health
  ipc/                          帧格式与消息定义（网关和 worker 共用）
  engine/                       worker 进程
    main.py                     入口、控制线程、主循环
    runtime.py                  wired 上限、加载、预热
    adapters/qwen38.py          渲染、分段 tokenize、增量解析、采样与停止条件
    sessions.py                 会话、快照、token 映射、内存预算
    generate.py                 预填充（按快照点切块）、解码、usage
    ple_prefetch.py             PLE 行号预计算与页预取
  lifecycle/                    checks、artifacts（源码收据）、cli（doctor/prepare/run/smoke/stop）、
                                assets（身份记录与目录锁）、weights（download/convert/list/delete）
  logging_config.py             JSONL 字段白名单
backend/tests/                  单元测试、网关测试（假 worker）、IPC 与 worker 测试（小模型）
```

- 网关用 **Starlette**，不用 FastAPI（偏离 local_llm）。原因：我们按已提交的 JSON Schema 校验请求，用不到 pydantic 模型；FastAPI 会自动暴露 `/docs`、`/openapi.json`，而协议要求未知端点一律返回 404。
- 新增直接依赖（全部锁定精确版本）：starlette、uvicorn、websockets、jsonschema、python-dotenv、psutil；开发依赖：pytest-asyncio、httpx。

### 14.3 进程模型与 IPC（关闭第 15 节中「私有 IPC 格式」的待定项）

- worker 是网关的子进程，用 `start_new_session=True` 启动，停机时由网关结束它的进程组（AGENTS.md 的停机顺序）。
- **通道**：`socket.socketpair()`，子进程通过 `pass_fds` 继承其中一端。不经过文件系统，不需要内部 token，其他进程接触不到。worker 的 stdout 不承载协议，因为第三方库会往里打印；启动阶段保留 stderr 的有界尾部用于诊断（local_asr 的做法），就绪后丢弃。
- **帧**：4 字节大端长度 + UTF-8 JSON，单帧上限 96 MiB（HTTP 正文上限 64 MiB 加余量；B2-6 前为 20 MiB）。WebSocket 续接展开后超出单帧上限的请求返回 413，不当作 worker 故障。选 JSON 不选 msgpack：负载主要是文本，KV 等大块状态从不经过 IPC，JSON 不需要额外依赖，也方便测试。
- **网关 → worker**：

| op | 字段 | 说明 |
|---|---|---|
| `generate` | `id`、`response_id`、`request`（网关展开后的完整参数）、`session`（`prompt_cache_key` 或 `conn:<id>`，可为 null）、`deadline_s` | 发起生成；`generate:false` 即预热 |
| `count_tokens` | `id`、`request` | X3 计数，走同一套渲染 |
| `interrupt` / `cancel` | `id` | 优雅中断 / 硬取消 |
| `release_session` | `session` | WebSocket 连接关闭，丢弃它的 `conn:` 会话 |
| `status` / `shutdown` | — | 运维状态 / 停机 |
| `init` | `model_dir`、`model`（公开模型对象）、`adapter`、`kv_bytes_per_token`、`engine`（`configs/engine.py`） | 子进程启动后的第一帧；路径不放进命令行 |

- **worker → 网关**（同一个 `id` 的消息严格有序）：

| type | 字段 | 说明 |
|---|---|---|
| `accepted` | `input_tokens`、`cached_tokens`、`restore_path` | 通过上下文检查、即将开始；网关收到后才开启 SSE 流 |
| `rejected` | `code` | 流开始之前的失败，目前只有 `context_length_exceeded` |
| `item_added` | `kind`（reasoning / message / function_call）、`name`、`phase` | 一个 item 开始 |
| `delta` | `text` | 当前 item 的增量；对 function_call 就是参数 JSON 的片段 |
| `item_done` | `item`（不含 id） | 权威的完整 item |
| `finished` | `status`（completed / incomplete）、`reason`、`usage`、`metrics` | 终止 |
| `failed` | `code` | 流开始之后的失败 |
| `cancelled` | — | 该 job 已不再运行，并且它的其他消息都已发出；网关收到后才释放准入名额。30 秒内没有确认，网关结束 worker 进程组，交给恢复流程 |
| `counted` / `status` / `ready` | … | 其他 op 的应答 |

- item 的 id（`msg_`、`rs_`、`fc_`）、`call_id` 和 `sequence_number` 全部由网关生成；worker 不关心这些 id。
- worker 同一时刻只执行一个 `generate`。一个读线程负责接收控制消息；生成在主线程运行，在每个预填充块和每个解码 token 之间检查中断和取消标志。

### 14.4 网关

- **请求流水线**：边界中间件（request id、先认证再读正文、16 MiB 正文上限、415、上传超时 408、HTTP 并发任务上限）→ 严格 JSON（重复键、NaN、Infinity）→ 形状校验（jsonschema 对照 `docs/schema/aporisa-protocol-v0.schema.json` 的 `$defs`；未知键映射为 `unsupported_parameter`，其余为 `invalid_request`）→ 语义校验（移植 `validation.ts`，含第 6.1 节）→ 模型别名 → 准入 → IPC。收到 `accepted` 才开始流；收到 `rejected` 则返回 HTTP 400 或 WebSocket `error`。
- **准入**：FIFO，实际并发 1、排队 2、排队等待 60 秒；超时返回 429 `queue_timeout`，队满返回 429 `queue_full`，都带 `Retry-After`。移植 local_llm 的 `Admission`。
- **事件组装**：把 worker 的 item 事件翻译成第 7.3 节的事件序列，包括 `content_part.added/done`、`output_text.done`、`reasoning_text.done`、`function_call_arguments.done`；生成全部 id；按连续编号填写 `sequence_number`；在终止事件中给出完整的 `output`。组装器内置一个轻量的顺序自检，违反时以 `response.failed`（`server_error`）结束。
- **SSE**：每 15 秒发一次 `: keepalive`；客户端断开时向 worker 发 `cancel` 并释放准入名额。
- **WebSocket**：每个连接维护四项状态：是否有进行中的 response、上一次 completed 的 (response id, 完整参数, 输出)、创建时间、会话名 `conn:<id>`。
  - 续接：按第 3.3 节检查（id 相同、除 input/client_metadata/generate 外其余字段完全一致），满足时由网关展开成完整请求；不满足时返回 `previous_response_not_found`。
  - 中断或失败的 response 会清掉续接状态。
  - 连接寿命 60 分钟，到期时在两次 response 之间发 `connection_limit_reached`，然后关闭。
  - 非法消息返回 `error`，连接继续可用。
  - 断开时取消进行中的生成，并发送 `release_session`。
- **计时与上限**：从获得准入起算的总期限 1800 秒；收到第一个 delta 后连续 180 秒没有新 delta 判定为空闲超时；输出字节上限 4 MiB。触发任一条件时向 worker 发 `cancel`，并以 `response.failed` 结束（`inference_timeout` 或 `output_limit_exceeded`）。
- **健康检查**：`/health/live`；`/health/ready` 只有在 worker 预热完成之后才返回 200；`/health/runtime`（需要认证）返回状态、准入、会话和内存的快照，不包含任何正文。
- **恢复**：worker 退出时，网关进入 recovering 状态，新请求返回 503 `service_not_ready`（带 `Retry-After`），进行中的请求以 `response.failed`（`engine_failure`）结束；最多重启 2 次，每次都重新预热；用尽后进入 failed，等待人工处理。
- **停机**：关闭准入 → 唤醒排队中的请求 → 限时 drain → 取消剩余请求 → `shutdown` → 结束 worker 进程组。

### 14.5 worker

**启动**：先 `mx.set_wired_limit(推荐工作集)` 和 `mx.set_cache_limit(2 GiB)`，再加载指针引用的模型目录；装上 PLE 预取；运行预热（纯文本、工具调用、预热加续接、上下文超长的拒绝路径）；全部通过后才回复 `ready`。

**适配层**（`adapters/qwen38.py`，由 profile 选择）：

- `render(request) → RenderPlan`：
  - `blocks`：按顺序排列的渲染块，每块带自己的 token id。每块结束处是否是一个 item 边界、这个边界对应的输入 item 数，都记录在块上。
  - `generation_prompt`、生效强度、采样参数、停止 token、禁止 token、是否在第一个 `</tool_call>` 处停止。
- 渲染规则（第 5.2、5.4 节）：
  - system 块依次是基线档位指令、工具定义、`instructions`；
  - 连续的 assistant 来源 item 合并成一个 assistant 回合；
  - 连续的工具结果合并成一组；
  - `configuration_update` 和 `developer` 各自渲染成一个中途的 system 段（`developer` 的格式等 B0-12 结果后最终确定）。
- **分段 tokenize**：每个块单独 tokenize。块的边界都落在特殊 token 上，所以结果和整段 tokenize 一致（B0-7）。assistant 回合如果在 token 映射中命中，就直接使用生成时的 token id，否则按模板等价的文本渲染。
- **增量解析器**：输入是生成的 token id 流，状态依次为推理区间、回答、工具调用；输出 `item_added`、`delta`、`item_done`。工具参数按工具的参数 schema 严格转换成 JSON 对象；message 结束时根据后面紧跟的是 `<tool_call>` 还是结束标记，判定 `phase`。
- 工具调用的处理（合同已按第 13 节修订，协议第 7.1、9.2 节，用户同意）：
  - 能组成 `function_call` 的就照常输出：参数值转换不了类型就保留为字符串；缺少或多出参数、工具名不在 `tools` 中，都原样交给 harness，按 codex 的做法把错误回给模型。
  - 只有结构损坏、拼不出 item 时（没有闭合、没有函数名、函数名不符合命名规则），才以 `response.failed`（`tool_call_invalid`）结束。worker 在 `failed` 消息里带上 `detail`（unclosed / no_function / bad_name；同一个参数出现两次时为 malformed，因为拼不出没有重复键的 JSON 对象），网关据此选一条固定说明，不回显模型输出。
  - 参数值去掉首尾各一个换行，其余原样保留（代码编辑类参数依赖精确的空白）；arguments 的格式与 `json.dumps` 默认输出一致，逐个参数流式发出。

**会话与快照**（`sessions.py`，取代第 6.2–6.4 节中「按哈希链匹配」的草案，改为按 token 前缀匹配）：

- 会话 = 一份 MLX cache + cache 中实际已有的 token 列表 T + 若干快照（位置、DeltaNet 状态）+ 最近使用时间。会话名：有 `prompt_cache_key` 时用它；WebSocket 请求没有时用 `conn:<id>`；否则只在本次请求内临时存在。
- **匹配**：先渲染出本次请求需要的 token 列表 R。
  1. T 是 R 的前缀 → 直接追加剩余部分，这就是活跃游标路径，`cached_tokens = len(T)`；
  2. 否则找出位置 o 最大、且满足 `T[:o] == R[:o]` 的快照 → 截断 KV、恢复 DeltaNet 状态，再追加剩余部分，这是快照路径；
  3. 否则新建 cache，从头预填充，这是冷启动路径。

  比较 26 万个整数的开销可以忽略，内存层不需要哈希链；哈希链留给 B2 的 SSD 层作为键。
- **快照点**：本次新预填充区域内**最后 K−1 个** item 边界，以及 prompt 末尾（开始生成之前）。每个会话保留最近 K=16 个。（实现时收窄：长历史冷启动有几百个边界，每个边界都切块会把 2048 的块切碎；复用几乎都发生在历史尾部。）
- 会话同时保存 T 末尾的 logits。R 与 T 完全相同时（预热后发送同一请求）直接从这组 logits 开始解码。快照也保存所在位置的 logits（约 0.5 MB），所以快照正好落在 R 末尾时也能直接解码：同一请求重试或重新生成时，整个 prompt 都能复用（真实模型一致性测试中 W16 暴露了这一点）。
- **生成之后**：T 等于 prompt 加上已经喂进模型的生成 token（最后采样出的那个 token 还没有喂入）。下一次请求的渲染会把它连同 `<|im_end|>\n` 一起作为增量追加。
- **内存预算**（P4 验收中按实测修订，用户选择的 C1）：每次请求开始前重新计算：预算 = 当前可用内存 + 会话已占用 + MLX 缓冲缓存 − 激活预留（4 GiB）− 缓冲缓存上限（0.5 GiB）− 桌面余量（4 GiB），并且不超过「wired 上限 − 常驻权重 − 激活预留 − 安全余量」。原先只按 wired 上限算（约 12 GiB），默认 wired 之外的内存都归模型，而这台 96 GiB 的机器上 macOS 和桌面程序约占 14 GiB，长上下文会把它们挤进压缩。开始生成前按 `(len(R) + max_output_tokens) × 29 KB + 快照` 估算需求，不够时按 LRU 淘汰空闲会话（整个丢弃；B2 改为溢出到 SSD）。单个请求本身超出预算时，只保留 prompt 末尾的一个快照。MLX 缓冲缓存上限从 2 GiB 降到 0.5 GiB。
- **token 映射**（第 6.5 节）：键是 assistant 回合**按模板渲染出的文本**的 sha256，值是生成提示符加上生成的 token id，一直到 `<|im_end|>`（在 `</tool_call>` 处停止时补上 `<|im_end|>`）。按文本做键，item 带什么 id、`phase` 都不影响命中；值包含生成提示符，所以 `none` 档（提示符里已有空 think 块）也能逐 token 复现。LRU 上限 1024 个回合或 800 万个 id。被中断、失败或达到输出上限的回合不记录。

**生成**（`generate.py`，第 7 节）：

- 按 2048 分块预填充，并在快照点处切开；每块之间检查取消。（B2-5 起块大小随上下文变小，快照点只保留 prompt 末尾和一个条目边界，见 P6。）
- 解码时按生效强度选择采样参数。`presence_penalty` 按 OpenAI 的语义作用于本次已生成的全部 token（mlx-vlm 自带的实现只看最近 20 个，不采用）；词表补齐出来的行（id ≥ tokenizer 词表大小）一律屏蔽；`tool_choice:none` 时把 248058 的 logit 置为负无穷；`parallel_tool_calls=false` 时在 248059 处停止。
- 解码循环不做流水线：PLE 查表需要在 CPU 上拿到 token 值，提前排下一步的计算收益有限。B2 引入 MTP 时再重构。
- `output_tokens` 计入停止 token；`reasoning_tokens` 是推理区间内的 token 数（含 `</think>`），生效强度为 `none` 时为 0。
- 预填充中收到中断：立即以 `incomplete`（`interrupted`）结束，不产生 item；已预填充的部分留在会话里供下次复用。
- 计数（`count_tokens`）在控制线程完成，用独立的 tokenizer 实例，token 映射加锁共享，所以计数结果与生成时的 `input_tokens` 一致，也不会排在生成后面。
- 生成中出现意外异常：该 job 以 `failed`（`engine_failure`）结束，丢弃全部会话（它们只是加速），worker 继续服务。
- usage 使用真实计数；`reasoning_tokens` 是推理区间内的 token 数。

**PLE 预取**（`ple_prefetch.py`，B1-10）：

- 预填充：用 PLE 模块自己的乘子和各头的词表大小，在 CPU 上算出下一块的行号（纯函数，依赖当前块和前两个 token，遇到 `<|endoftext|>` 时重置窗口）；在 GPU 计算当前块的同时，用线程池把这些行所在的页读进页缓存。上游读取器不用改，届时读到的都是缓存。B0 微基准：已缓存时一个 2K 块约 0.04 秒，预取本身约 1.1 秒，都小于 GPU 算一块的时间。
- 解码：下一个 token 采样出来之前无法知道行号，所以沿用 B0 的做法，在读取之前并发触碰当前 token 需要的页。
- 行连续存放（每行只触碰 1 个页）和行缓存留到 B2-5 调优。

### 14.6 生命周期与权重（B1-2）

- 移植 local_llm 的 `backend_service.sh`、`macos_service.sh`、`service_entrypoint.sh` 和 `lifecycle.py`，只保留 macOS 的部分。服务标签为 `com.aporisa.backend.<用户>.<项目路径 SHA256 前 12 位>`；启动和停止的超时放在 `configs/macos_service.sh`。
- `.env` 只放部署差异：`APORISA_API_KEY` 和 `APORISA_BACKEND_PORT`（默认 18080，沿用 local_llm 的惯例；local_llm 优先级更低，不考虑同时运行时的冲突）。后端只占用这一个端口：worker 通过 socketpair 通信，不监听端口。以后新增任何端口，也一律放进 `.env`（用户决定）。
- **doctor、prepare 和 run 共用的检查**：Apple Silicon 和 Metal；`.env`；依赖与锁文件一致；源码收据；指针引用的身份（在 `MODEL_LIST` 中、有合法的 profile、有唯一的本地记录、SHA256 完整）；`iogpu.wired_limit_mb` 不低于 profile 的要求（affine 格式为 87040）；可用内存；端口空闲。
- `model_weights.sh` **完全沿用 local_llm 的思路**（D-15，用户确认），便于以后替换模型：
  - `download`：必须给出仓库 ID 和 `--identity`，可选 `--revision`；不指定时先解析远端版本，再固定到不可变的 commit；下载暂存在 `.runtime/weight-staging/<目录>/`，逐个文件核验后发布到 `.runtime/models/<目录>/<revision>/`；支持续传。目录已经完整时只做离线校验，然后登记，所以 B0 下载的 FP8 checkpoint 不需要重新下载。
  - `list` 只读；`delete` 参数是精确的目录名，同时删除身份记录。
  - 身份记录在 `.runtime/model-assets/<目录>.json`；逐目录加锁，模型使用中时拒绝写操作。
  - 相对 local_llm 唯一的扩展是 `convert`：从已登记的源身份，按包内的配方（由 `b0_convert.py` 迁入）生成产物，发布到 `.runtime/models/<目录>/<配方摘要>/`，并登记为新的身份。B0 已有的两个产物在 P3 时移入这个布局：同一磁盘内的重命名，不需要重新转换。

**P3 定稿（2026-09-30，用户确认的 6 项决策）**：

1. **对外服务的产物是一个自包含目录**：外置 PLE 视图的全部文件，加上它读取的 PLE 分片文件，`ple-store.json` 的 `source_root` 指向本目录。一个身份只对应一个目录，校验、加锁、删除都只针对这一个目录。PLE 常驻内存的完整 checkpoint 不再单独保留：服务从不使用它，需要时可以从 FP8 重新转换。
2. **B0 产物用一次性迁移脚本登记**（`scripts/migrate_b0_artifacts.py`，先例是 local_llm 的 `migrate_weight_metadata.py`）：核对 B0 的 `recipe.json` 与包内配方一致，用硬链接组装新目录（不占额外磁盘，也不重新转换），计算 SHA256 清单，并写入身份记录，来源取自 B0 下载清单中的仓库和 revision。MTP 草稿模型同时登记。B1 收尾时删除这个脚本。
3. **SHA256 分级校验**，沿用 local_llm：`prepare` 对全部文件完整计算 SHA256，按文件并行，通过后写入 prepare 收据；`start` 和 `run` 只核对收据、文件清单、大小，以及非 safetensors 小文件的哈希。
4. **`convert` 保留并内化 FP8 转换逻辑**：配方、FP8 加载绕过、`check_layout`、复制 LICENSE 都迁进包里；自动测试只用一个很小的 FP8 checkpoint。真实转换不在 P3 中复跑。原始 FP8 权重在服务不再依赖它之后删除，以后需要时重新下载。
5. **清理**：P3 完成后删除 `dev_serve.py`（服务只有一个入口）；`MODEL_LIST` 去掉 mxfp4，加入 MTP 的身份；`backend/scripts/b0_*.py` 保留到 B1 收尾。
6. **start 等待就绪的超时暂定 900 秒**，放在 `configs/macos_service.sh`；首次真实 start 之后按实测的加载加预热耗时调整。（已调整：实测 21 秒，改为 300 秒。）

布局：`.runtime/models/<目录>/<revision 或配方摘要>/`，`.runtime/model-assets/<目录>.json`，`.runtime/model-locks/<目录>.lock`，`.runtime/weight-staging/<目录>/`。只支持 macOS，所以不再按平台分子目录（偏离 local_llm）。

### 14.7 测试

| 层 | 内容 |
|---|---|
| 协议 | 严格 JSON；形状校验的错误码映射；语义规则（移植前端 `protocol.test.ts` 的用例）；生效强度 |
| 事件组装 | 每种 item 的事件序列；由 Python 版的顺序校验器检查 |
| 网关 | 假 worker（在进程内实现 IPC 对端，行为类似前端的 mock 引擎）：HTTP 和 WebSocket 两种传输、准入、取消、中断、超时、恢复 |
| 一致性 | pytest 在随机端口启动「网关 + 假 worker」，调用前端的 `tools/conformance.ts`，要求 W01–W24 全部通过（需要项目内的 Node；缺少时跳过并注明原因） |
| 适配层 | 渲染结果与官方模板逐字一致（用 transformers 渲染作为基准）；增量解析在任意位置切分输入都得到同样的结果 |
| 会话 | 匹配、淘汰、预算，用假 cache 测试；小模型上的快照恢复要求逐位一致 |
| 真实模型（用户运行） | 启动预热；`scripts/validate_runtime.py`；在 Studio 上对真实服务运行 `npm run conformance` |

开发过程中，agent 会运行单个测试文件（这不是 CI 门禁）；门禁 `./scripts/check.sh backend` 仍然由用户运行。

### 14.8 实现顺序

| 阶段 | 内容 | 完成标志 |
|---|---|---|
| P1 | `protocol/`、`configs/`、日志、网关、假 worker | 网关加假 worker 通过 W01–W24 |
| P2 | `ipc/`、worker 主循环、适配层、会话、生成、PLE 预取 | 小模型测试通过；用户在真实模型上完成预热，一致性测试 W01–W24 全部通过（2026-09-30 完成） |
| P3 | 生命周期脚本、权重维护、检查、LaunchDaemon | 用户手动完成 install/start/stop/uninstall 的验收（2026-09-30 完成） |
| P4 | 可观测性字段、`/health/runtime`、`validate_runtime.py` | 第 10 节的字段出现在 JSONL 中（2026-09-30 完成；B1-10 的长上下文验收也在此通过） |

**P4 定稿（2026-09-30，用户确认）**：
- 范围：补全第 10 节的日志字段（`queue_ms`、`ple_bytes_read`、`ple_read_ms`、`snapshot_count`、`snapshot_bytes`、`session_bytes`；`ple_cache_hit_rate`、`mtp_accept_rate`、`ssd_spill_count` 属于 B2，不输出占位值）；`/health/runtime` 合并 worker 状态（限时 2 秒，拿不到时为 null）；`scripts/validate_runtime.py`（对运行中的服务做有上限的真实生成检查，另有可选的长上下文检查，用来验收 B1-10：预填充速度对照 B0-5、全程不增加 swap）；隐私自检测试（小模型端到端，断言日志中不出现请求正文）。
- 网络：服务只监听 `127.0.0.1:18080`，不新增监听地址。I1 及外网访问由用户在 Studio 上现有的 Cloudflare Tunnel 转发到这个地址（用户决定）。
- B1 收尾（删除迁移脚本和 `backend/scripts/b0_*.py`、补 `docs/architecture.md`）不放进 P4，在用户验收 P4 之后单独进行（用户决定）。

---

## 15. 待定问题

- [x] 量化格式：affine 4-bit gs64（D-05）
- [x] `max_output_tokens` 的取值：32768（B0，第 5.1 节）
- [x] 换档的渲染方案，以及是否把 `reasoning` 从 WebSocket 续接一致字段中移除：采用方案 C（D-17），`reasoning` 保留为一致字段
- [x] 快照数量 K 与内存预算：K=16，预算按实际余量动态计算（第 14.5 节，P4 的 C1）
- [x] SSD 层的容量（B2-1）：64 GiB，只在淘汰和正常停止时写（B2 定稿）
- [x] 思考标签和工具调用的格式（B0-6，见第 5.4 节）
- [x] 换档方案：C（D-17）
- [x] 中途指令段的格式：中途 system 段（B0-12）
- [ ] 各档位指令文字的效果：在更难的任务上评估（F6 或 B2）
- [x] `developer` 角色的渲染方式：在原位置渲染为 system 段（B0-12）
- [x] eos 两个 id 分别对应什么；`<tool_call>` 和 `<think>` 是否为单个 token（第 5.4 节）
- [x] 私有 IPC 的最终格式：socketpair 加长度前缀的 JSON 帧（第 14.3 节）
- [x] 工具调用无法解析时的错误码：新增 `tool_call_invalid`，同时明确 `function_call` 的保证范围（合同已修订）
- [x] 图片输入是否在 B2 实现：必须支持（用户决定，B2 定稿）
- [x] 官方 FP8 checkpoint 的实际大小和固定的 revision：185.6 GB，`236dfdf`（见第 3 节）
- [x] 主体用 gs64、PLE 用 gs32 的混合量化：可以，用自定义量化谓词（`b0_convert.py`），mxfp4 格式也能让 PLE 保持 affine gs32
- [ ] PLE 行存储的具体实现：连续存放的格式、行缓存大小（B1 只做了页预取，其余留给 B2-5）
- [x] 转换配方如何描述和版本化：配方名、配方内容、产物布局和转换工具版本一起算摘要，产物版本目录即摘要前 16 位（`lifecycle/recipes.py`，B1 P3）

## 16. 变更记录

- **2026-09-29**：初稿。记录 D-01 到 D-13；给出架构、缓存设计，以及 B0、B1、B2 的划分。
- **2026-09-29**：新增 D-14，推理强度由前端控制，默认 medium，并提出换档不能让缓存失效的要求。本文是临时开发文档，后端完成后会拆分到 `docs/` 并删除。
- **2026-09-29**：新增 D-15，模型配置、本地权重、服务生命周期三者解耦。权重的下载和转换从 `prepare` 移到独立的 `model_weights.sh`；公开别名从 `.env` 移到 configs 的 `POINTERS`。同步修改第 5.1、9、11 节，以及 B0-2、B1-2。
- **2026-09-29**：新增 D-16，GPU 可锁定内存上限暂定 85 GiB，并持久化到 `/etc/sysctl.conf`。同步修改第 3、9 节。
- **2026-09-29**：完成 B0-1。锁定 mlx-vlm 的 commit 和 mlx 的版本；补上官方 checkpoint 的大小和 revision；新增待定问题：混合量化能否直接用 `mlx_vlm.convert` 表达。
- **2026-09-29**：B0-6 的模板部分完成：档位渲染在 system 段开头，其中 medium 和 none 不注入文字；没有 `configuration_update`；工具调用为 XML 格式；`preserve_thinking=true` 是必须的；`developer` 角色模板不支持。给出换档的 A / B / C / D 四个方案。tokenizer 部分等下载完成后补充。改写第 5.2–5.4 节，并在第 3 节补上许可证要点。
- **2026-09-29**：新增 D-17，换档采用方案 C（`configuration_update`）。合同已同步：协议第 3.3、5、6、6.1、7.1 节，前端的类型、schema、mock、一致性测试 W23 和 W24、SDK 测试，以及兼容文档。本文第 5.2 节改为记录决定和后端渲染方案；一致性测试的范围扩展为 W01–W24。
- **2026-09-30**：B0-1 到 B0-7 已完成（B0-7 为静态部分）：第 3 节换成内存和速度实测值；第 5.4、6.5 节补上 tokenizer 和增量渲染契约的结论；第 6.6 节撤销固定 12GB 的快照预算；第 7 节定下分块大小 2048，并记录 PLE 读取和位置编码两个发现；新增 B1-10；D-05 补上转换配方和 FP8 加载的坑。
- **2026-09-30**：新增第 14 节「B1 详细设计」（原第 14、15 节顺延为第 15、16 节）：定下代码结构、IPC（socketpair 加 JSON 帧）、网关持有续接语义、按 token 前缀匹配会话、动态内存预算、PLE 页预取和测试方案。
- **2026-09-30**：B0 全部完成（B0-8 到 B0-12 的结果见 validation.md）：格式定为 affine 4-bit gs64；D-12 的备选暂不需要；打开 `parallel_tool_calls`；developer 和换档指令都渲染为中途 system 段；B2-2 默认起草深度 3。
- **2026-09-30**：合同修订：明确 `function_call` 的保证范围，新增 `tool_call_invalid`；已同步到协议文档、TS 类型和 schema、mock 测试、兼容文档，以及后端网关和假 worker。B1 的 P1（协议校验、网关、假 worker）完成。
- **2026-09-30**：B1 的 P2 完成代码和小模型测试：真实 worker、IPC、Qwen 适配层、会话与快照、PLE 预取、`dev_serve`。第 14.3–14.5 节按实现补充：`init` 帧和 `cancelled` 确认、快照点收窄到最后 K−1 个边界、token 映射改为按渲染文本做键、采样与计数细节。合同修订：function 工具的 `strict: true` 需要 `structured_output` 能力（协议第 5、8.3 节，前端校验与测试、兼容文档、后端校验同步修改）；一致性测试 W19、W24 的前置请求输出预算改为 2048。
- **2026-09-30**：P2 在真实模型上验收：W01–W24 全部通过。修复验收中发现的三处问题：uvicorn 拒绝握手时的误报日志、被拒绝请求的日志名称、prompt 末尾的快照不保存 logits（第 14.5 节已补充）。worker 计量写入 response 日志。
- **2026-09-30**：P3 代码完成：`backend_service.sh` 与 LaunchDaemon、`model_weights.sh`（download / convert / list / delete）、身份记录与目录租约、共用检查与分级校验、B0 产物迁移脚本；第 14.6 节写入用户确认的 6 项决策。`dev_serve.py` 删除，`MODEL_LIST` 去掉 mxfp4、加入 MTP 身份。新增直接依赖 huggingface-hub、hf-xet、packaging（锁文件中原本就有，版本不变）。
- **2026-09-30**：P3 验收中首次 `start` 失败：launchd 的文件描述符软上限 256 不够外置 PLE 表的 384 个 memmap；网关和 worker 启动时把软上限提高到 65536。控制台前缀按用户偏好统一改为 `[Aporisa Code]`（前后端的脚本、CLI 工具和 AGENTS.md 的约定）。
- **2026-09-30**：P3 验收完成：修复文件描述符上限后，`start` 就绪（加载加预热 21 秒），对系统服务运行一致性测试 W01–W24 全部通过，`stop / uninstall` 干净退出。start 等待上限改为 300 秒。
- **2026-09-30**：P4 代码完成：第 10 节的字段（按实现改名：`ple_lookup_ms`、`ple_prefetch_ms`、`session_bytes`；`peak_memory_gb` 改为按请求重置）、`/health/runtime` 合并 worker 状态、`scripts/validate_runtime.py`（含 B1-10 的长上下文验收）、日志隐私自检测试。测试夹具改为经身份记录定位本地模型文件（B0 目录删除后原路径失效，测试被静默跳过）；`check.sh backend` 显示跳过原因。
- **2026-09-30**：P4 验证中发现启动时桌面卡顿、运行期速度只有 P3 验收时的三分之一、`--long` 期间 worker 未能在 30 秒内确认取消。用户同意先做测量和三项改进：记录系统级内存压力（每个请求、启动期间、验证脚本每秒采样）；计算 SHA256 后释放文件的页缓存；worker 加载后释放权重文件的页缓存（实测 `F_NOCACHE` 读取仍会留下大部分缓存，改用 `msync(MS_INVALIDATE)`）；预填充在等待 PLE 预取时也响应取消和中断，取消确认上限改为 60 秒。PLE 行存储（有界缓存、绕过页缓存）等重启后的测量结果再决定。
- **2026-09-30**：重启后的测量确认启动卡顿来自加载时的大规模压缩周转（约 56 GiB），运行速度已恢复正常，WebSocket 检查失败是状态刷新的竞态。用户同意先做 A（先记录计量再发终止事件，慢统计改为按需）和 B（逐层加载并逐层释放页缓存）；内存预算的余量（C）等 `--long` 的数据再定。
- **2026-09-30**：C1 实现：会话预算改为按当前实际余量动态计算（给桌面留 4 GiB 余量），MLX 缓冲缓存上限降到 0.5 GiB；第 14.5 节同步修订。
- **2026-09-30**：B1 收尾：删除 `backend/scripts/b0_*.py` 和 `scripts/migrate_b0_artifacts.py`（连同迁移脚本的测试），文档中对它们的引用改为指向历史提交；新增 `docs/architecture.md`；第 15 节的待定问题按实现更新。B1 完成，I1 待在 Air 上进行。
- **2026-10-01**：B2 定稿（用户确认的 6 项决定，见 B2 一节）。P1（B2-2 MTP）代码完成：草稿模型身份经 profile 引用，校验、收据和租约覆盖两个目录；解码改为「起草 → 一次验证 → 逐位采样」的轮次；草稿模型状态随会话和快照保存；新增 `mtp_accept_rate` 和验证脚本的 `speculative` 检查。查明 B0-10 的「深度」是 mlx-vlm 的 `draft_block_size`（草稿数 + 1），「深度 1 异常」即 0 个草稿；第 3 节和 B2-2 的表述已更正。
- **2026-10-01**：P1 首次真实验证：短上下文解码 40.6–44.3 tok/s（B0-10 普通解码的 1.3–1.44 倍），`--long 131072` 在预填充末尾出现内存风暴（压缩器 43.6 GiB、swap 增长 915 MiB、桌面卡顿），随后长上下文解码只有约 7.6 tok/s。查明 B1 起就存在的未计入内存：预填充整块 logits 的最后一行（切片）钉住整块约 1 GB，会话和快照各一份；草稿模型又多占 1.4 GiB 后余量耗尽。修复为只对最后一个位置投影，草稿状态的隐藏状态行改为拷贝，并加测试；验证脚本的 `--long` 增加长上下文解码速度检查。
- **2026-10-01**：P1 第二次真实验证：预填充恢复到 B0-5 的 96.4%，内存风暴消失；125K 上的 MTP 解码仍只有 8.2 tok/s（每轮约 255 毫秒），需要在真实模型上逐步剖析。命令结束后桌面卡顿：会话预算只在请求开始时计算，空闲会话一直占着内存。新增 `idle_pressure_check_s`：worker 空闲时按内核内存压力等级丢弃空闲会话，请求开始时处于压力下也先丢弃（第 14.5 节 C1 的补充）。
- **2026-10-01**：P1 真实模型剖析（用户运行，agent 写的一次性脚本）：32K 时目标模型验证 1 / 2 / 3 个 token 为 39 / 44 / 54 ms，111K 时为 49 / 54 / 209 ms；草稿模型每轮约 5–10 ms。长上下文下 3 个 token 的验证开销陡增（根因在 mlx-vlm 的长上下文多 token 验证路径中，用真实注意力维度的小模型只复现了一小部分，未查明）。profile 的 `draft_tokens=2` 改为 `draft_schedule=((0, 2), (32768, 1))`：32K 起每轮只起草 1 个。
- **2026-10-01**：P1 第二轮剖析（16K / 32K / 113K，每种模式续写 128 个 token）与第三次真实验证：`--long 131072` 全部通过（123K 预填充 674 tok/s，为 B0-5 的 98%；125K 上解码 25.3 tok/s，高于 B0-5 普通解码的 21.1；swap 不增长）。按剖析把草稿数阈值从 32K 下调到 16K（16K 时 1 个草稿比 2 个快约 14%，32K 时两者持平）。
- **2026-10-01**：P1（B2-2 MTP）通过验收：用户报告 `check.sh backend`、验证（含 `--long`）和对系统服务的 W01–W24 一致性测试全部通过；数字见 validation.md 的 B2 P1。
- **2026-10-01**：P2（B2-3 提示词查找）代码完成：numpy 向量化的 n-gram 查找与 MTP 组合；两轮真实剖析后，查找草稿每轮最多 32 个，宽轮次（16K 起 3 个以上、16K 以下 8 个以上）走预填充路径验证。改代码基准上短 / 16K / 111K 为 138 / 129 / 116 tok/s（普通解码的 4.5–5.5 倍）。新增计量 `lookup_accept_rate`、`lookup_rounds`；验证脚本新增 `lookup` 检查和长上下文改代码检查。
- **2026-10-01**：P2 第一次真实验证：改代码类检查通过（短上下文 143 tok/s，125K 上 103 tok/s），但普通回答变慢（短上下文 38.3 tok/s 未达 1.3 倍的要求，125K 上 21.3 tok/s）：查找在普通文本里的误中。改为按匹配长度决定查找草稿数（3 个 token 给 2 个，每多 1 个翻倍，最多 32 个）。
- **2026-10-01**：P2（B2-3 提示词查找）通过验收：验证脚本 11 项与 W01–W24 全部通过；改代码 140.9 tok/s（短上下文）/ 111.3 tok/s（125K），普通回答保持 P1 的水平。
- **2026-10-01**：P3（B2-4 结构化输出）代码完成：合同新增第 8.4 节（约束范围、与工具调用的关系、未完成时丢弃、最终校验兜底，对象按「封闭」理解）；前端 TS 值校验器与实例生成、mock 按 8.4 行为、一致性测试 W25（text.format）和 W26（strict 工具参数）；后端 llguidance 约束解码（`engine/structured.py`）、`text.format` 以生成提示符之前的 system 段告知模型、最终校验、假 worker 按 8.4 行为、`structured_output` 能力开启；验证脚本新增 `structured` 检查。
- **2026-10-01**：P3（B2-4 结构化输出）通过验收：用户报告后端 CI、验证脚本（含 `structured`）与 W01–W26 全部通过。
- **2026-10-01**：P3.5：把 B2-5 候选中的「一轮一次采样」提前到 P4 之前（用户决定）。
- **2026-10-01**：服务空闲约 10 小时后内存压力变黄：模型的 GPU 内存不再被锁定，被系统压进压缩器（53 GB，几乎压不动）。用户决定只做「加载后用 `mlock` 锁定全部权重」，不做空闲卸载；见 validation.md。
- **2026-10-01**：P3.5 真实验证：一轮一次采样让改代码提速 9–13%，锁定权重 68.1 GiB、长上下文正常；普通回答因查找短匹配误中慢约 6%（`speculative` 未过）。改为短匹配须与 MTP 的预测一致才用查找草稿。
- **2026-10-01**：P3.5 与权重锁定通过验收（验证 12 项、W01–W26 全部通过；普通回答 44.0 / 45.4 tok/s，改代码 154.7 tok/s）。
- **2026-10-01**：P4（B2-1 SSD 溢出与重启恢复）定稿：用户采用四项建议（读盘校验、停机预算 45 / 120 秒、不做跨会话系统提示复用、不新增生命周期模式）。代码完成：`engine/disk_cache.py`、会话淘汰与停机时写入、请求时从 SSD 恢复、计量、`validate_runtime.py` 的重启验收。
- **2026-10-01**：P5（B2-6 图片输入）定稿：用户采用四项建议（分辨率上限 auto 约 100 万、high 约 400 万像素；正文 64 MiB、每请求 64 张图；先于调优；前端只做合同层）。合同（protocol 第 7.1、11 节、W27–W30、mock、TS 结构检查）与后端实现完成，小模型测试通过。
- **2026-10-01**：后端 v0 收尾（用户决定）：B2-7 只写好 `scripts/soak.py` 备用、不跑；`/health/runtime` 的 worker 视图增加 `rss_bytes` 和 `open_fds`（soak 用来看泄漏）；整理已知事项，下一步转向前端。
- **2026-10-01**：P6 通过最终验证并提交：后端 CI、`--long 200000` 13 项（200K 预填充 101%、解码 18.8 tok/s、swap 不变）、W01–W30。
- **2026-10-01**：P6 改动后：agent 循环首 token 中位数 −27%、合计 −21%；200K 冷预填充 96%、不写 swap；`--long 200000` 解码 11.0 tok/s 未通过。查明原因是长上下文解码的临时缓冲超过 MLX 缓冲缓存上限，改为 64K 起解码期间缓存上限 2 GiB（222K 上 +38–40%）。
- **2026-10-01**：P6 剖析（v2）与实现：块大小随上下文变小、快照只在 prompt 末尾和一个条目边界切、PLE 预取改用 `F_RDADVISE`、草稿数表改为 2 / 3（16K 起）/ 2（96K 起）；小模型测试通过，真实对比待用户运行。
- **2026-10-01**：P6（B2-5 调优）定稿：用户采用四项建议（T1、T2 做，T3 先剖析，T4、T5 不做；快照只在最后一个条目边界和 prompt 末尾切；长上下文可慢 5–10% 以换不压缩桌面；`--agent-loop` 作为对比标准）。先写剖析脚本和 agent 循环基准，在改动引擎之前测基线。
- **2026-10-01**：P5 通过验收（用户报告后端 CI 通过）并提交。真实验证：视觉塔剖析（4,096 个图片 token 编码 3.2 秒、带图预填充 8.4 秒，峰值比权重多 3.85 GB，无压缩），维持分辨率上限；验证脚本 12 项（含 `images`）与 W01–W30 通过。
- **2026-10-01**：P4 通过验收（用户报告后端 CI 通过）并提交。真实验收：197K 会话停机写盘 6.5–7.8 秒，重启后从 SSD 恢复 1.4–1.7 秒、首 token 1.9–2.2 秒（冷启动 320–331 秒）。第一次恢复时系统压缩了约 7 GB（经主机内存中转），改为直接读进 MLX 数组后为 0。
