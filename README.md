# Aporisa Code

Aporisa Code 是一个安装在本机、直接运行的 agent app，只支持 macOS / Apple Silicon。它由三部分组成：

| 部分 | 目录 | 说明 |
| --- | --- | --- |
| 协议合同 | `docs/protocol.md` | harness 与推理后端之间的唯一合同，以 Responses API 的条目模型为蓝本 |
| 前端 | `aporisa_code/` | harness core 加 Electron app，100% TypeScript |
| 后端 | `backend/` | 通用的本地推理服务，与调用方无关、语义无状态 |

开发期间，前端可以通过兼容层接入 OpenRouter 进行测试，映射差异见 [OpenRouter 兼容映射](docs/compat-openrouter.md)。

**当前状态：F0 合同 v0 草案阶段，尚未实现任何功能。** 生命周期入口（`backend_service.sh`、`frontend.sh`）和检查入口（`scripts/check.sh`）会随实现逐步加入，本文件届时同步更新。

协作约定和工程规范见 [AGENTS.md](AGENTS.md)。
