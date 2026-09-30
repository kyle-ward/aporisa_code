# 验证记录

本文只记录已经实际运行过的检查，以及明确尚未验证的事项。预期不写成结果，替身测试也不代替真实验收。

## B1 P3：生命周期与权重维护（2026-09-30，Mac Studio）

范围：`backend_service.sh`（`scripts/backend_service.sh`、`macos_service.sh`、`service_entrypoint.sh`、`backend.sh`、`lifecycle.py`、plist 模板）、`model_weights.sh`（`lifecycle/weights.py`、`recipes.py`、`assets.py`）、共用检查与收据（`lifecycle/checks.py`、`artifacts.py`、`dependencies.py`、`service_guard.py`、`cli.py`）、B0 产物迁移脚本、`backend/.env.example`；删除了 `dev_serve.py`。设计见 DEVELOPMENT_PLAN 第 14.6 节（用户确认的 6 项决策）。

**agent 已验证（开发期运行单个测试文件，不是 CI 门禁）**
- 后端全部 93 个测试通过，ruff 通过（`check.sh backend` 现在也检查 `scripts/*.py`）。新增：
  - 权重 8 个：身份记录的校验（版本与来源一致、路径穿越、转换来源必须带上游仓库和 revision）、目录命名、共享与独占租约、快速校验与完整校验的区别（同大小改一个字节只有完整校验能发现）；用本地假 Hub 测下载的发布、离线复用、换源拒绝、租约冲突、删除、以及登记已存在的目录；用很小的 FP8 checkpoint 走完 `convert`（产物自包含、删除源身份后仍能加载并预热、重复转换直接跳过）；用同样的小模型模拟 B0 布局跑迁移脚本（dry-run 不改任何东西、登记两个身份、B0 目录原样保留、硬链接不复制、重复运行幂等、删除 B0 目录后仍能加载并预热）。
  - 生命周期 8 个：`.env` 检查、源码收据过期、模型检查的分级（未 prepare 为 REPAIRABLE、改动小文件为 MANUAL、wired 上限不足为 MANUAL、没有记录为 MANUAL）、服务标签、入口脚本的 help 和参数错误、plist 模板合法。
- 在真实 checkout 上只读运行：
  - `./model_weights.sh list`：B0 的 4 个目录显示为 unmanaged（尚未迁移）。
  - `./scripts/backend.sh doctor`：平台、存储、依赖 READY；缺少 `backend/.env`（MANUAL）、没有 prepare 收据（REPAIRABLE）、指针引用的身份没有记录（MANUAL），分类符合预期。
  - `./backend_service.sh status`：`UNINSTALLED`。
  - 迁移脚本 `--dry-run`：真实 B0 checkpoint 的配方、工具版本和张量布局都核对通过。

**用户验收（进行中）**
- `./scripts/check.sh backend` 通过（93 个测试）。
- 迁移脚本：dry-run 与正式运行都成功，登记了 `Qwen3.8-Flash-Next-affine4g64`（35 个文件）和 `Qwen3.8-Flash-Next-affine4g64-mtp`（7 个文件）；`list` 显示两个身份，B0 的 4 个目录仍为 unmanaged。
- `prepare`（完整 SHA256 校验通过）、`doctor`、`install`（`REGISTERED_IDLE`）都成功。
- **首次 `start` 失败**：worker 加载外置 PLE 表时报 `Too many open files`。原因是 launchd 给守护进程的文件描述符软上限只有 256，而 PLE 表有 128 个分片 × 3 个张量 = 384 个 memmap，每个都占一个描述符；终端里的上限是 1048576，所以用 `dev_serve` 在终端启动时没有暴露。修复：网关的 `run` 和 worker 启动时把软上限提高到 65536（不超过 hard limit，不需要特权）。agent 在真实 PLE 清单上复现：软上限 256 时打开失败，提高后 128 个分片全部打开；新增 1 个测试，后端 94 个测试通过。
- 修复后：用户再次运行 `check.sh backend`（94 个测试）通过；`stop` 把 FAILED 的 job 清理为 `STOPPED`；`prepare` 重新完整校验并写入收据；**`start` 就绪**（`READY`，worker 加载加预热 21.0 秒，权重在页缓存中）。
- 对**系统服务**运行一致性测试 **W01–W24 全部通过**。服务日志中：峰值内存 67.9–68.7 GiB，短 prompt 下解码约 31.5 tok/s、首 token 约 145 ms。
- `stop`：job 和进程树（含 worker）全部退出，状态 `STOPPED`，plist 保留；`uninstall` 后为 `UNINSTALLED`，模型、配置和日志保留；agent 复查没有残留的后端进程。
- 按实测把 start 的等待上限从 900 秒改为 300 秒（给开机冷启动读盘留余量）。
- 用户随后用 `model_weights.sh delete` 删除了 B0 的 3 个旧目录和官方 FP8 checkpoint（约 173 GiB）；`list` 只剩两个已登记的身份。
- **P3 验收完成。**尚未验证：开机自启（重启机器后自动就绪）、开机冷启动的实际耗时、长时间运行。

## B1 P2：真实 worker（2026-09-30，Mac Studio）

范围：`ipc/`（socketpair 加 JSON 帧）、`gateway/process_worker.py`（启动、环境变量白名单、取消确认、进程组停止）、`engine/`（加载与预热、Qwen 适配层的渲染与增量解析、token 映射、会话与快照、预填充与解码、PLE 页预取）、`dev_serve.py`，以及合同修订「`strict: true` 需要 `structured_output`」。

**agent 已验证（开发期运行单个测试文件，不是 CI 门禁）**
- 后端全部 76 个测试通过，ruff 通过。新增的测试：
  - 适配层 28 个：12 种请求（有无工具和 instructions、四个档位、多轮工具调用、并行调用、空推理、非字符串参数、Unicode、首尾空白）的渲染结果与官方模板 `apply_chat_template` 的**文本和 token 都完全一致**；自带 tokenizer 与 AutoTokenizer 一致；中途 developer 和 `configuration_update` 段恰好插在 item 边界上；token 映射让重新渲染复现生成时的 id；解析器的推理、回答、`phase`、空推理、`none` 档、按 schema 转换参数、并行与非并行停止、零参数调用、调用之后的文字，以及 5 种结构损坏的 `detail`；解析出的 item 重新渲染后等于模型生成的文本。
  - 引擎 8 个（随机初始化的小 qwen4_exp 模型，与真实模型同样的转换流程：affine 4-bit gs64、外置 PLE、8-bit 路由门控）：PLE 行号的 numpy 实现与模型实际请求的行号一致（含 `<|endoftext|>` 处的窗口重置和跨块的窗口）；快照恢复后的 logits 与原始预填充和冷启动都**逐位相等**；生成后追加历史走活跃游标，`cached_tokens` 等于 prompt 加生成 token 数减 1；预热后同样的请求完全复用；工具调用与非并行停止；损坏调用以 `tool_call_invalid` 结束；输出上限、中断、硬取消、上下文超长；预算不足时淘汰空闲会话。
  - 端到端 3 个（网关 + worker 子进程 + 小模型）：流顺序合法，计数与 usage 一致，同一 `prompt_cache_key` 复用前缀；客户端断开后取消送达引擎、名额释放、worker 仍然存活；SIGKILL worker 进程组后进行中的流以 `engine_failure` 结束，服务自动重启并恢复可用。
  - 协议 1 个：`strict: true` 在未声明 `structured_output` 时返回 400 `unsupported_parameter`。
- 前端 `./scripts/check.sh frontend` 通过，共 92 个用例（新增 1 个 `strict` 用例）；一致性测试 W19、W24 的前置请求输出预算改为 2048（真实模型要先推理），对假 worker 仍然全部通过。
- `dev_serve` 在小模型上冒烟：就绪、完成一次流式请求、停止后没有残留的 worker 进程。

**用户已验证**
- `./scripts/check.sh backend` 通过（含上面新增的全部测试）。

**真实模型验收（用户运行）**
- 用 `dev_serve` 在 `Qwen3.8-Flash-Next--affine4g64-extple` 上启动：加载和预热成功，服务就绪。
- 用前端一致性测试 CLI 对它运行 W01–W24：**24 项全部通过**（按 B1 的阶段划分，P2 的完成标志达到）。
- 服务端日志（只有计数和缓存路径）显示：
  - 冷启动的短请求 1.1–2.5 秒完成；W19、W24 的 WebSocket 续接走活跃游标，分别复用 71 个 token 中的 55 个、113 个中的 55 个；W16 的同 `prompt_cache_key` 复用走快照路径。
  - W21 中断后以 `incomplete` 结束。
- 发现并已修复的三个问题（修复后后端 77 个测试通过）：
  - W17 拒绝未认证的 WebSocket 升级时，客户端收到的 401 是正确的，但 uvicorn 0.54.0 的 websockets-sansio 实现不把拒绝响应算作完成握手，多打印一条 `ERROR: ASGI callable returned without completing handshake.`。现在只对网关主动拒绝的连接过滤这一条日志（agent 复验：401 照常返回，日志不再出现）。
  - 上下文超长被拒绝的请求被记录成「Response cancelled.」，现在记为「Request rejected before streaming.」；已开始但被客户端取消的记为 cancelled。
  - W16 中同一请求第二次发送时只复用了 16 个 token 中的 11 个：prompt 末尾的快照没有保存 logits，必须回退到上一个边界。现在快照同时保存所在位置的 logits，重试或重新生成同一请求可以复用整个 prompt（新增测试）。
- 修复后用户再次运行 `./scripts/check.sh backend`，通过。
- 同时把 worker 的计量（首 token 时间、预填充和解码速度、峰值内存）写进每个 response 的日志行，worker 就绪日志也带上加载加预热的耗时。这些字段还没有在真实模型上看过，下次运行时一并确认。

**尚未验证**：真实 agent 任务中的长上下文性能（续接收益、快照命中、PLE 预取的实际效果）；长时间运行的稳定性；生命周期脚本（P3）。

## B1 P1：网关与假 worker（2026-09-30，Mac Studio）

范围：`backend/src/aporisa_backend/` 下的 `protocol/`（严格 JSON、按已提交的 schema 校验、语义规则）、`configs/`、`gateway/`（准入、事件组装、HTTP/SSE、WebSocket、计时与上限、worker 故障恢复）和 `fake/`（在进程内模拟 worker）。真实 worker 尚未实现，所以这一节**不代表后端能在真实模型上运行**。

**已验证**
- 用户运行 `./scripts/check.sh backend` 通过。当时共 35 个测试，包括协议单元测试，网关的 HTTP 和 WebSocket 行为测试（认证、404、415、413、SSE 顺序、上下文超长、队满和排队超时、断连释放名额、空闲超时、输出字节上限、worker 崩溃后恢复、恢复次数用尽、续接展开、并发创建被拒、中断、连接寿命、断开时释放会话），以及用前端一致性测试 CLI 对「网关 + 假 worker」运行的 W01–W24，全部通过。
- 在那之后，agent 又落实了 `tool_call_invalid` 合同修订：后端新增 1 个测试，36 个全部通过；前端 `./scripts/check.sh frontend` 通过，共 91 个用例（新增 1 个 mock 测试）。随后用户再次运行 `./scripts/check.sh backend`，36 个测试全部通过。
- agent 连续三轮运行后端测试，结果一致，没有出现时序相关的不稳定。

## B0-8 至 B0-12：快照、续接、MTP、边界、质量（2026-09-30，Mac Studio）

执行者：用户运行 `b0_bench.py`，agent 分析结果。模型为 affine 4-bit gs64 的外置 PLE 视图；wired 上限 85 GiB；开启了 PLE 并发预取。

**B0-8 快照正确性**
- 在 8K 和 64K 两种长度下，都在 75% 处保存快照；先继续预填充 4K 个无关 token，再恢复快照、重新预填充尾部。最终 logits 与冷启动**逐位相等**（最大差异 0.0，top-1 一致）。
- 冷启动之间只改分块大小（2048 对比 1024），logits 也逐位相等；恢复快照后换一种分块大小，同样逐位相等。真实模型上不存在「分块噪声」，所以第 6.7 节不需要设误差阈值。
- 单个快照（全部 DeltaNet 状态）110.3 MiB；KV 加索引键 28,560 B/token。保存快照约 0.06–0.2 毫秒，恢复约 0.1 毫秒。

**B0-9 续接收益**（基础 16K token，每步追加 2K token、生成 32 个 token，共 8 步）

| 步 | 历史长度 | 活跃游标续接 | 每步冷启动 | 加速 |
|---|---|---|---|---|
| 1 | 18,464 | 3.52 秒 | 30.15 秒 | 8.6 倍 |
| 4 | 24,704 | 3.19 秒 | 39.99 秒 | 12.5 倍 |
| 8 | 33,024 | 3.42 秒 | 52.74 秒 | 15.4 倍 |

续接的首 token 时间只取决于增量大小，冷启动则随历史线性增长。

**B0-10 MTP**（3 个提示词，每个 384 个 token；`draft_block_size` = 起草深度）

| 采样 | 不用 MTP | 深度 1 | 深度 2 | 深度 3 |
|---|---|---|---|---|
| 贪心 | 31.0 tok/s | 3.5–6.4 tok/s（异常） | 41.2–44.2 tok/s，接受率 0.82–0.91 | **48.1–49.0 tok/s**，接受率 0.72–0.80 |
| 思考模式采样 | 30.7 tok/s | 3.3–6.4 tok/s（异常） | 40.7–41.5 tok/s，接受率 0.76–0.78 | **43.2–45.5 tok/s**，接受率 0.62–0.69 |

- 深度 3 的加速约为贪心 1.57 倍、思考模式 1.47 倍，与社区数据（约 1.42 倍）相当。
- **深度 1 异常**：速度掉到 3–6 tok/s，而且没有记录接受率统计，疑似 mlx-vlm v0.7.4 这条代码路径的问题。B2-2 默认使用深度 3，并单独排查深度 1。

**B0-11 边界**：预填充 262,080 个 token 后逐个解码，直到位置 262,159（超出原生上限 15 个），logits 全程有限，没有异常。峰值 79.7 GiB（85,622,094,054 字节），KV 7.08 GiB，预填充 445.7 tok/s。

**B0-12 质量抽查**（每个任务 1 个样本，思考模式，medium）

| 任务 | Flash-Next affine | Flash-Next mxfp4 | Qwen3.8-27B |
|---|---|---|---|
| 格式（一句话回答） | 正确 | 正确 | 正确 |
| 单个工具调用 | 1 次调用，格式正确 | 同左 | 同左 |
| 同一回复中并行两个调用 | 2 次调用 | 2 次调用 | 2 次调用 |
| 读工具结果后作答 | 直接答出 42 行 | 又读了一次文件 | 又检查了文件末尾 |

- 三个模型都没有产生格式错误的工具调用。所以 **D-12 的备选（27B）暂不需要**；**量化格式定为 affine 4-bit gs64**（D-05）。
- **B0-7 动态部分**：12 次生成（4 个任务 × 3 个模型，含工具调用），把输出重新渲染成历史后，文本和按段 tokenize 的 token id 都与生成时**完全一致**。
- **换档渲染**（每种条件 2 个样本；题目是一道计数题，答案 130）：在基线档位的开头注入、在对话中途注入 system 段、在中途注入 user 段，模型都正常作答；中途切换到 `none` 时推理为 0。有 4 个样本没有直接给出答案，而是调用 `exec_command` 去验证，这在有工具的 agent 场景中是合理行为。推理长度（65–340 token）在各档之间**没有明显差异**：题目太简单，档位的效果体现不出来。所以本次只能确认「中途注入不会造成异常」，不能确认档位对推理量的影响。这要留到更难的任务上评估（F6 或 B2）。
- **developer 渲染**：指令「从现在起用法语回答」渲染为中途的 system 段或 user 段，模型都遵守了；没有指令时用英语作答。

**尚未验证**：更难任务上的质量、档位对推理量的实际影响、长时间运行的稳定性（B2-7）。

## B0-2 至 B0-7：checkpoint、转换、内存、速度、模板（2026-09-30，Mac Studio）

脚本都在 `backend/scripts/`，都是 B0 的一次性脚本；测量结果写入 `.runtime/b0/results/*.jsonl`，不进入 Git。需要加载模型或转换权重的命令由用户运行；脚本逻辑先由 agent 在一个随机初始化的小 qwen4_exp 模型（`b0_tiny.py`）上验证过。

**B0-2 checkpoint**（执行者：用户下载，agent 校验）
- `Qwen/Qwen3.8-Flash-Next-FP8`，revision `236dfdf285828023ca3bcd3f37366c58a3469b13`，144 个文件，185.6 GB。用户用 `hf download` 下载。
- `b0_verify_checkpoint.py`：清单与 HF 远端一致；LFS 文件按 SHA256、小文件按 git blob id 逐个核验，全部通过（29 秒）。清单写在 revision 目录旁，供 B1-2 登记身份时使用。

**B0-3 转换**（执行者：用户）
- `b0_convert.py`：两种格式都已转换，并各自生成了外置 PLE 视图（硬链接，不复制）；affine 格式另外拆出了 MTP 草稿模型（1.4 GiB，affine 4-bit gs64）。

| 格式 | 平均 bit/权重 | checkpoint | 常驻（不含 PLE） | 转换耗时 / MLX 峰值 |
|---|---|---|---|---|
| affine 4-bit gs64 | 4.675 | 96.5 GiB | 66.8 GiB | 3.3 分钟 / 40.2 GiB |
| mxfp4 | 4.498 | 92.9 GiB | 63.1 GiB | 2.9 分钟 / 38.6 GiB |

- 两种格式的 PLE 都是 affine 4-bit gs32（29.8 GiB），路由门控 8-bit，视觉编码器不量化。转换完成后，脚本从 safetensors 文件头逐个核对专家和 PLE 张量的位宽与 scale 类型，全部符合配方。
- **第一次转换作废**：mlx-vlm 的通用加载器会把 FP8 专家权重直接转成 MXFP8 层，量化步骤随后跳过了这些层，结果平均 7.2 bit/权重、checkpoint 149 GiB。修复方法是绕过通用 FP8 转换，让 qwen4_exp 的 sanitize 先反量化成 BF16。小模型上造了官方布局的 FP8 checkpoint，修复前能复现问题，修复后通过检查。
- 小模型上：外置 PLE 视图和完整 checkpoint 的 logits 逐位一致。

**B0-4、B0-5 内存和速度**（执行者：用户；`b0_bench.py curve`）

条件：GPU 可锁定上限 85 GiB；外置 PLE；每档先热身；PLE 并发预取（64 线程，同步，不和计算重叠）；解码为贪心，每档 128 个 token。

| 格式 | 上下文 | 预填充 tok/s（纯计算） | 解码 tok/s | 峰值 | KV |
|---|---|---|---|---|---|
| affine | 2K | 576（954） | 30.2 | 70.3 GiB | 0.17 GiB |
| affine | 32K | 610（771） | 26.2 | 71.4 GiB | 0.98 GiB |
| affine | 128K | 550（682） | 20.9 | 75.3 GiB | 3.6 GiB |
| affine | 260K | 473（574） | 16.2 | 80.0 GiB | 7.0 GiB |
| mxfp4 | 2K | 492（793） | 25.7 | 65.9 GiB | 0.17 GiB |
| mxfp4 | 32K | 603（769） | 24.1 | 66.9 GiB | 0.98 GiB |
| mxfp4 | 128K | 580（712） | 21.2 | 70.8 GiB | 3.6 GiB |
| mxfp4 | 260K | 500（601） | 18.7 | 75.6 GiB | 7.0 GiB |

- 「纯计算」= 上下文长度 ÷（预填充时间 − PLE 读取时间）。PLE 读取期间 GPU 在等待，所以这是 worker 把读取和计算重叠之后的上限。
- 32K 下的分块大小对比（affine，纯计算 tok/s）：512 → 641，1024 → 723，2048 → 771，4096 → 747；4096 的峰值多 2.8 GiB。
- **第一次速度曲线作废**：没有设置 wired 上限（MLX 默认是 0），权重被 macOS 压缩并换出，swap 峰值接近 10 GB，2K 预填充只有 130 tok/s。在加载前调用 `mx.set_wired_limit` 后恢复正常。
- **PLE 读取是冷预填充的主要瓶颈**：上游串行读法下，2K 块共 11.15 秒，其中 PLE 占 8.11 秒（实际只读 2.9 MB）。文件 I/O 微基准 `b0_ple_io.py`（每批约 3.3 万行，约 9.3 万个 16 KB 页）：串行冷读 3.4–7.5 秒；页已在缓存中 0.04 秒；32–256 线程并发预取后再读约 1.2 秒，线程数超过 64 后不再提升。

**B0-6 模板与 tokenizer**（执行者：agent）
- 结论写在 DEVELOPMENT_PLAN 第 5.2、5.4 节：档位写在 system 段开头，medium 和 none 不注入文字；没有 `configuration_update`；工具调用为 XML 格式；`developer` 角色模板不支持。
- 特殊 token：248046 `<|im_end|>` 和 248044 `<|endoftext|>` 为停止 token；`<think>`、`</think>`、`<tool_call>`、`</tool_call>` 都是单个 token；tokenizer 不加 BOS。

**B0-7 增量渲染契约，静态部分**（执行者：agent；`b0_render.py`）
- 8 个 item 边界中，7 个在字符串和 token 两个层面都满足前缀性质；唯一不满足的是两条连续工具结果之间。
- 「生成提示符 + 模型输出 + `<|im_end|>`」在字符串层面都能还原重新渲染的结果（只差结尾的 `\n`）。但推理为空时，整段重新 tokenize 会把两个 `\n` 合并成一个 token，所以必须按段 tokenize。
- `preserve_thinking=false` 会改变已有前缀；reasoning 和回答文本都会被 trim；非字符串的工具参数按 `", "` 分隔渲染。

## 合同修订：`tool_call_invalid`（2026-09-30，Mac Studio）

范围：按协议第 13 节的顺序修改了协议第 7.1、9.2 节，TS 错误码和 schema 导出，mock 测试，兼容文档，以及后端的错误码表、网关映射和假 worker。**已验证**：前端检查通过，共 91 个用例；后端 36 个测试通过（执行者：agent）。

## 合同修订：`configuration_update`（2026-09-29，Mac Studio）

范围：按协议第 13 节的顺序同步。依次修改了协议文档（第 3.3、5、6、6.1、7.1 节）、zod 类型和导出的 JSON Schema、共享的语义校验（mock server、stub driver、SDK 都用它）、mock 引擎的生效强度计算、一致性测试（新增 W23 和 W24，`requires` 支持多个能力），以及兼容文档（`configuration_update` 标为模拟）。

**已验证**（执行者：agent）
- `./scripts/check.sh frontend` 通过：类型检查、import 边界、Vitest 共 6 个文件、90 个用例（新增 9 个），以及 Shell 语法和 `git diff --check`。
- 新增用例覆盖：
  - 协议：位置规则；能力未声明时拒绝；强度不在 `supported_efforts` 内时拒绝；item 严格，不接受 `id` 和额外的键；生效强度的判定顺序。
  - mock 引擎：`configuration_update` 覆盖请求的基线，切到 `none` 时不产生 reasoning，切到 `high` 时恢复。
  - SDK：追加 `configuration_update` 后仍然走增量续接，并且命中前缀缓存；能力未声明时在本地拒绝，不发出请求。
- 在另一个进程中启动 mock server，运行一致性测试 CLI `tools/conformance.ts`：W01–W24 共 24 个用例全部通过。

**尚未验证**：兼容 driver（F2）还没有实现，`configuration_update` 的模拟方式只写在文档里；真实后端还没有实现这项能力。

## B0-1：后端环境（2026-09-29，Mac Studio）

执行者：agent，经用户授权联网安装。

| 项目 | 实际结果 |
|---|---|
| 硬件与系统 | Apple M3 Ultra，统一内存 103,079,215,104 字节（96 GiB），macOS 27.0（26A428） |
| GPU 可锁定内存上限 | `iogpu.wired_limit_mb=87040`，由用户设置，并写入 `/etc/sysctl.conf`；MLX 报告的 `max_recommended_working_set_size` 为 91,268,055,040 字节（85.0 GiB），说明上限已经生效。重启后是否仍然生效，尚未验证 |
| uv | 0.12.7，从 GitHub release 下载并校验 SHA256，安装在 `.tools/uv/uv` |
| Python | 3.12.12（uv 管理，只使用受管 Python），安装在 `.runtime/python/` |
| 依赖 | `backend/uv.lock` 共 60 个包，`uv sync --frozen --all-groups` 安装到 `backend/.venv`；mlx 0.32.3（mlx-metal 0.32.3），mlx-vlm 0.7.4（git `00093678`），transformers 5.17.0，huggingface-hub 1.33.0，hf-xet 1.6.0 |
| 冒烟测试 | `mx.metal.is_available()` 为 True；`mlx_vlm.models.qwen4_exp.ple_storage` 可以导入 |

**已验证**：`./scripts/check.sh backend` 由用户运行并通过（最小实现：ruff；有测试时运行 pytest；另外包括 Shell 语法和 `git diff --check`）。

**尚未验证**：还没有加载任何模型权重。

## 迁移到 Mac Studio 后的前端复验（2026-09-29，Mac Studio）

环境：Mac Studio M3 Ultra 96GB，macOS 27.0（arm64）；由用户执行 `./frontend.sh prepare`，装好项目内的 Node v24.21.0 和锁定的依赖。

**已验证**：`./scripts/check.sh frontend` 通过，包括 Shell 语法、类型检查、import 边界、Vitest（6 个文件、81 个用例）和 `git diff --check`。结论：F1 的确定性检查在 Studio 上结果与在 Air 上一致。

**尚未验证**：一致性测试 CLI 还没有在 Studio 上对另一个进程中的 mock server 运行过；真实后端仍未开始。

## F1：SDK、mock 与一致性测试（2026-09-29，MacBook Air）

环境：macOS 27.0（arm64），项目内 Node 24.21.0，TypeScript 7.0.2，Vitest 5.0.2，zod 4.6.5，ws 8.22.0。

**已验证**（`./scripts/check.sh frontend` 通过；另外把全部测试连续运行 8 轮，结果稳定）

| 范围 | 内容 |
| --- | --- |
| 协议 | 严格 JSON，能拒绝重复键和非法数值；JSON Schema 子集检查；流顺序校验，能拒绝序号跳变、item 交错、delta 与 done 不一致、缺少 usage、终止事件之后仍有事件、输出与 done 不一致；续接判定 |
| 合同同步 | 提交的 JSON Schema 与 zod 定义一致（漂移测试） |
| mock 引擎 | 推理（包括摘要）、commentary 消息、function 工具、custom 工具；并行工具调用的开关；`tool_choice:none`；推理强度 none；`max_output_tokens` 截断；中途失败；前缀缓存统计；预热 |
| wire 层一致性（mock server） | W01–W22 全部通过，覆盖健康检查、模型、认证、各类 400/404/415 错误、上下文超长、SSE 流、预热、token 计数、前缀缓存，以及 WebSocket 的认证、流、增量续接及其失败情况、`response_in_progress`、中断和非法消息 |
| 一致性测试 CLI | 对另一个进程中启动的 mock server 运行 `tools/conformance.ts`，22 个用例全部通过 |
| SDK native driver | 默认走 WebSocket；agent 循环的增量续接（服务端看到的是完整历史，同时命中前缀缓存）；属性变化时退回完整请求；预热后以空增量续接；中断后不从被中断的响应续接；中止后用新连接恢复；连接到期后透明重连；WebSocket 忙时并发请求改走 HTTP；显式 HTTP；升级失败或能力未声明时粘性回退到 HTTP 并记录诊断；两种传输下 `context_length_exceeded` 和 `queue_full` 在流开始前的重试；本地拒绝未声明的能力和未知参数；token 计数（精确或估算）；拒绝不合规的流（没有终止事件、未知事件、序号错误），以及非协议错误体的分类 |
| stub driver | 进程内实现完整的接口 C；支持中断；能力检查与真实后端一致 |
| 边界检查 | 故意加入违规 import 后，检查器能报出错误并以非零状态退出 |

**尚未验证**
- 真实后端：B0 到 B2 还没有开始，一致性测试还没有对真实后端运行过。
- OpenRouter 兼容 driver（F2）还没有实现，`compat-openrouter.md` 中标注「待实测」的条目都没有验证。
- 长时间运行、大负载和网络异常情况：mock 都在本机 loopback 上运行，没有覆盖真实网络的抖动和 Tailscale 链路。
