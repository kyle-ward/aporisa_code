# 验证记录

本文只记录已经实际运行过的检查，以及明确尚未验证的事项。预期不写成结果，替身测试也不代替真实验收。

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
