# AGENTS.md

本文件规定协作方式、实现边界和工程偏好。接口、设计和已验证的事实，以 `README.md`、`docs/` 和代码为准。本文与 `docs/` 冲突时，先停下来问用户，不要自行选择其中一方。

## 项目定位

- Aporisa Code 是一个**安装在本机、直接运行的 agent app**，定位对标 codex 桌面端和 Claude Code，**不是聊天助手**。
- 只支持 macOS / Apple Silicon，不考虑其他平台。
- 仓库分为三块：
  - **协议合同**：`docs/protocol.md` 加上机器可读的 schema，是前后端共同的唯一依据，不属于任何一方。
  - **前端**：`aporisa_code/`，包含 harness core 和 Electron app，100% TypeScript，两台机器上都可以开发。
  - **后端**：`backend/`，是通用的本地推理服务，以 `local_llm` 为起点，只在 Mac Studio 上开发和运行（Air 无法调试后端）。
- **harness core 是项目的核心价值。** 后端只提供通用、无状态的推理能力，不包含任何 harness 逻辑。
- 两台机器的分工：
  - **Mac Studio**：以后端为主、前端为辅。发现必要的前端同步（例如合同变更），可以直接修改前端；必要时也可以顺带推进前端的阶段任务。
  - **MacBook Air**：只开发前端，因为它无法调试后端。
  - 两台机器**严格不同时开发**。换机器之前先把代码同步好，避免两边各改一份。

## 设计参考原则

- **优先参考 openai/codex 的设计思想和协议细节**。ZCode、opencode 只在 codex 没有对应做法时作为补充。
- 在向 codex 靠拢的同时，保持本文件规定的工程风格。如果刻意偏离 codex 的做法，要在相关文档里写明原因。
- 协议中和 OpenAI 重合的部分，以 Responses API 的条目（item）模型为蓝本，不使用 Chat Completions 的形状。
- 参考仓库只读，不能为了适配本项目去改动它们。两台机器上的路径不同，指的是同一批仓库：

| 仓库 | MacBook Air | Mac Studio |
|---|---|---|
| local_llm | `/Users/Zhuanz1/Personal/SmartCare/dgx_spark/local_llm` | `/Users/aporisa/Personal/SmartCare/dgx_spark/local_llm` |
| local_asr | `/Users/Zhuanz1/Personal/SmartCare/dgx_spark/local_asr` | `/Users/aporisa/Personal/SmartCare/dgx_spark/local_asr` |
| 其他 | 任何外部克隆的仓库 | 同左 |

## 当前阶段

- 前端：F0（合同 v0）和 F1（SDK、mock、一致性测试）已经完成，下一阶段是 F2（OpenRouter 兼容 driver）。
- 后端：B0（探路与实测）和 B1（协议核心）已经完成；集成节点 I1（Air 上的 native driver 经 Studio 的 Cloudflare Tunnel 连接后端，重跑 F1 测试）待在 Air 上进行。B2（性能与本地专属能力）进行中：P1（MTP 投机解码）、P2（提示词查找投机）和 P3（结构化输出）已完成，下一步是 P4（SSD 溢出与重启恢复）。架构见 `docs/architecture.md`，开发计划见 `backend/DEVELOPMENT_PLAN.md`。
- 已验证的范围见 `docs/validation.md`。
- 新能力在实现并验收之前，一律不得声称已经实现。文档中「目标规范」和「当前实现状态」必须分开写。

## 开始工作前

- 先执行 `git status --short`，辨认并保护用户已有的改动，不要覆盖、回退或顺手整理无关文件。
- 先阅读和任务直接相关的 `README.md`、`docs/`、入口脚本和测试，再动手修改。
- 未经用户明确要求，不执行以下操作：
  - git 的 commit、push、切换分支、rebase 或改写历史；
  - 任何远程主机上的安装、启停或部署。
- 删除或迁移材料前，先确认信息已有明确去处。破坏性的 Git 或文件操作需要用户授权。
- 课程材料（proposal、内部计划、调研笔记、截图等）**严格不进入本仓库**。

## 架构不变量

### 协议合同

- `docs/protocol.md` 是协议的唯一文字源头。机器可读合同的单一源头是前端的 TS 类型，由它导出 JSON Schema 并提交进仓库，再由漂移测试保证两者一致。
- 合同变更顺序固定为：
  1. 协议文档
  2. 类型和 schema
  3. mock server
  4. 一致性测试
  5. SDK 和兼容 driver
  6. 后端

  不能跳步，也不能让两边各自维护一份支持范围。
- 语义上**无状态**：每次请求发送完整输入，没有服务端会话存储。会话级的增量续接和预热（对应 KV cache 复用）只是可选的、尽力而为的传输优化，丢失时不能影响正确性。
- 协议只定义流式输出。delta 只用于展示，**写入历史的以 item 完成事件为准**。
- 参数必须真正实现，或者明确拒绝，不能接受后静默忽略。能力差异通过显式的能力声明表达，不靠私有握手或猜测。

### 前端（`aporisa_code/`）

- 依赖方向是 `ui → (IPC) → main → harness → sdk → protocol`，由 `check.sh` 中的 import 规则强制检查：
  - `harness` 只能通过 `host` 接口接触文件系统、进程和沙箱。
  - `ui` 不能直接导入 `harness`、`host` 或 Node API。
- harness core 不依赖任何 UI，必须能在 Node 下无界面运行，供 CLI、测试和评估使用。
- SDK 的 driver 只有三种：
  - **native**：对接自研后端；
  - **openrouter**：唯一的第三方兼容目标，对接 `/responses`；
  - **stub**：完整实现合同，供测试使用。

  不做多厂商 profile。
- 兼容 driver 对每个操作的处理，必须显式标注为「映射」「模拟」或「不支持」三者之一。OpenRouter 的服务端 plugins、transforms 必须关闭；评估时要固定 model 和 provider。
- API key 只由主进程或 Node 进程持有，**绝不打包进渲染进程的 bundle**。

### 后端（`backend/`）

- 后端是通用的推理黑盒，与调用方无关，对外只暴露公开模型别名。真实型号、路径、量化方式和引擎参数只在内部记录。
- 所有资源都有上限：HTTP 正文、FIFO 准入队列、推理槽位、输出字节、SSE 事件，以及各类超时。
- 取消、断连、超时必须一路传到引擎，并释放准入名额。
- 停机顺序固定：关闭准入 → 唤醒排队中的请求 → 限时 drain → 取消剩余请求 → 结束自有引擎进程组。
- 恢复次数必须有上限。不自动重放失败的用户请求，也不把部分结果伪装成成功。
- 公共路由不透传引擎的模型管理接口、文件路径、原始错误或私有端口。

### 模型配置与权重（后端）

参照 local_llm 的做法：**模型配置、本地权重、服务生命周期三者解耦**，换模型时只改配置指针，不改网关、协议或生命周期脚本。

- `backend/src/aporisa_backend/configs/` 中维护三样东西，随代码评审：
  - `MODEL_LIST`：可读的模型身份字符串，可以包含尚未下载、尚未配置推理参数的名字；没被引用的项不校验、不加载。
  - `POINTERS`：公开模型别名 → 模型身份。公开别名只在这里维护，不放进 `.env`，也没有别名转换表。
  - `PROFILES`：以身份为 key 的推理参数（架构、量化策略、内存预算、模型适配层的选择等），不包含目录、仓库或 revision。
- 本地权重的**唯一记录**是 `.runtime/model-assets/<目录>.json`：身份、目录、来源仓库、固定的 revision、状态和完整的 SHA256 清单。不进入 Git，configs 中不重复保存资产映射。
- 自行转换得到的产物（例如从官方 FP8 checkpoint 量化、外置 PLE）登记为**独立的身份**，记录中写明源身份、转换配方和转换工具的版本，能追溯到来源。
- 注册、下载、映射、加载相互独立：下载不修改 configs；注册不代表已下载；磁盘上未注册的权重不会加载。启动只校验指针实际引用的身份：在 `MODEL_LIST` 中、有合法的 profile、有唯一且完整的本地记录、SHA256 全部通过。缺任何一项直接失败，不回退、不自动下载。
- 切换模型的流程：下载或转换新权重 → 修改 `POINTERS`（必要时补 `PROFILES`）→ `stop` → `prepare` → `start` → 真实验证。不需要重新下载已有权重，也不需要改 `.env`。
- 后端从加载到退出持有所用模型目录的共享锁；下载、转换、删除要取得该目录的独占锁，模型正在使用时直接拒绝。
- 故障时不切换到另一个模型。

## 生命周期

- 每一侧只有一个公开入口：
  - 后端：`backend_service.sh`，模式为 `doctor / prepare / install / start / stop / restart / status / uninstall / help`，在 Mac 上由系统 LaunchDaemon 管理。
  - 前端：`frontend.sh`，模式为 `doctor / prepare / dev / build / install / uninstall / help`。app 不是后台服务，所以没有 start 和 stop。
- 模型权重有一个**独立的维护入口** `model_weights.sh`，模式为 `download / convert / list / delete`。它不属于服务生命周期，不启停服务、不占用推理准入：
  - `download`：必须给出精确的仓库 ID 和显式的 `--identity`，可以用 `--revision` 固定到某个 commit；不指定时先解析远端版本，再固定到不可变的 commit。支持断点续传，每个文件都校验完才发布。已绑定的身份不能悄悄换源或换版本。
  - `convert`：从已登记的源身份按固定配方派生产物，产物登记为新的身份。
  - `list`：只读，扫描目录和元数据，不联网、不计算大文件哈希。
  - `delete`：参数必须是精确的目录名，同时删除权重、暂存和身份记录，不改 configs。
- **服务生命周期中，`prepare` 是唯一允许联网的模式**：它安装依赖，并完整核验指针引用的权重，**从不下载、转换或修复权重**。新机器上可以先 prepare 装好依赖，因为缺权重而非零退出；用 `model_weights.sh` 补齐权重后，再次 prepare。
- `start`、`build`、内部 `run` 都离线执行，缺少产物时直接失败，不做隐式修复。
- 后端的 install 只注册一个空闲服务，start 开启自启并等待就绪，stop 关闭自启并等待进程树退出，uninstall 只移除已停止或空闲的服务，并保留模型、缓存和日志。
- doctor、prepare 和 start 共用同一套检查实现，失败时返回非零。
- 脚本由项目目录所有者执行，**不要对整个脚本使用 sudo**，需要特权的步骤在脚本内部局部提权。
- 只追踪自己创建的进程树，不按进程名批量结束进程。
- 系统服务的真实 install、start、stop、restart、uninstall 由用户手动执行和验收。
- `model_weights.sh` 的 download、convert、delete 由用户执行；`list` 是只读的，agent 可以运行。

## 配置、隐私和日志

- 两侧各有自己的 `.env` 和 `.env.example`，根目录不放 `.env`：
  - `backend/.env`：端口、API key 等部署差异。公开模型别名不在这里，见「模型配置与权重」。
  - `aporisa_code/.env`：开发期 OpenRouter key 等，只给 CLI 和测试读取。
- `.env` 只放部署差异。稳定、非敏感的策略按主题拆分到各自的 `configs/` 模块，随代码一起评审。
- 新增环境变量前，先证明它确实是部署差异而不是工程调参，并同步更新 `.env.example`、脚本、测试和文档。
- 文件日志使用 JSONL，字段走固定的白名单。不记录提示词、生成正文、思考内容、工具输出、文件内容、密钥、请求头或原始 URL。
- 控制台输出使用分类标签，不输出 JSON：`[Aporisa Code] [READY] / [INFO] / [WAIT] / [REPAIRABLE] / [SYSTEM] / [MANUAL]` 以及 `ERROR:`。
- 开发期经 OpenRouter 发出的内容会离开本机，只使用测试内容。

## 工具链

- 后端：Python 3.12，使用项目内的 uv，虚拟环境在 `backend/.venv`，依赖由 `backend/uv.lock` 锁定。
- 前端：项目内自带 Node 24 和 npm，依赖由 `aporisa_code/package-lock.json` 锁定。app 使用 Electron。
- 依赖版本固定，不依赖全局安装的工具。修改依赖后需要重新执行 `prepare`。

## 验证

- `scripts/check.sh` 是确定性 CI 的唯一入口。它不联网、不加载模型、不启动真实服务。三种用法：
  - `./scripts/check.sh`：不带参数，运行前后端全部 CI。
  - `./scripts/check.sh frontend`：只运行前端 CI。
  - `./scripts/check.sh backend`：只运行后端 CI。
- **agent 只允许运行 `./scripts/check.sh frontend`。** 后端 CI 和全量 CI 由用户自己运行。需要这两项验证时，agent 说明检查范围、原因和命令，等用户回报结果，不得把未运行的检查写成通过。
- 以下检查不进入 `check.sh`，由用户显式执行，结果单独记录：
  - 联网检查，例如 OpenRouter 冒烟测试；
  - 真实推理验证；
  - 长时间 soak 测试；
  - 评估。
- 后端的验收标准是通过与 mock server 相同的 wire 层一致性测试。
- 交付时要明确区分「已验证的事实」和「未运行、待确认的内容」，不能把预期写成结果，也不能用替身测试代替真实验收。

## 语言与文档归属

- 文档用中文。代码标识符、代码注释和提交信息用英文。
- 根目录只放 `README.md` 和本文件，详细文档全部放进 `docs/`：

| 文件 | 内容 |
|---|---|
| `docs/protocol.md` | Aporisa 协议，唯一的合同源头 |
| `docs/compat-openrouter.md` | 合同到 OpenRouter 的映射，兼容差异只在这里定义 |
| `docs/architecture.md` | 职责、进程、不变量、内部接口 |
| `docs/development.md` | 生命周期、配置、测试和排障 |
| `docs/validation.md` | 已验证的事实、未验证的项目 |
| `docs/macos.md` | 后端系统服务的运维 |
| `docs/model-management.md` | 模型配置指针、权重的下载、转换和维护 |
| `docs/models-and-licenses.md` | 模型、上游来源和许可证 |

- 公共字段和事件语义只在 `docs/protocol.md` 定义，其他文档只链接引用，不再维护第二份。
