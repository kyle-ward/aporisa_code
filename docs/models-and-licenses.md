# 模型、上游来源与许可证

本文记录后端使用的模型、上游来源、本地派生产物和许可证要点。模型配置指针（`MODEL_LIST` / `POINTERS` / `PROFILES`）和权重维护入口在 B1-2 实现后，由 `docs/model-management.md` 描述；在那之前，下表就是唯一的记录。

> **当前状态（2026-09-30）**：后端处于 B0 探路阶段，还没有服务在运行。下面的派生产物由 B0 的一次性脚本生成，尚未登记为正式的模型身份（B1-2）。

## 模型

| 项目 | 内容 |
|---|---|
| 模型 | Qwen3.8-Flash-Next，mlx-vlm 中的架构名为 `qwen4_exp` |
| 上游仓库 | [`Qwen/Qwen3.8-Flash-Next-FP8`](https://huggingface.co/Qwen/Qwen3.8-Flash-Next-FP8) |
| 固定 revision | `236dfdf285828023ca3bcd3f37366c58a3469b13` |
| 大小 | 144 个文件，185.6 GB，下载后已完整核验（见 [validation.md](validation.md)） |
| 未使用的版本 | BF16 版 `Qwen/Qwen3.8-Flash-Next`（360.0 GB，revision `de4b8e4d43b917e7706784d8bb445c9af86a3540`） |
| 许可证 | Qwen Community License 1.0（见下） |

对外只暴露公开模型别名，真实型号只在内部文档和配置中出现（AGENTS.md）。

## 本地派生产物（B0）

都由 `backend/scripts/b0_convert.py` 从上面的 FP8 checkpoint 转换得到，放在 `.runtime/models/` 下，不进入 Git。每个产物目录里都有 `recipe.json`，记录源 revision、转换配方和工具版本。

| 产物 | 配方 | 常驻权重 |
|---|---|---|
| `Qwen3.8-Flash-Next--affine4g64` 及其 `-extple` 视图 | 主体 affine 4-bit gs64；PLE affine 4-bit gs32，外置在 SSD 上按行读取；路由门控 affine 8-bit gs64；视觉编码器不量化 | 66.8 GiB |
| `Qwen3.8-Flash-Next--mxfp4` 及其 `-extple` 视图 | 主体 mxfp4；其余同上 | 63.1 GiB |
| `Qwen3.8-Flash-Next--affine4g64-mtp` | 从同一 checkpoint 拆出的 MTP 草稿模型，affine 4-bit gs64 | 1.4 GiB |

推理引擎：MLX 0.32.3；mlx-vlm 锁定为 git commit `00093678a1f6bd513212d94778ffc381d6d731bf`（v0.7.4）。两者均为 MIT 许可证。

## 许可证要点：Qwen Community License 1.0

以下是阅读许可证原文后整理的要点，**不是法律意见**。原文随 checkpoint 一起下载（`LICENSE`），以原文为准。

- **允许**：使用、修改、合并、发布、分发、再许可、出售、部署、托管、微调和制作衍生作品，量化转换也包括在内。
- **署名**：所有副本和衍生作品都要附上版权声明和许可声明。`b0_convert.py` 会把 `LICENSE` 复制到每个转换产物里；这个修复之前生成的 5 个产物目录，已于 2026-09-30 手动补上。
- **第 1 条**：用于月活超过 1 亿或月收入超过 2000 万美元的商业产品时，要在界面上显著标明模型名称。本项目不涉及。
- **第 2 条**：从事「Model as a Service」或「AI Work Assistant」业务并用于商业目的时，需要另外取得 Qwen 的授权。许可证中 AI Work Assistant 的定义是「主要用于 AI 辅助编程或办公的独立 AI 产品」，**Aporisa Code 正属于这一类**。
  - 许可证对**内部使用**有豁免，前提是不把软件、它的输出或底层模型能力提供给任何第三方。
  - 本项目目前是个人在本机使用，属于内部使用。如果将来对外发布、分发给他人或商用，需要先重新评估，必要时向 Qwen 申请授权。

## B0 对照用模型（不部署）

| 模型 | 来源 | 用途 |
|---|---|---|
| Qwen3.8-27B，MLX 4-bit | local_llm 已下载的 [`mlx-community/Qwen3.8-27B-4bit`](https://huggingface.co/mlx-community/Qwen3.8-27B-4bit)，revision `10c35caafbb80f7dc6a7a432cdd11af10a6d4818`，发布页标注 Apache-2.0 | 只用于 B0-12 的质量对照（D-12 的备选模型）；从参考仓库只读加载，不复制、不修改 |
