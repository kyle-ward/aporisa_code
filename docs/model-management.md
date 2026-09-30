# 模型配置与权重维护

本文说明后端如何选择模型，以及如何下载、转换、查看和删除本地权重。原则见 AGENTS.md「模型配置与权重」：**模型配置、本地权重、服务生命周期三者解耦**。

## 1. 配置：`configs/models.py`

三样东西都随代码评审，不放进 `.env`：

| 名称 | 内容 |
|---|---|
| `MODEL_LIST` | 可读的模型身份。可以包含尚未下载的名字；没有被指针引用的身份不做校验，也不加载 |
| `POINTERS` | 公开模型别名 → 身份。服务恰好启用一个别名，当前为 `aporisa-local-v0` → `Qwen3.8-Flash-Next-affine4g64` |
| `PROFILES` | 以身份为 key 的推理参数：适配层、上下文窗口、输出上限、推理档位、能力、wired 内存要求、KV 字节数、启动所需的可用内存。不包含目录、仓库或 revision |

## 2. 本地记录与目录布局

| 路径 | 内容 |
|---|---|
| `.runtime/models/<目录>/<版本>/` | 权重。下载的版本是固定的 revision，转换的版本是配方摘要的前 16 位 |
| `.runtime/model-assets/<目录>.json` | 身份记录，是本地权重的**唯一**说明：身份、目录、版本、状态、来源、完整的 SHA256 清单 |
| `.runtime/model-locks/<目录>.lock` | 目录租约。服务运行期间持有共享租约；下载、转换、删除需要独占租约，服务在用时直接拒绝 |
| `.runtime/weight-staging/<目录>/` | 下载和转换的暂存区，失败时保留，下载可以续传 |

记录中的来源分两种：
- `download`：上游仓库和固定的 revision。
- `convert`：配方名、配方内容、配方摘要、转换工具的版本（mlx、mlx-vlm 的 commit），以及源身份的仓库和 revision。源权重删除之后，来源信息仍然保留在记录里，可以追溯。

磁盘上有目录、但没有记录的权重不会被加载，`list` 会把它显示为 `unmanaged`。

## 3. `model_weights.sh`

独立于服务生命周期：不启停服务，不占用推理准入，也不修改 configs。`download`、`convert`、`delete` 由用户执行；`list` 只读，agent 也可以运行。

```bash
./model_weights.sh list
```

只读取目录和记录，不联网、不计算哈希、不创建锁文件。

```bash
./model_weights.sh download <owner/repo> --identity <身份> [--revision <40 位 commit>]
```

- 不指定 revision 时，先解析远端版本，再固定到不可变的 commit。
- 先下载到暂存区，每个文件都核对大小和哈希（大文件是 LFS 的 SHA256，小文件是 git blob），全部通过后才发布；中断后重跑同一条命令可以续传。
- 一个身份已经绑定了某个来源后，不能悄悄换源或换版本。
- 记录已存在、文件完整时只做离线校验；目录存在但没有记录时，需要给出 `--revision`，校验通过后登记。

```bash
./model_weights.sh convert <源身份> --recipe affine4g64 --identity <身份> [--mtp-identity <身份>]
```

- 源身份必须是已登记的下载产物（官方 FP8 checkpoint）。
- 配方在 `backend/src/aporisa_backend/lifecycle/recipes.py`，包括 B0 发现的坑：绕过 mlx-vlm 的通用 FP8 加载（否则专家层会保持 8-bit）、PLE 用 group 32、合并 safetensors 头来核对张量布局、复制 LICENSE。
- 产物是**一个自包含目录**：外置 PLE 视图的全部文件，加上它按行读取的 PLE 分片文件，`ple-store.json` 指向本目录。转换得到的完整 checkpoint（PLE 常驻内存）不保留。
- 转换不能续传：失败后重跑会重新开始。真实模型的转换需要几个小时，峰值内存较高，运行前先停掉服务。
- 自动测试只用一个很小的 FP8 checkpoint 走完整个流程；真实转换未在 B1 中复跑（B0 的产物通过迁移脚本登记，见第 5 节）。

```bash
./model_weights.sh delete <目录名>
```

参数必须是精确的目录名。同时删除权重、暂存区和身份记录，不修改 configs。服务正在使用该目录时拒绝执行。

## 4. 切换模型

1. 下载或转换新权重，登记为新的身份。
2. 修改 `POINTERS`，必要时补上 `MODEL_LIST` 和 `PROFILES`。
3. `./backend_service.sh stop` → `prepare` → `start`，然后做真实验证。

不需要重新下载已有权重，也不需要修改 `.env`。故障时服务不会自动切换到另一个模型。

## 5. 历史：B0 产物的迁移

现有两个身份（`Qwen3.8-Flash-Next-affine4g64` 和 `-mtp`）是 B0 转换的产物。B1 P3 用一次性迁移脚本核对配方和工具版本后，以硬链接登记为正式身份，没有重新转换；之后删除了 B0 的旧目录和官方 FP8 checkpoint。迁移脚本已在 B1 收尾时删除，需要参考时见提交 `dfd2495` 中的 `scripts/migrate_b0_artifacts.py`。
