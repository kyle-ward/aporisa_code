# Aporisa Code

Aporisa Code 是一个安装在本机、直接运行的 agent app，只支持 macOS / Apple Silicon。它由三部分组成：

| 部分 | 目录 | 说明 |
| --- | --- | --- |
| 协议合同 | `docs/protocol.md` | harness 与推理后端之间的唯一合同，以 Responses API 的条目模型为蓝本 |
| 前端 | `aporisa_code/` | harness core 加 Electron app，100% TypeScript |
| 后端 | `backend/` | 通用的本地推理服务，与调用方无关、语义无状态 |

开发期间，前端可以通过兼容层接入 OpenRouter 进行测试，映射差异见 [OpenRouter 兼容映射](docs/compat-openrouter.md)。

**当前状态：前端已完成 F1，后端已完成 B0、正在实现 B1。**

- 协议合同 v0 已定稿（含 `configuration_update` 修订）。
- 前端：SDK（native driver，WebSocket 默认、HTTP 兜底）、mock server、stub driver 和 wire 层一致性测试都已实现，并通过了确定性检查。harness、UI 和 OpenRouter 兼容层尚未开始。
- 后端：B0 已完成，模型、量化格式和各项实测见 [开发计划](backend/DEVELOPMENT_PLAN.md) 与 [验证记录](docs/validation.md)。B1 中，网关已经能配合假 worker 通过 W01–W24；真实 worker（P2）已实现并通过小模型测试，真实模型上的验收和生命周期脚本（P3）尚未完成，还不能作为服务运行。

```bash
./frontend.sh prepare         # 安装项目内的 Node 和锁定的依赖（唯一联网的模式）
./scripts/check.sh frontend   # 前端确定性检查
```

开发流程见 [开发文档](docs/development.md)。

协作约定和工程规范见 [AGENTS.md](AGENTS.md)。
