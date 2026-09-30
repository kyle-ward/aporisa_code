# 模型、上游来源与许可证

本文记录后端使用的模型、上游来源、本地派生产物和许可证要点。模型配置指针（`MODEL_LIST` / `POINTERS` / `PROFILES`）和权重维护入口见 [model-management.md](model-management.md)；本地权重的唯一记录是 `.runtime/model-assets/` 下的身份记录。

> **当前状态（2026-09-30，B1 完成）**：本机登记了两个身份，都从上面的 FP8 checkpoint 转换而来，见下一节。官方 FP8 checkpoint、B0 的旧目录和 mxfp4 产物都已删除；需要重新转换时，按身份记录中的仓库和 revision 重新下载 FP8，再用 `model_weights.sh convert`。

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

## 本地派生产物

配方 `affine4g64`（`backend/src/aporisa_backend/lifecycle/recipes.py`）：主体 affine 4-bit gs64；PLE affine 4-bit gs32，外置在 SSD 上按行读取；路由门控 affine 8-bit gs64；视觉编码器不量化。产物放在 `.runtime/models/<目录>/<配方摘要前 16 位>/`，不进入 Git；身份记录和每个目录里的 `recipe.json` 写明源仓库、revision、配方和工具版本。

| 身份 | 内容 | 常驻权重 |
|---|---|---|
| `Qwen3.8-Flash-Next-affine4g64` | 服务使用的自包含目录：外置 PLE 视图加上它读取的 PLE 分片（PLE 29.8 GiB 留在 SSD 上） | 66.8 GiB |
| `Qwen3.8-Flash-Next-affine4g64-mtp` | 同一次转换拆出的 MTP 草稿模型，被服务身份的 profile 引用（B2-2，上下文 16K 以下每轮 2 个草稿，以上 1 个） | 1.4 GiB |

这两个产物是 B0 用一次性转换脚本生成的，B1 P3 用迁移脚本以硬链接登记为正式身份，没有重新转换（两个脚本已在 B1 收尾时删除，分别见提交 `c89d1b2` 和 `dfd2495`）。B0 还评估过 mxfp4 格式（常驻 63.1 GiB），最终未采用，产物已删除。

推理引擎：MLX 0.32.3；mlx-vlm 锁定为 git commit `00093678a1f6bd513212d94778ffc381d6d731bf`（v0.7.4）。两者均为 MIT 许可证。

## 许可证要点：Qwen Community License 1.0

以下是阅读许可证原文后整理的要点，**不是法律意见**。原文随 checkpoint 一起下载（`LICENSE`），以原文为准。

- **允许**：使用、修改、合并、发布、分发、再许可、出售、部署、托管、微调和制作衍生作品，量化转换也包括在内。
- **署名**：所有副本和衍生作品都要附上版权声明和许可声明。`model_weights.sh convert` 会把 `LICENSE` 复制到每个转换产物里；现有两个身份的目录里都有 `LICENSE`。
- **第 1 条**：用于月活超过 1 亿或月收入超过 2000 万美元的商业产品时，要在界面上显著标明模型名称。本项目不涉及。
- **第 2 条**：从事「Model as a Service」或「AI Work Assistant」业务并用于商业目的时，需要另外取得 Qwen 的授权。许可证中 AI Work Assistant 的定义是「主要用于 AI 辅助编程或办公的独立 AI 产品」，**Aporisa Code 正属于这一类**。
  - 许可证对**内部使用**有豁免，前提是不把软件、它的输出或底层模型能力提供给任何第三方。
  - 本项目目前是个人在本机使用，属于内部使用。如果将来对外发布、分发给他人或商用，需要先重新评估，必要时向 Qwen 申请授权。

## B0 对照用模型（不部署）

| 模型 | 来源 | 用途 |
|---|---|---|
| Qwen3.8-27B，MLX 4-bit | local_llm 已下载的 [`mlx-community/Qwen3.8-27B-4bit`](https://huggingface.co/mlx-community/Qwen3.8-27B-4bit)，revision `10c35caafbb80f7dc6a7a432cdd11af10a6d4818`，发布页标注 Apache-2.0 | 只用于 B0-12 的质量对照（D-12 的备选模型）；从参考仓库只读加载，不复制、不修改 |
