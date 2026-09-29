# Admin 模型目录多平台接入规划

## Goal

在 Admin「模型目录」配置中支持除 OpenRouter 以外的模型平台，首个新增平台为 Venice。运营发布配置后，用户在「选择剧情引擎」中选择到的新平台模型必须能沿既有文本生成、免费额度、固定档位计费、VIP 门禁和生成收口链路正常使用。

## Requirements

- Admin 模型目录编辑器不再把 OpenRouter 目录同步 UI 写死在 `ModelCatalogEditor.tsx` 的 `Collapse.items` 中；目录同步入口应按平台配置生成，首期包含 OpenRouter 与 Venice，后续新增平台只需扩展平台配置和适配器。
- Admin 模型卡编辑区新增「模型来源平台」选择项；新建模型默认平台为 OpenRouter；只有先选定平台后，平台模型 ID 下拉才允许选择该平台目录中的可用模型。
- OpenRouter 现有目录同步、搜索、重复映射检查、过期/缺失提示和发布差异摘要必须保持兼容；Venice 平台要提供同等级的目录同步、搜索、选择、重复映射检查和不可用模型提示。
- 已发布的旧模型目录配置必须继续可读、可编辑、可发布、可被用户选择，并默认解释为 OpenRouter 模型。
- 新发布的 Venice 模型配置必须通过 shared 契约、Admin 校验、数据库发布校验和 backend runtime 读取校验。
- Backend 文本生成仍只能通过 `packages/backend/src/features/generation/`，运行时模型目录仍只能通过 `packages/backend/src/platform/runtime-config.ts` / `model-tiers.ts` 读取；不得新增第二套生成或 runtime_config 读法。
- 平台调用配置需要抽成 shared 中的纯配置/类型定义，Backend 基于该配置选择上游 base URL、API key 环境变量、目录同步方式和平台能力；shared 不得包含 secret 或环境读取。
- Railway/后端环境需要新增 Venice key 变量规划，至少包含 `VENICE_API_KEY`；如允许覆盖默认地址，再规划 `VENICE_BASE_URL`，默认值为官方 OpenAI-compatible base URL。
- 发布后用户侧「选择剧情引擎」只暴露稳定模型 ID、展示名、档位、价格/VIP 信息，不泄露平台 key 或不必要的 provider 原始响应。
- 若 Venice 不提供 OpenRouter `/generation` 同等用量元数据接口，首期必须明确降级为不回捞 Venice 用量元数据，但仍可通过 SSE `finish_reason` 完成固定档位计费收口。

## Constraints

- 不创建新数据表；优先演进现有 `llm_model_catalog` JSON 结构和相关 DB 校验函数。
- 不自动开始实现；本任务完成规划后等待人工确认，再运行 `task.py start` 进入实现。
- 新增/修改测试文件需要在设计与验收标准中明确必要性；本任务因为涉及 shared 契约、DB 校验和生成链路，规划中允许补充针对纯函数/契约/适配器的回归测试。
- Venice 模型列表以实时 API 为准；不得把当前模型 ID 硬编码成静态清单。

## Acceptance Criteria

- [ ] 规划文件覆盖 PRD、技术设计、实施计划、任务分解和研究记录。
- [ ] 设计列出已检索的组件、hooks、helpers、contracts、features/repositories、DB 函数和迁移校验，并说明复用/扩展/不复用理由。
- [ ] 设计覆盖超时、有限重试、幂等、并发、事务、降级、补偿、限流、容量和可观测性，且说明不适用项。
- [ ] 设计给出兼容旧 `openrouter_model_id` 配置的迁移与回滚/forward-fix 方案。
- [ ] 实施计划覆盖 Admin、shared、backend、migration、Railway/env 文档、自动验证和人工回归场景。
- [ ] 任务保持 `planning` 状态，不修改产品代码、不执行 `task.py start`。
