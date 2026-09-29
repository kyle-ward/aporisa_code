# Aporisa Code

Aporisa Code 是一个安装在本机、直接运行的 agent app，只支持 macOS / Apple Silicon。它由三部分组成：

| 部分 | 目录 | 说明 |
| --- | --- | --- |
| 协议合同 | `docs/protocol.md` | harness 与推理后端之间的唯一合同，以 Responses API 的条目模型为蓝本 |
| 前端 | `aporisa_code/` | harness core 加 Electron app，100% TypeScript |
| 后端 | `backend/` | 通用的本地推理服务，与调用方无关、语义无状态 |

开发期间，前端可以通过兼容层接入 OpenRouter 进行测试，映射差异见 [OpenRouter 兼容映射](docs/compat-openrouter.md)。

**当前状态：已完成 F1。** 协议合同 v0 已定稿；前端的 SDK（native driver，WebSocket 默认、HTTP 兜底）、mock server、stub driver 和 wire 层一致性测试都已实现，并通过了确定性检查。harness、UI、OpenRouter 兼容层和后端尚未开始。验证范围见 [验证记录](docs/validation.md)。

```bash
./frontend.sh prepare         # 安装项目内的 Node 和锁定的依赖（唯一联网的模式）
./scripts/check.sh frontend   # 前端确定性检查
```

开发流程见 [开发文档](docs/development.md)。

协作约定和工程规范见 [AGENTS.md](AGENTS.md)。
