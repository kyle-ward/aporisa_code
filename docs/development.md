# 开发、配置与测试

本文说明日常开发中用到的入口和流程。协议本身见 [protocol.md](protocol.md)，已验证与未验证的事实见 [validation.md](validation.md)。

## 前端工具链

前端（`aporisa_code/`）使用项目内自带的 Node，不依赖全局安装。版本固定在 `scripts/common.sh` 中：

| 工具 | 版本 | 位置 |
| --- | --- | --- |
| Node | 24.21.0（LTS） | `aporisa_code/.tools/node/`，由 `prepare` 下载并做 SHA256 校验 |
| npm | 11.x（随 Node 附带） | 同上 |
| 依赖 | 由 `aporisa_code/package-lock.json` 锁定，版本精确固定 | `aporisa_code/node_modules/` |

```bash
./frontend.sh doctor
./frontend.sh prepare
```

- `doctor` 只读，检查 Node、npm、lockfile 和依赖是否齐全。
- `prepare` 是前端唯一联网的模式：下载并校验 Node，然后执行 `npm ci`。
- `dev`、`build`、`install`、`uninstall` 在 F5 之前尚未实现，调用时会明确报错。

新增或升级依赖属于开发行为，用项目内的 npm 执行，并提交更新后的 lockfile：

```bash
cd aporisa_code && PATH="$PWD/.tools/node/bin:$PATH" npm install --save-exact <package>@<version>
```

## 后端工具链

后端（`backend/`）只在 Mac Studio 上开发，Air 无法调试后端；前端两台机器都可以开发（见 AGENTS.md）。环境由 `./backend_service.sh prepare` 准备（`scripts/lifecycle.py`，只用标准库引导），它是服务生命周期中唯一联网的模式：

| 工具 | 版本 | 位置 |
| --- | --- | --- |
| uv | 0.12.7 | `.tools/uv/uv`，从 GitHub release 下载并校验 SHA256 |
| Python | 3.12.12 | `.runtime/python/`，由 uv 管理 |
| 依赖 | 由 `backend/uv.lock` 锁定；mlx-vlm 锁定到 git commit | `backend/.venv/` |

prepare 还会对指针引用的模型计算完整 SHA256，并写入源码收据和模型收据；源码、脚本或依赖改动之后，doctor 会提示重新 prepare。服务的运维见 [macos.md](macos.md)，权重见 [model-management.md](model-management.md)。

修改依赖属于开发行为：先改 `backend/pyproject.toml`，再用项目内的 uv 和目录执行 `uv lock`，然后运行 `prepare`，把 `uv.lock` 一起提交：

```bash
cd backend && UV_CACHE_DIR=../.cache/uv UV_PYTHON_INSTALL_DIR=../.runtime/python UV_PYTHON_PREFERENCE=only-managed \
  ../.tools/uv/uv lock
```

### 后端代码结构

| 目录 | 职责 |
| --- | --- |
| `protocol/` | 合同的 Python 侧：严格 JSON、按已提交的 schema 校验、语义规则、错误码 |
| `gateway/` | ASGI 网关：准入、HTTP/SSE、WebSocket、事件组装、worker 客户端与恢复 |
| `ipc/` | 网关与 worker 之间的帧格式 |
| `engine/` | worker 进程：加载与预热、模型适配层、会话与快照、SSD 会话缓存、生成、投机解码、结构化输出、图片输入、PLE 预取 |
| `lifecycle/` | doctor/prepare/run、共用检查、收据、身份记录与目录租约、权重维护、转换配方 |
| `configs/` | 随代码评审的策略：模型指针、资源上限、引擎、部署、服务超时 |
| `fake/` | 测试用的进程内假 worker |

## 对运行中的服务做真实生成验证

`scripts/validate_runtime.py` 由用户显式运行，不属于 `check.sh`。它按 `backend/.env` 的 key 和端口，对已经启动的服务逐项检查：文本、推理、工具调用及工具结果续写、`prompt_cache_key` 前缀复用、WebSocket 续接、中途换档到 `none`、MTP 与提示词查找投机、结构化输出、图片输入（读出生成图片上的颜色和文字、读工具结果里的图片、同一张图再次请求全部命中缓存而另一张同尺寸的图不会）、`/health/runtime`。结果只含数字，追加到 `.runtime/validation/validate_<时间>.jsonl`。

```bash
backend/.venv/bin/python scripts/validate_runtime.py
backend/.venv/bin/python scripts/validate_runtime.py --long 131072
```

SSD 缓存的重启验收（B2-1）分两步，中间由用户重启服务；这两种模式只运行这一项检查：

```bash
backend/.venv/bin/python scripts/validate_runtime.py --restart-prepare 200000
./backend_service.sh restart
backend/.venv/bin/python scripts/validate_runtime.py --restart-resume
```

第一步建立约 200K 的会话，把 key、长度和提示词的 sha256（不含文本）记在 `.runtime/validation/restart.json`；第二步发送同一个请求，要求从 SSD 恢复（`restore_path=ssd`）、全部 token 命中、首 token 在 10 秒内。两步之间仓库文件有改动时，提示词会变，第二步会要求重新准备。

`--long` 增加长上下文检查（B1-10 的验收）：一次冷预填充，服务端预填充速度要达到 B0-5 同长度「纯计算」速度的 80%；紧接着续接一轮，只预填充增量；整个过程 swap 用量不增长。

运行期间每秒采样一次系统的压缩器、swap 和空闲内存，每项检查结束时报告它造成的系统级内存压力，最后给出整轮的汇总；数据都在同一个结果文件里。

## 前台运行

开发期可以在前台运行服务（不经过 launchd，检查与正式服务相同），Ctrl+C 停止：

```bash
./scripts/backend.sh run
```

## 前端代码结构

| 目录 | 职责 | 允许依赖 |
| --- | --- | --- |
| `src/protocol/` | 协议的 zod 定义（机器可读合同的单一源头）、语义校验、流顺序校验、续接判定 | 仅 `zod` |
| `src/sdk/` | Aporisa SDK：客户端接口，以及 native driver（WebSocket 默认，HTTP 兜底） | protocol、`ws`、Node 内置模块 |
| `src/mock/` | 可编排脚本的确定性引擎、mock server（两种传输）、进程内 stub driver | protocol、sdk、`ws` |
| `src/conformance/` | wire 层一致性测试用例，直接使用 HTTP 和 WebSocket，不依赖 SDK 的 driver | protocol、sdk 的 SSE 解码、`ws` |

依赖方向由 `tools/check-boundaries.ts` 强制检查。以后新增的 `host/`、`harness/`、`cli/`、`main/`、`preload/`、`ui/` 已经预置了规则；在 `src/` 下新增任何没有规则的顶层目录，检查都会失败。

## 合同变更

按 [protocol.md](protocol.md) 第 13 节的顺序进行。改动 `src/protocol/` 之后，重新导出 JSON Schema 并一起提交：

```bash
cd aporisa_code && PATH="$PWD/.tools/node/bin:$PATH" npm run schema:export
```

`tests/schema-drift.test.ts` 会比较提交进仓库的 `docs/schema/aporisa-protocol-v0.schema.json` 和当前 zod 定义的导出结果，两者不一致时测试失败。

## 确定性检查

```bash
./scripts/check.sh frontend
```

前端检查依次执行：TypeScript 类型检查、import 边界检查、Vitest 全部测试（包括对 mock server 的 wire 层一致性测试）。之后还有 Shell 语法检查和 `git diff --check`。整个过程不联网，也不启动真实服务。

agent 只允许运行 `frontend` 范围。后端检查和不带参数的全量检查由用户运行，见 AGENTS.md。

## 对真实服务运行一致性测试

以下操作会联网，由用户手动执行，不属于 `check.sh`。一致性测试用例可以直接对真实后端运行，例如 Studio 上的后端：

```bash
cd aporisa_code && PATH="$PWD/.tools/node/bin:$PATH" \
  APORISA_BASE_URL=http://<host>:<port>/v1 APORISA_API_KEY=<key> APORISA_MODEL=<alias> \
  npm run --silent conformance
```

模型没有声明的能力，对应的用例会跳过并标注原因。后端的验收标准就是这套用例全部通过或合理跳过。
