# 后端系统服务（macOS）

后端作为系统 LaunchDaemon 运行，唯一的入口是 `./backend_service.sh`。实现移植自 local_llm（`scripts/macos_service.sh`），只保留 macOS 的部分。

## 1. 约定

- 以项目目录所有者的身份运行，**不要对整个脚本使用 sudo**。需要特权的步骤（写入 `/Library/LaunchDaemons`、`launchctl`）在脚本内部局部调用 sudo。
- 服务标签：`com.aporisa.backend.<用户>.<项目路径 SHA256 前 12 位>`，所以同一台机器上的不同 checkout 互不干扰。
- plist 从 `deploy/templates/macos/backend.plist` 渲染，生成的副本在 `deploy/generated/`（不进入 Git），安装的副本为 root:wheel 0644。
- `KeepAlive=false`：launchd 不自动重启服务。恢复由网关内部完成，最多重启 worker 2 次（DEVELOPMENT_PLAN 第 14.4 节）。
- 服务从 `backend/.env` 读取 API key 和端口，不继承交互式 shell 里导出的变量。
- launchd 给守护进程的默认文件描述符软上限只有 256；网关和 worker 启动时自己提高到 65536（`configs/engine.py` 的 `open_files`），外置 PLE 表需要 384 个 memmap。
- 超时在 `backend/src/aporisa_backend/configs/macos_service.sh`：等待就绪 300 秒（实测加载加预热 21 秒，权重在页缓存中；开机后冷启动要先从 SSD 读入约 67 GiB，所以留出余量）、退出 90 秒。

## 2. 模式

| 模式 | 作用 |
|---|---|
| `doctor` | 只读检查：环境、依赖、源码收据、指针引用的模型（按 prepare 收据快速核对）、wired 内存上限、可用内存、端口，以及服务状态 |
| `prepare` | 服务生命周期中**唯一联网**的模式：安装项目内的 uv、Python 3.12.12 和锁定的依赖；对指针引用的模型计算完整 SHA256；写入源码收据和模型收据。从不下载、转换或修复权重，也不注册或启动服务 |
| `install` | 注册一个空闲的服务（`RunAtLoad=false`），不启动 |
| `start` | 开启开机自启，在后台启动，等待 `/health/ready` |
| `stop` | 关闭开机自启，卸载 job，等待整个进程树（包括 worker）退出；plist 保留 |
| `restart` | 完整 stop 之后再 start |
| `status` | 注册、自启、进程和就绪状态：`UNINSTALLED`、`STOPPED`、`REGISTERED_IDLE`、`NOT_READY`、`READY`、`FAILED`、`STOP_INCOMPLETE` |
| `uninstall` | 移除已停止或空闲的服务；模型、缓存、配置和日志都保留 |

## 3. 首次部署

1. `backend/.env`：从 `backend/.env.example` 复制，填入随机的 `APORISA_API_KEY`。
2. GPU wired 内存上限（D-16，已持久化在 `/etc/sysctl.conf`）：`sysctl -n iogpu.wired_limit_mb` 应不低于 87040。后端只检查，从不修改系统设置。
3. 权重：见 [model-management.md](model-management.md)。
4. `./backend_service.sh prepare` → `install` → `start`。

## 4. 检查分级

doctor、prepare、run 共用同一套检查（`backend/src/aporisa_backend/lifecycle/checks.py`）：

| 标签 | 含义 |
|---|---|
| `SYSTEM` | 主机不满足条件（不是 Apple silicon macOS） |
| `MANUAL` | 需要用户处理：`.env`、wired 内存上限、权重缺失或损坏 |
| `REPAIRABLE` | 运行 `prepare` 即可修复：依赖缺失、源码或依赖改动之后没有重新 prepare、模型还没有经过完整校验 |
| `WAIT` | 当前资源或状态不允许：可用内存不足、端口被占用、服务正在运行 |

模型校验分两级（DEVELOPMENT_PLAN 第 14.6 节决策 3）：prepare 完整计算全部文件的 SHA256；start 和 run 只核对收据、文件清单、大小，以及小文件的哈希。

## 5. 日志与排障

- 服务控制台输出：`.runtime/services/backend/logs/console_*.log`（启动阶段的检查结果和生命周期事件）。
- 结构化日志：`backend/logs/aporisa_*.jsonl`，字段走白名单，不含提示词、生成内容、密钥、请求头或原始 URL。
- `start` 超时或服务在就绪前退出时，脚本**不会**自动停止服务：先看 `status` 和控制台日志，再显式 `stop`。
- `stop` 只追踪服务自己的进程树（PID/PPID），从不按进程名结束进程。
- 运行状态：`curl -s -H "authorization: Bearer <key>" http://127.0.0.1:18080/health/runtime` 返回网关和 worker 的状态（会话、内存、最近一次请求的计量），只含数字和枚举。
- 内存占用：服务运行期间，模型权重（约 68 GB，含 MTP 草稿模型）在加载时用 `mlock` 锁定在内存里，系统不会压缩或换出它们，worker 就绪日志中的 `locked_bytes` 是锁定的字节数。需要这部分内存时，用 `./backend_service.sh stop` 停止服务即可释放；服务不会因为空闲而自动卸载模型（用户决定）。
- 真实生成验证：`backend/.venv/bin/python scripts/validate_runtime.py`（见 [development.md](development.md)）。
- 服务只监听 `127.0.0.1:18080`。从其他机器访问（例如 I1 集成时 Air 上的 native driver）由用户在 Studio 上现有的 Cloudflare Tunnel 转发到这个地址；后端不新增监听地址。
