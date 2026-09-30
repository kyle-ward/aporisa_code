# Aporisa Code

Aporisa Code 是一个安装在本机、直接运行的 agent app，只支持 macOS / Apple Silicon。它由三部分组成：

| 部分 | 目录 | 说明 |
| --- | --- | --- |
| 协议合同 | `docs/protocol.md` | harness 与推理后端之间的唯一合同，以 Responses API 的条目模型为蓝本 |
| 前端 | `aporisa_code/` | harness core 加 Electron app，100% TypeScript |
| 后端 | `backend/` | 通用的本地推理服务，与调用方无关、语义无状态 |

开发期间，前端可以通过兼容层接入 OpenRouter 进行测试，映射差异见 [OpenRouter 兼容映射](docs/compat-openrouter.md)。

**当前状态：前端已完成 F1，后端已完成 B0 和 B1。**

- 协议合同 v0 已定稿（含 `configuration_update` 修订）。
- 前端：SDK（native driver，WebSocket 默认、HTTP 兜底）、mock server、stub driver 和 wire 层一致性测试都已实现，并通过了确定性检查。harness、UI 和 OpenRouter 兼容层尚未开始。
- 后端：B1 已完成：作为 macOS 系统服务运行，对服务运行一致性测试 W01–W24 全部通过，真实生成验证（含 132K 上下文）通过。架构见 [架构](docs/architecture.md)，实测见 [验证记录](docs/validation.md)。集成节点 I1（前端从 Air 连接 Studio 上的后端）尚未进行。B2 进行中：MTP 投机解码与提示词查找投机已验收（改代码类任务在 125K 上下文下约为普通解码的 5 倍）。

```bash
./frontend.sh prepare         # 安装项目内的 Node 和锁定的依赖（唯一联网的模式）
./scripts/check.sh frontend   # 前端确定性检查

./backend_service.sh help     # 后端服务：doctor / prepare / install / start / stop / restart / status / uninstall
./model_weights.sh list       # 本地权重（download / convert / list / delete）
```

后端服务的运维见 [macOS 服务](docs/macos.md)，模型配置和权重见 [模型与权重维护](docs/model-management.md)。

开发流程见 [开发文档](docs/development.md)。

协作约定和工程规范见 [AGENTS.md](AGENTS.md)。
