# OpenRouter 兼容映射 v0（草案）

> **状态：F0 草案，尚未实现。** 本文只描述前端兼容 driver 如何把 [Aporisa 协议](protocol.md)（接口集合 C）映射到 OpenRouter 的 Responses API。标注「待实测」的条目只依据 OpenRouter 的公开文档，要在 F5 阶段用真实请求确认，确认后再修改本文。
>
> 修订日期：2026-09-30（新增 `configuration_update` 的模拟方式；新增不合法工具参数的处理；`strict: true` 跟随 `structured_output`）。

## 1. 原则

- 兼容目标**只有 OpenRouter**，对接的是 `https://openrouter.ai/api/v1/responses`，不走 chat/completions，也不维护其他厂商的 profile。
- 兼容 driver 在前端实现 Aporisa SDK 接口，harness 感知不到它和原生 driver 的区别。唯一的区别是**能力声明**，harness 按能力降级。
- 对每个操作的处理，只能是以下三种之一，并且必须显式标出：
  - **映射**：语义等价。
  - **模拟**：在客户端近似实现，结果有损，并标记 `emulated`。
  - **不支持**：能力声明为 false，SDK 拒绝调用。
- OpenRouter 的 Responses API 本身是**无状态**的：它拒绝 `store: true` 和 `previous_response_id`，与本协议的语义一致。
- **禁止**使用 OpenRouter 在服务端提供的 harness 功能，包括 plugins（web search、上下文压缩等）和 transforms，以免污染上下文管理实验。
- 评估时固定 `model` 和上游 provider，并关闭 fallback。
- 数据会离开本机，只能使用测试内容。key 只保存在前端的 `.env` 或主进程里，不进入渲染进程。

## 2. 连接参数

兼容 driver 只需要三个参数：`base_url`（默认为 OpenRouter）、`api_key`、`model`（OpenRouter 的模型 slug）。另外可以配置 provider 固定策略，只在评估时使用。

## 3. 端点映射

| Aporisa | 处理 | OpenRouter 侧的实现 |
|---|---|---|
| `GET /v1/models` | **模拟** | 以 OpenRouter `/models` 返回的上下文长度、支持的参数等为基础，再合并前端的静态 profile，补齐 `effective_context_window_percent`、`auto_compact_token_limit`、`truncation_policy` 等 harness 需要的字段（待实测字段名） |
| `POST /v1/responses` | **映射** | `POST /api/v1/responses`，逐字段映射见第 4 节 |
| `POST /v1/responses/input_tokens`（X3） | **模拟** | 用「上一次的 usage + 每 4 字节 1 个 token」估算，结果标记为估算值 |
| `GET /health/*` | **模拟** | 用一次轻量的 `/models` 请求判断服务是否可达 |

## 4. 请求字段映射

| Aporisa 字段 | 处理 | 说明 |
|---|---|---|
| `model`、`input`、`instructions`、`max_output_tokens` | 映射 | 原样传递 |
| `tools`（function） | 映射 | 形状一致。`strict: true` 按协议第 8.3 节跟随 `structured_output` 的能力声明：该能力实测为 supported 之前，driver 拒绝 `strict: true` |
| `tools`（custom） | **模拟** | OpenRouter 文档里没有提到 custom 工具。driver 把它改写成只有一个 string 参数 `input` 的 function 工具，并把返回结果还原成 `custom_tool_call`。codex 也有同样的先例：`apply_patch` 同时有 function 和 freeform 两种形态。能力上声明 `custom_tools: emulated` |
| `tool_choice` | 映射 | 只使用 `auto` 和 `none` |
| `parallel_tool_calls` | 映射 | 待实测，看各模型实际是否遵守 |
| `reasoning.effort` | 映射 | OpenRouter 允许的取值是 `minimal`、`low`、`medium`、`high`。Aporisa 的 `none` 映射为不发送 `reasoning`（待实测） |
| `configuration_update`（input item） | **模拟** | OpenRouter 没有对应的机制。driver 按 [protocol.md](protocol.md) 第 6.1 节算出生效强度，把它作为请求级的 `reasoning.effort` 发送，并从发往上游的 `input` 中移除全部 `configuration_update`；harness 保存的历史不变。这和 codex 对不支持换档的模型的做法相同。代价是上游的前缀缓存可能失效，对结果语义没有影响。能力上声明 `reasoning_effort_updates: emulated` |
| `text.format` | 映射 | 待实测，看各模型实际支持情况。协议第 8.4 节的语义（回答要么是一个符合 schema 的 JSON，要么是工具调用；未完成时丢弃写到一半的受约束 item）在 OpenRouter 上是否成立，也要实测 |
| `prompt_cache_key` | 映射 | 按原样透传，是否生效取决于上游，待实测。`cached_tokens` 以返回的 usage 为准 |
| `generate:false`（X2） | **不支持** | `capabilities.prewarm = false` |
| `stream: true` | 映射 | |
| 传输方式 | 只用 HTTP | OpenRouter 只提供 HTTP + SSE，并拒绝 `previous_response_id`。兼容 driver 不做 WebSocket 和增量续接，`capabilities.websocket = false` |
| `client_metadata` | 丢弃 | 只在本地记录，不发给第三方 |
| （driver 自动附加） | — | `store:false`；`include:["reasoning.encrypted_content"]`，以便推理数据在工具调用之间回传；需要时附加 provider 固定参数；显式关闭 plugins |

## 5. Item 与事件映射

| Aporisa | 处理 | 说明 |
|---|---|---|
| `message`、`function_call`、`function_call_output` | 映射 | 形状一致 |
| `input_image`（user 消息与工具结果中） | 映射 | 形状一致，data URL 原样传递，`detail` 原样传递。driver 先按协议第 7.1 节做结构检查（格式与声明一致、文件完整），不通过时本地返回 `invalid_image`，不发往上游。`input_modalities` 取上游模型的声明；工具结果里的图片、`detail` 对分辨率的影响、图片 token 是否计入 usage，都待实测 |
| `message.phase` | **模拟或丢弃** | 上游可能不提供。driver 在输出里不带 `phase`；回传时去掉这个字段（待实测上游是否接受） |
| `reasoning` | 映射，有损 | 上游给的是 `summary` 加上**不透明**的 `encrypted_content`，通常没有明文 `content`。回传时必须原样保留，不能修改 |
| `response.reasoning_text.delta` | 映射 | OpenRouter 文档中的事件名是 `response.reasoning.delta`，driver 负责改名（待实测实际的事件名） |
| 其余 `response.*` 事件 | 映射 | 按 [protocol.md](protocol.md) 第 7.3 节的顺序规则做校验；上游违反规则时，按协议错误处理 |
| 上游产生的未知 item 或事件 | 不支持 | 按协议错误处理，不能静默丢弃 |
| 上游 `function_call` 的 `arguments` 不是合法的 JSON 对象 | 映射 | 以 `response.failed`（`tool_call_invalid`）结束，保证交给 harness 的 `arguments` 总是合法的 JSON 对象（[protocol.md](protocol.md) 第 7.1 节）。上游是否会出现这种情况待实测 |
| `usage` | 映射 | 字段缺失时按协议错误处理，不能填 0 |

## 6. 错误映射

- 上游 HTTP 错误要归入 [protocol.md](protocol.md) 第 9 节的分类：
  - 上下文超长 → `context_length_exceeded`（待实测上游的错误码）；
  - 429 → `queue_full`，保留 `Retry-After`；
  - 认证失败 → `invalid_api_key`。
- 流中途出错，一律以 `response.failed` 结束。
- 重试规则与协议相同：只在流开始之前重试。

## 7. 汇总：兼容 driver 的能力声明

| 能力 | 取值 |
|---|---|
| `parallel_tool_calls` | 待实测 |
| `custom_tools` | emulated |
| `structured_output` | 待实测 |
| `prompt_cache` | 透传，结果以 usage 为准 |
| `prewarm` | false |
| `websocket` | false |
| `input_tokens` | emulated |
| `reasoning_effort_updates` | emulated |
| 明文推理内容 | 通常没有，只有 summary 和加密内容 |
