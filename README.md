# Aporisa Code

Aporisa Code 是一个安装在本机、直接运行的 agent app，只支持 macOS / Apple Silicon。它由三部分组成：

| 部分 | 目录 | 说明 |
| --- | --- | --- |
| 协议合同 | `docs/protocol.md` | harness 与推理后端之间的唯一合同，以 Responses API 的条目模型为蓝本 |
| 前端 | `aporisa_code/` | harness core 加 Electron app，100% TypeScript |
| 后端 | `backend/` | 通用的本地推理服务，与调用方无关、语义无状态 |

前端也可以通过兼容层接入 OpenRouter（F5，用于对照实验），映射差异见 [OpenRouter 兼容映射](docs/compat-openrouter.md)。

**当前状态：前端已完成 F2（无界面 agent loop 与命令行）和 F3（执行安全：macOS 沙箱与审批），真实任务验收 11/11 通过；后端 v0 已完成。**

- 协议合同 v0 已定稿（含 `configuration_update` 修订）。
- 前端：SDK（native driver，WebSocket 默认、HTTP 兜底）、mock server、stub driver 和 wire 层一致性测试都已实现，并通过了确定性检查。harness core 与命令行已实现，并在真实后端上通过了 8 个任务的验收（见 [开发说明](docs/development.md) 的「命令行」和 [验证记录](docs/validation.md)）；F3 的沙箱与审批通过了确定性测试（含真实 Seatbelt 下的逃逸测试）和真实任务验收；UI 和 OpenRouter 兼容层尚未实现。开发顺序与计划见 [前端开发计划](aporisa_code/DEVELOPMENT_PLAN.md)。
- 后端：v0 已完成：作为 macOS 系统服务运行，对服务运行一致性测试 W01–W30 全部通过，真实生成验证（含 200K 上下文）通过。架构见 [架构](docs/architecture.md)，实测见 [验证记录](docs/validation.md)。集成节点 I1（前端从 Air 连接 Studio 上的后端）尚未进行。B2 中，MTP 投机解码、提示词查找投机（改代码类任务在 125K 上下文下约为普通解码的 5 倍）、结构化输出、SSD 会话缓存（服务重启后 197K 上下文的会话约 2 秒内给出首 token，冷启动约 320 秒）、图片输入（PNG、JPEG，user 消息和工具结果中均可）与调优（agent 每轮首 token 中位数 −27%，200K 上下文不写 swap）已验收。

```bash
./frontend.sh prepare         # 安装项目内的 Node 和锁定的依赖（唯一联网的模式）
./scripts/check.sh frontend   # 前端确定性检查

./backend_service.sh help     # 后端服务：doctor / prepare / install / start / stop / restart / status / uninstall
./model_weights.sh list       # 本地权重（download / convert / list / delete）
```

后端服务的运维见 [macOS 服务](docs/macos.md)，模型配置和权重见 [模型与权重维护](docs/model-management.md)。

开发流程见 [开发文档](docs/development.md)。

协作约定和工程规范见 [AGENTS.md](AGENTS.md)。
