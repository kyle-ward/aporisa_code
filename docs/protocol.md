# Aporisa 协议 v0

> **状态：v0 已定稿。** 前端的 SDK（native driver）和 mock server 已按本文实现，并通过了 wire 层一致性测试（见 [validation.md](validation.md)）。后端尚未实现。本文是 harness（Aporisa SDK）和推理后端之间的唯一合同。任何代码、schema 或 mock 与本文不一致时，以本文为准，并按第 13 节的流程同步。
>
> 修订日期：2026-09-30（v0 修订：2026-09-29 新增 `configuration_update` 输入 item 和 `reasoning_effort_updates` 能力，见第 6.1 节；2026-09-30 明确 `function_call` 的保证范围，新增流中错误码 `tool_call_invalid`，见第 7.1、9.2 节；同日明确 function 工具的 `strict: true` 需要 `structured_output` 能力，见第 5、8.3 节）。协议路径版本：`/v1`。

## 1. 范围与原则

本协议对应接口集合 C，也就是「薄后端、厚客户端」的 agent harness 真正需要的推理接口。

1. **以 OpenAI Responses API 的条目（item）模型为蓝本**，参照 openai/codex 的实际用法。字段名和事件名尽量与之保持一致，以降低兼容层的成本。**不使用** Chat Completions 的 `messages` 形状。
2. **语义上无状态。**
   - 每个请求在语义上都等价于携带完整输入的独立请求。服务端不做持久的会话存储，协议里没有 `store`。
   - WebSocket 上的增量续接（`previous_response_id`，第 3.3 节）只是**连接级的传输优化**：它在语义上等价于一次完整请求，状态丢失时客户端要退回完整请求。它不是会话存储。
   - 服务端可以做透明的加速（第 10 节），但正确性不能依赖它。
3. **只定义流式输出**。请求中 `stream` 必须为 `true`。需要非流式结果时，由 SDK 聚合。
4. **delta 只用于展示。** 写入历史的内容，以 `response.output_item.done` 给出的完整 item 为准。
5. **严格校验。**
   - 所有请求对象（包括嵌套对象）拒绝未列出的键。
   - 参数要么实现，要么明确拒绝，不能静默忽略。
6. **能力显式声明**：可选能力通过 `/v1/models` 的 `capabilities` 字段声明（第 5 节）。客户端不发送未声明的能力，服务端拒绝未声明的能力。
7. **以下内容明确不纳入**（这些属于 harness 自己的职责，或是 OpenAI 专属功能）：
   - 服务端会话存储：`store`、跨连接的 `previous_response_id`、conversations
   - 托管工具：web_search、file_search、code_interpreter、image_generation
   - 服务端上下文压缩：`compaction` item
   - 加密推理的生成：`include: ["reasoning.encrypted_content"]`
   - `service_tier`、后台任务、Files、Vector Stores

与第三方（OpenRouter）的兼容差异，只在 [compat-openrouter.md](compat-openrouter.md) 中定义。

## 2. 术语

| 术语 | 含义 |
|---|---|
| **Item** | 输入和输出的原子单元：消息、推理、工具调用、工具结果 |
| **Response** | 一次 `POST /v1/responses` 产生的结果，包含若干输出 item |
| **Turn / Thread** | harness 层的概念，一个 turn 可能包含多次 Response。本协议不感知它们 |
| **call_id** | 关联一次工具调用和它的结果的标识，由服务端生成，客户端原样回传 |
| **公开模型别名** | `model` 字段的值，是部署方配置的中性名称，不暴露真实型号 |

## 3. 传输与通用约定

生成请求有两种传输方式，**事件模型完全相同**（第 7.3 节），区别只在分帧方式：

| 传输 | 原生后端 | OpenRouter（兼容 driver） |
|---|---|---|
| HTTP + SSE（第 3.2 节） | **必须实现**，是正确性的基线 | 唯一的方式 |
| WebSocket（第 3.3 节） | **必须实现**，并且**默认使用** | 不适用 |

原生 driver 的传输选择，照搬 codex 的主次关系：
- 默认使用 WebSocket。
- 可以通过配置显式指定为 `http`。
- 使用 WebSocket 时，只要出现以下任一情况，**本会话后续就一直退回 HTTP**，不再尝试 WebSocket：
  - 连接或升级失败；
  - 模型的 `capabilities.websocket` 为 false；
  - 发生 WebSocket 层面的协议错误。
- 发生回退时，需要记录一条诊断事件。

### 3.1 通用约定

- `base_url` 为 `<origin>/v1`。
- **认证**：`Authorization: Bearer <api_key>`；WebSocket 在升级请求中携带这个头。不需要私有请求头，也没有握手。
- **请求体**（HTTP 正文，或 WebSocket 客户端消息）：
  - 必须是 UTF-8 编码的 JSON，不接受压缩的请求体。
  - 以下情况一律拒绝：JSON 中有重复的键、出现 NaN 或 Infinity、类型需要强转、用布尔值充当整数。
  - 字段允许省略，不等于允许显式写成 `null`。只有明确标注「可为 null」的字段才接受 `null`。

### 3.2 HTTP + SSE

- `POST /v1/responses`，请求体为 `application/json`。
- **流式响应**：`Content-Type: text/event-stream`。每个事件的格式如下：

  ```
  event: <type>
  data: <JSON，其中 type 字段与 event 一致>

  ```

  - 事件 JSON 都带有 `sequence_number` 字段，从 0 开始严格递增。
  - 服务端可以每 15 秒发送一条注释行 `: keepalive` 保活。保活不代表模型有进展。
  - 流**没有** `[DONE]` 哨兵，以终止事件（第 7.3 节）结束。
- **诊断头**：
  - 服务端应返回 `x-request-id`，客户端可以记录，但不能依赖它。
  - 服务端返回 `Cache-Control: no-store`。
- **取消**：客户端断开连接即表示取消。服务端必须终止生成并释放准入名额。HTTP 上不提供取消端点。

### 3.3 WebSocket（原生后端）

参照 codex 的 Responses WebSocket 实现（`codex-api/src/endpoint/responses_websocket.rs`、`core/src/client.rs`）。

**连接**
- 通过 `GET /v1/responses` 升级为 WebSocket，由 `capabilities.websocket` 声明是否支持。升级前的认证失败，按 HTTP 错误返回（第 9.1 节）。
- 每条消息都是一个 UTF-8 JSON 文本帧，带 `type` 字段。保活使用 WebSocket 的 ping/pong。
- **同一连接上同时最多只有一个进行中的 response。** response 进行中又收到 `response.create` 时，返回 `error`，错误码为 `response_in_progress`。
- 服务端可以限制连接的最长寿命。到期时，在两次 response 之间以 `error` 消息（`connection_limit_reached`）通知客户端，然后关闭连接，客户端应当重新建立连接。
- 连接断开等同于取消所有进行中的生成，并丢弃该连接上的续接状态。

**客户端消息**

| type | 字段 | 说明 |
|---|---|---|
| `response.create` | 第 6 节的全部请求字段，**不含 `stream`**；另有可选的 `previous_response_id` | 发起一次生成 |
| `response.interrupt` | `response_id` | 中断进行中的 response |

**服务端消息**
- 第 7.3 节的全部事件，逐个作为文本帧发送，每个 response 的 `sequence_number` 各自从 0 开始。
- 另有一种 `error` 消息，用于在 HTTP 上本应返回 HTTP 错误的情况，即在 `response.created` 之前就失败的情况：

  ```json
  {"type":"error","status":400,
   "error":{"type":"invalid_request_error","code":"context_length_exceeded","message":"...","param":"input"}}
  ```

  `status` 是对应的 HTTP 状态码。`error` 的形状与第 9.1 节一致。

**增量续接**（对应 codex 的 `previous_response_id` 加增量 items）
- 服务端只为**本连接上最近一次以 `completed` 结束的 response** 保留续接状态。
- 客户端可以在下一次 `response.create` 中带上 `previous_response_id`，同时 `input` **只放新增的 items**。前提是：本次请求中除 `input`、`client_metadata`、`generate` 以外的所有字段，都与上一次请求**完全相同**。
- 语义上，这等价于一次完整请求，其 `input` 为：上一次请求的完整 `input`，加上上一次的 `output`，再加上本次的 `input`。
- 中途换档不修改 `reasoning` 字段，而是在 `input` 中追加 `configuration_update`（第 6.1 节），所以换档不会打断续接。
- 带有 `previous_response_id` 时，`input` 可以为空（典型用法是预热之后立即正式生成）。
- 服务端无法满足续接时，返回 `error`，错误码为 `previous_response_not_found`，并且不开始生成。可能的原因包括：状态已经丢失、id 不是最近一次 response、字段不一致。客户端收到后，**在同一连接上改发不带 `previous_response_id` 的完整请求**。这不计入第 9.3 节的重试次数。
- 客户端是否能续接，由它自己比对本次请求和上一次请求来判断，参照 codex 的 `get_incremental_items`。判断不出来时，一律发送完整请求。
- 续接状态在服务端的实现就是这次 response 对应的 KV cache 和 token 序列，所以能做到精确续接，不需要重新渲染历史。

**中断**
- 收到 `response.interrupt` 后，服务端停止生成，并以 `response.incomplete` 结束，`incomplete_details.reason` 为 `interrupted`。
- 已经发出 `output_item.done` 的 item 会保留在 `output` 中，进行到一半的 item 被丢弃。这对应 codex 的 `discard_partial_items`。
- 被中断的 response 不能作为续接的起点。
- 客户端发出中断后，要继续读到终止事件为止。

## 4. 端点一览

| 方法和路径 | 认证 | 类别 | 用途 |
|---|---|---|---|
| `GET /v1/models` | Bearer | 核心 | 模型列表，包含丰富的元数据和能力声明 |
| `GET /v1/models/{model}` | Bearer | 核心 | 单个模型的元数据 |
| `POST /v1/responses` | Bearer | 核心 | 生成，HTTP + SSE，只支持流式 |
| `GET /v1/responses`（升级为 WebSocket） | Bearer | 核心（仅原生后端） | 生成，WebSocket 传输，见第 3.3 节，由 `capabilities.websocket` 声明 |
| `POST /v1/responses/input_tokens` | Bearer | 扩展 X3 | 统计输入 token 数，由 `capabilities.input_tokens` 声明 |
| `GET /health/live` | 无 | 运维 | 进程存活：`200 {"status":"alive"}` |
| `GET /health/ready` | 无 | 运维 | 是否就绪：`200 {"status":"ready"}`，未就绪时 `503 {"status":"not_ready"}` |

未知端点返回 404（第 9 节的错误格式）。

## 5. 模型元数据：`GET /v1/models`

返回 `{"object":"list","data":[Model, ...]}`。本地后端恰好返回一项。

`Model` 对象：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 公开模型别名 |
| `object` | `"model"` | |
| `created` | integer | Unix 秒 |
| `owned_by` | string | 本地后端固定为 `"local"` |
| `context_window` | integer | 总上下文 token 数，包括输入和预留的输出 |
| `max_output_tokens` | integer | 单次输出上限，包括推理 token |
| `effective_context_window_percent` | integer 1–100 | 建议实际用于输入的比例，codex 默认 95 |
| `auto_compact_token_limit` | integer，可为 null | 建议的自动压缩阈值。为 null 时，由 harness 按窗口的 90% 推导 |
| `truncation_policy` | `{"mode":"bytes"\|"tokens","limit":integer}` | 建议的工具输出截断策略 |
| `input_modalities` | array，元素为 `"text"` 或 `"image"` | 支持的输入模态 |
| `reasoning` | object | 见下 |
| `capabilities` | object | 见下 |

说明：`auto_compact_token_limit` 和 `truncation_policy` 是**建议值**，harness 可以覆盖。这是照搬 codex 的 `ModelInfo`：这些策略和模型有关，所以随模型一起下发。

`reasoning` 对象：

| 字段 | 类型 | 说明 |
|---|---|---|
| `supported_efforts` | array，元素为 `"none"`、`"low"`、`"medium"`、`"high"` | 允许的推理强度 |
| `default_effort` | 同上 | 未指定时使用 |
| `summary` | boolean | 是否能输出推理摘要。本地模型通常为 false，只输出原始推理 |

`capabilities` 对象，所有字段都是 boolean：

| 字段 | 含义 |
|---|---|
| `parallel_tool_calls` | 一次响应里能否包含多个工具调用 |
| `custom_tools` | 是否支持自由文本输入的 `custom` 工具（第 8 节） |
| `structured_output` | 是否支持约束生成：`text.format` 的 json_schema 格式，以及 function 工具的 `strict: true`（第 8.3 节） |
| `prompt_cache` | 扩展 X1：是否按 `prompt_cache_key` 复用前缀，并回报 `cached_tokens` |
| `prewarm` | 扩展 X2：是否支持 `generate: false` 预热 |
| `input_tokens` | 扩展 X3：是否提供 token 计数端点 |
| `websocket` | 是否支持 WebSocket 传输及增量续接（第 3.3 节）。原生后端必须为 true |
| `reasoning_effort_updates` | 是否支持用 `configuration_update` 输入 item 在对话中途换档（第 6.1 节），对应 codex 的 `supports_reasoning_effort_updates` |

wire 上的能力只有 boolean 两种取值。Aporisa SDK 对 harness 暴露的是**三态**能力：`supported`、`emulated`、`unsupported`。原生 driver 只会给出 `supported` 或 `unsupported`；`emulated` 只会由兼容 driver 给出，具体见 [compat-openrouter.md](compat-openrouter.md)。

## 6. 请求：`POST /v1/responses`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `model` | string | 是 | 必须等于某个公开别名，否则返回 404 `model_not_found` |
| `instructions` | string | 否 | 系统指令，和 `input` 分开传，便于保持前缀稳定 |
| `input` | Item[] | 是 | 完整历史，1 到 N 项，只允许第 7.1 节列出的输入类型 |
| `tools` | ToolSpec[] | 否 | 工具定义，见第 8 节 |
| `tool_choice` | `"auto"` \| `"none"` | 否 | 默认 `"auto"` |
| `parallel_tool_calls` | boolean | 否 | 默认 false；只有在 `capabilities.parallel_tool_calls` 为 true 时才可以设为 true |
| `reasoning` | `{"effort": ...}` | 否 | 推理强度的**基线**，含义见第 6.1 节。`effort` 取值必须在 `supported_efforts` 内。另可带 `"summary":"auto"`，前提是 `reasoning.summary` 为 true |
| `text` | `{"format": JsonSchemaFormat}` | 否 | 结构化输出，需要 `capabilities.structured_output` |
| `max_output_tokens` | integer | 否 | 1 到模型的 `max_output_tokens`，包括推理 token |
| `prompt_cache_key` | string，1–128 字符 | 否 | 缓存亲和键（X1）。harness 一般取 thread id。服务端未声明 `prompt_cache` 时也接受这个字段，但它不产生任何效果 |
| `generate` | boolean | 否 | 默认 true；设为 false 表示预热（X2），需要 `capabilities.prewarm` |
| `stream` | `true` | HTTP 必填 | HTTP 上只能为 true；WebSocket 的 `response.create` 中不带这个字段 |
| `previous_response_id` | string | 否 | **只在 WebSocket 上有效**，见第 3.3 节；在 HTTP 上出现时返回 400 `unsupported_parameter` |
| `client_metadata` | 从 string 到 string 的映射 | 否 | 追踪用，最多 16 个键，每个值最多 512 字节。服务端不写进日志正文 |

说明：`prompt_cache_key` 在未声明能力时也接受，是对第 1 节第 6 条原则的有意例外。原因是它只是一个亲和提示，忽略它不会改变语义。本文中只有这一个例外。

`JsonSchemaFormat` 的形状是 `{"type":"json_schema","name":string,"schema":object,"strict":true}`。schema 只允许第 8.3 节定义的子集。

**结构约束**（违反时返回 400 `invalid_request`）：
- `input` 中每个 `function_call` / `custom_tool_call`，在它**之后**都必须有且仅有一个 `call_id` 相同的对应 output；每个 output 也必须对应它之前的某个 call。这对应 codex 的历史规范化不变量，由 harness 保证，服务端负责校验。
- 在 `input` 里，assistant 角色的 `message`、`reasoning` 和工具调用 item，只能来自先前的模型输出。服务端不校验它们的来源，但 harness 不得伪造。
- `configuration_update` 不能出现在一个工具调用和它的 output 之间：它之前的所有调用都必须已经有了 output。它的 `reasoning.effort` 必须在 `supported_efforts` 内，否则返回 400 `unsupported_parameter`。

### 6.1 推理强度：基线与中途换档

照搬 codex 的 `configuration_update`：换档写进历史的尾部，而不是修改请求字段。这样换档不会让前缀失效。

- **生效强度**：本次生成使用的推理强度按以下顺序确定：
  1. `input` 中最后一个 `configuration_update` 的 `reasoning.effort`（WebSocket 续接时，按展开后的完整 `input` 计算）；
  2. 没有则取请求的 `reasoning.effort`；
  3. 都没有则取模型的 `default_effort`。
- **基线**：请求的 `reasoning.effort` 表示 `input` 开头时生效的强度。harness 在同一个上下文窗口内保持它不变。
- **换档**：用户在对话中途改档时，harness 在 `input` 末尾追加一个 `configuration_update`（位置在下一条用户消息之前，或者工具结果之后），并把它作为历史的一部分保存，之后的请求原样回传。每个 `configuration_update` 从它所在的位置起生效，直到下一个 `configuration_update` 为止。换档后强度和当前生效强度相同时，不追加。
- 这样换档只改变历史的尾部：服务端可以继续复用已有的前缀（X1）；`reasoning` 字段不变，WebSocket 续接也不受影响（第 3.3 节）。
- 上下文压缩后开始新的上下文窗口时，harness 可以把当前强度作为新的基线，并丢弃旧的 `configuration_update`。
- `configuration_update` 只能由 harness 按用户的选择生成，不能来自模型输出或工具结果。服务端不校验来源。
- 模型没有声明 `capabilities.reasoning_effort_updates` 时，客户端不得发送 `configuration_update`，服务端返回 400 `unsupported_parameter`。此时只能通过修改 `reasoning.effort` 来换档，代价是前缀缓存失效、WebSocket 续接退回完整请求。兼容 driver 的模拟方式见 [compat-openrouter.md](compat-openrouter.md)。
- **生效强度为 `none` 时**，本次生成不得产生 `reasoning` item，`usage.output_tokens_details.reasoning_tokens` 为 0。
- 服务端在内部如何表达 `configuration_update`（例如渲染为一段指令），属于后端的模型适配细节，不属于协议。

## 7. Item 模型

### 7.1 类型

所有 item 都有 `type` 字段。输出 item 带有服务端生成的 `id`，前缀分别为 `msg_`、`rs_`、`fc_`、`ctc_`。输入 item 可以带 `id`，服务端不赋予它任何语义，只保留原样。

**`message`**

```json
{"type":"message","id":"msg_1","role":"assistant","phase":"final_answer",
 "content":[{"type":"output_text","text":"已完成。"}]}
```

- `role`：`user`、`developer` 或 `assistant`。系统级指令放在请求的 `instructions` 里；`developer` 用于 harness 注入的上下文说明，参照 codex。
- `content` 的元素类型：
  - `input_text`：`{text}`，用于 user 和 developer。
  - `input_image`：`{image_url, detail?}`，只用于 user。`image_url` 只接受 PNG 或 JPEG 格式的 `data:` URL；`detail` 取 `auto` 或 `high`。前提是模型的 `input_modalities` 包含 `image`。
  - `output_text`：`{text}`，只用于 assistant。
- `phase`：可选，只用于 assistant。
  - `commentary`：回合中途的过程叙述，之后可能还有工具调用。
  - `final_answer`：本回合的最终回答。
  - 服务端无法判断时可以省略。

**`reasoning`**

```json
{"type":"reasoning","id":"rs_1","summary":[],
 "content":[{"type":"reasoning_text","text":"..."}],"encrypted_content":null}
```

- 本地后端输出**明文** `content`。`summary` 只在 `reasoning.summary` 为 true 时才有内容。
- `encrypted_content`：原生后端恒为 `null`。这个字段只为兼容层透传第三方的不透明数据而保留。客户端回传时必须原样保留，不能修改。
- 客户端可以把 reasoning item 放回 `input`。是否保留、保留多少，属于 harness 的上下文策略。

**`function_call`**

```json
{"type":"function_call","id":"fc_1","call_id":"call_abc","name":"exec_command",
 "arguments":"{\"cmd\":\"ls\"}"}
```

`arguments` 是 **JSON 字符串**，不是对象，这和 Responses API 一致。

- 服务端保证它**总是语法合法的 JSON 对象**。
- 工具声明了 `strict: true` 时，还保证它符合参数 schema（第 8.3 节）。
- 没有声明 `strict: true` 时，服务端按参数 schema 尽量转换参数值的类型，转换不了的值保留为 JSON 字符串；缺少或多出的参数原样保留。是否符合 schema 由 harness 校验，不符合时按 codex 的做法把错误作为这次调用的 output 回给模型。
- `name` 只保证符合第 8.2 节的命名规则，**不保证在本次请求的 `tools` 中**。收到未声明的工具名时，harness 同样把错误作为 output 回给模型。
- 模型输出的工具调用连一个 item 都拼不出来时（见第 9.2 节 `tool_call_invalid`），服务端以 `response.failed` 结束，不会输出不合法的 `function_call`。

**`function_call_output`**

```json
{"type":"function_call_output","call_id":"call_abc","output":"file1\nfile2"}
```

`output` 可以是 string，也可以是元素为 `input_text` 或 `input_image` 的数组。

**`custom_tool_call` / `custom_tool_call_output`**（需要 `capabilities.custom_tools`）

```json
{"type":"custom_tool_call","id":"ctc_1","call_id":"call_def","name":"apply_patch",
 "input":"*** Begin Patch\n..."}
{"type":"custom_tool_call_output","call_id":"call_def","output":"Success."}
```

`input` 是自由文本，不是 JSON。这对应 codex 的 `apply_patch` 等工具。

**`configuration_update`**（只用于输入，需要 `capabilities.reasoning_effort_updates`）

```json
{"type":"configuration_update","reasoning":{"effort":"high"}}
```

- 只出现在 `input` 中，不会出现在输出里，也没有 `id`。对象只有 `type` 和 `reasoning` 两个键，`reasoning` 只有 `effort` 一个键。
- 语义和位置规则见第 6 节的结构约束和第 6.1 节。

### 7.2 Response 对象

在 `response.created` 和终止事件中出现：

| 字段 | 说明 |
|---|---|
| `id` | `resp_` 前缀 |
| `object` | `"response"` |
| `created_at` | Unix 秒 |
| `model` | 请求时使用的公开别名 |
| `status` | `in_progress`、`completed`、`incomplete` 或 `failed` |
| `output` | Item[]。在终止事件中为完整输出；在 `response.created` 中为 `[]` |
| `usage` | Usage，可为 null。只有 completed 和 incomplete 必须提供 |
| `incomplete_details` | `{"reason": "max_output_tokens" \| "interrupted"}`，可为 null；`interrupted` 只会在 WebSocket 中断时出现 |
| `error` | `{"code","message"}`，可为 null，只在 failed 时提供 |

`Usage` 的形状与 codex 解析的一致：

```json
{"input_tokens":1200,"input_tokens_details":{"cached_tokens":1024},
 "output_tokens":85,"output_tokens_details":{"reasoning_tokens":40},"total_tokens":1285}
```

- 所有值必须是**真实**的非负整数，并且 `total_tokens = input_tokens + output_tokens`。不能估算，也不能用 0 填补缺失。
- `cached_tokens`：本次复用了多少前缀 token。服务端未声明 X1 时为 0。

### 7.3 流式事件

### 事件类型

| 事件 | 主要字段 | 说明 |
|---|---|---|
| `response.created` | `response` | 固定为第一个事件，`status=in_progress` |
| `response.output_item.added` | `output_index`, `item` | item 开始。此时 item 的内容可能为空 |
| `response.content_part.added` / `.done` | `item_id`, `output_index`, `content_index`, `part` | `message` 的内容片段开始或结束 |
| `response.output_text.delta` / `.done` | `item_id`, `output_index`, `content_index`, `delta` / `text` | 回答文本 |
| `response.reasoning_text.delta` / `.done` | `item_id`, `output_index`, `content_index`, `delta` / `text` | 明文推理 |
| `response.reasoning_summary_part.added` / `.done`<br>`response.reasoning_summary_text.delta` / `.done` | `item_id`, `output_index`, `summary_index`, … | 只在 `reasoning.summary` 为 true 时出现 |
| `response.function_call_arguments.delta` / `.done` | `item_id`, `output_index`, `delta` / `arguments` | 工具参数的片段 |
| `response.custom_tool_call_input.delta` / `.done` | `item_id`, `output_index`, `delta` / `input` | 自由文本工具输入的片段 |
| `response.output_item.done` | `output_index`, `item` | **权威的完整 item** |
| `response.completed` | `response` | 终止：成功 |
| `response.incomplete` | `response` | 终止：未完成，原因见 `incomplete_details.reason` |
| `response.failed` | `response` | 终止：失败，原因见 `response.error` |

### 顺序规则

1. `response.created` 是第一个事件。**有且仅有一个**终止事件，它之后流关闭。
2. 每个 item 的事件依次为：`output_item.added` → 若干 delta 及其 `.done` → `output_item.done`。`output_index` 从 0 开始连续编号。
3. v0 中**各个 item 的事件不交错**：前一个 item 的 `output_item.done` 发出后，下一个 item 才开始。
4. `response.completed` 中的 `response.output`，必须与各个 `output_item.done` 中的 item 逐一相等。
5. 预热请求（`generate:false`）只发送 `response.created` 和 `response.completed`，`output` 为 `[]`，`usage.output_tokens` 为 0。
6. 客户端判定失败的情况：没有收到终止事件就断流、`sequence_number` 不连续、事件违反以上规则、JSON 非法。
7. 客户端遇到未知的事件类型或 item 类型时，按协议错误处理，不忽略。v0 的双方都由本项目控制，所以从严要求。

### 回合结束的判断

协议不提供 `end_turn` 字段。如果输出里没有任何工具调用，就视为模型结束了本回合。这由 harness 判断，参照 codex 在上游缺少 `end_turn` 时的回退逻辑。

## 8. 工具

### 8.1 ToolSpec

**function 工具**

```json
{"type":"function","name":"exec_command","description":"...",
 "parameters":{...JSON Schema 子集...},"strict":false}
```

**custom 工具**（需要 `capabilities.custom_tools`）

```json
{"type":"custom","name":"apply_patch","description":"...","format":{"type":"text"}}
```

v0 只支持 `format.type = "text"`，带语法约束的格式留待后续版本。

### 8.2 命名

- `name` 必须匹配 `^[A-Za-z0-9_-]{1,64}$`，并且在同一个请求里唯一。
- v0 不支持 `namespace`。MCP 工具由 harness 用前缀的方式展平命名。

### 8.3 JSON Schema 子集

`parameters` 和 `text.format.schema` 使用同一个子集：
- 允许的类型：`object`、`array`、`string`、`number`、`integer`、`boolean`、`null`。
- 允许的关键字：`properties`、`required`、`items`、`enum`、`description`、`additionalProperties`，以及非根位置的 `anyOf`。
- 超出子集的关键字，返回 400 `unsupported_schema`。
- `strict: true` 时，服务端在生成阶段就对参数做约束，并在完成后再校验一次。校验失败时，以 `response.failed` 结束，错误码为 `structured_output_invalid`。
- `strict: true` 和 `text.format` 依赖同一种约束生成能力，需要 `capabilities.structured_output`。模型没有声明时，带 `strict: true` 的工具返回 400 `unsupported_parameter`（`param` 为 `tools[i].strict`）；`strict: false` 或省略总是允许。

## 9. 错误

### 9.1 流开始之前：HTTP 错误

响应体格式：

```json
{"error":{"type":"invalid_request_error","code":"context_length_exceeded",
 "message":"Input exceeds the model context window.","param":"input"}}
```

四个键都必须提供。`param` 可以为 `null`。`message` 是固定的安全说明，不能回显客户内容。

| HTTP | type | code | 条件 |
|---|---|---|---|
| 400 | invalid_request_error | `invalid_request` | JSON、字段、组合或 item 结构不合法 |
| 400 | invalid_request_error | `unsupported_parameter` | 未知的键，或能力未声明 |
| 400 | invalid_request_error | `unsupported_schema` | schema 超出子集 |
| 400 | invalid_request_error | `invalid_image` | 图片解码失败或格式不支持 |
| 400 | invalid_request_error | **`context_length_exceeded`** | 输入加上预留的输出超出窗口。**harness 以此作为触发压缩的信号**，参照 codex 的 `ContextWindowExceeded` |
| 401 | authentication_error | `invalid_api_key` | |
| 404 | invalid_request_error | `model_not_found` / `not_found` | |
| 408 | invalid_request_error | `request_timeout` | 上传超时 |
| 413 | invalid_request_error | `request_too_large` | |
| 415 | invalid_request_error | `unsupported_media_type` | |
| 409 | invalid_request_error | `previous_response_not_found` | 仅 WebSocket：续接条件不满足。客户端改发完整请求，不计入重试次数 |
| 409 | invalid_request_error | `response_in_progress` | 仅 WebSocket：连接上已有进行中的 response |
| 503 | server_error | `connection_limit_reached` | 仅 WebSocket：连接到了最长寿命，服务端随后关闭连接，客户端重新建立连接 |
| 429 | rate_limit_error | `queue_full` / `queue_timeout` | 必须带 `Retry-After`，值为正整数秒 |
| 503 | server_error | `service_not_ready` | 必须带 `Retry-After` |
| 500 | server_error | `internal_error` | |

`context_length_exceeded` 必须在开始生成**之前**判定，不能在流中途才报。

### 9.2 流开始之后：`response.failed`

`response.error.code` 的取值：

| code | 含义 |
|---|---|
| `server_error` | 服务端内部错误 |
| `inference_timeout` | 总期限到，或上游空闲超时 |
| `output_limit_exceeded` | 输出字节超出上限 |
| `structured_output_invalid` | 结构化输出没有通过最终校验 |
| `engine_failure` | 引擎故障 |
| `tool_call_invalid` | 模型输出的工具调用结构损坏，无法组成 `function_call` item（例如调用没有闭合、没有函数名、函数名不符合第 8.2 节的命名规则）。在它之前已经完成的 item 保留在 `output` 中，写到一半的调用被丢弃。`message` 从固定的几条说明中选一条，指出是哪种损坏，不回显模型输出的内容。服务端不自动重试 |

参数类型不符、缺少参数、工具名不在 `tools` 中，都**不属于** `tool_call_invalid`，照常输出 `function_call`，由 harness 处理（第 7.1 节）。

达到 `max_output_tokens` 不算失败，以 `response.incomplete` 结束，`reason` 为 `max_output_tokens`。

### 9.3 重试

- 只有**流开始之前**的 429 和 503 可以重试：最多 2 次，遵守 `Retry-After`，并加随机抖动。
- 流开始之后出错，或者连接状态不确定时，**一律不自动重试**。
- 服务端不自动重放请求，也不把部分结果伪装成成功。

## 10. 扩展（C \ A）

| 编号 | 名称 | 能力开关 | 语义 |
|---|---|---|---|
| X1 | 前缀缓存亲和 | `prompt_cache` | 对于 `prompt_cache_key` 相同的请求，服务端**可以**复用最长公共前缀的 KV cache，并通过 `usage.input_tokens_details.cached_tokens` 回报复用了多少。命中与否只影响延迟，**不影响输出语义**。harness 要想提高命中率，应保持 `instructions`、`tools` 和较早的 `input` 稳定 |
| X2 | 预热 | `prewarm` | `generate:false`：只做 prefill、不生成。在 HTTP 上，为之后同一个 `prompt_cache_key` 的请求准备好前缀；在 WebSocket 上，这次预热以 `completed` 结束，因此可以作为续接的起点，这是 codex 的标准用法：先完整预热，再带 `previous_response_id` 发送空的或增量的 `input` |
| X3 | 输入 token 计数 | `input_tokens` | `POST /v1/responses/input_tokens`，请求体与 `/v1/responses` 相同，但不含 `stream` 和 `generate`。返回 `{"object":"response.input_tokens","input_tokens":N}`，计算方法和真实请求一致 |

这三项都是可选的。没有它们，harness 也必须能正常工作：token 计数退回为「上一次的 usage + 新增内容按每 4 字节 1 个 token 估算」，参照 codex。

## 11. 容量

所有资源都必须有上限：请求正文、输入文本总量、图片数量和大小、并发、排队、输出字节、总期限、空闲超时。具体数值属于后端的部署事实，记录在后端文档中，并通过 `/v1/models` 的 `context_window` 和 `max_output_tokens` 暴露必要的部分。超出上限时，按第 9 节返回明确的错误，不能自动截断输入或降低输出预算。

## 12. v0 暂不纳入、后续版本再议

| 项目 | 暂不纳入的原因 |
|---|---|
| 渲染 prompt、按 token id 做 tokenize | 属于研究用的精细观测，等 F6 需要时再加 |
| embeddings、rerank | codex 没有用到，等有具体功能需要时再加 |
| `namespace` 工具、带语法约束的 custom 工具 | 本地约束解码的实现成本高 |
| `temperature`、`top_p`、`seed` | codex 不发送这些参数；用户已明确决定不加入 |
| 同一响应中 item 事件交错输出 | 为了简化实现 |

## 13. 合同变更流程

1. 先修改本文，更新修订日期。
2. 同步 TS 类型，并导出 JSON Schema 提交到仓库，由漂移测试保证两者一致。
3. 同步 mock server，以及 wire 层和 SDK 层的一致性测试。
4. 同步 SDK 和兼容 driver，以及 [compat-openrouter.md](compat-openrouter.md)。
5. 同步后端。

任何一步没有完成，就不能声称新版本的合同已经生效。
