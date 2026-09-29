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
- Venice 主对话轮次仍以 `experience.chat_history` 为唯一事实源；Venice API 的回传与 usage 不得写入该表的 OpenRouter 元数据列，而应一对一写入 `experience.venice_chat_history` 明细表。
- `experience.venice_chat_history` 的 LLM 元数据列需与现有 `chat_history.llm_*` 字段同口径，包括 generation id、provider/model、finish reason、usage/cached/reasoning/prompt/completion token、延迟、生成耗时和归一化完整元数据；不得复制用户输入、消息上下文或模型回复正文。
- Venice 流式请求应按其 OpenAI-compatible API 请求 usage，并从最终 SSE chunk 解析 token 明细；费用按 Venice `/models` 的 input/output 单 token价格快照计算。价格目录不可用时仍保存 token 与响应元数据，费用字段保持空值并记录可观察错误，不影响固定档位计费。

## Constraints

- 新增且仅新增一张 `experience.venice_chat_history` provider 明细表；不得复制主对话正文或把它发展成第二套会话事实源。
- 不自动开始实现；本任务完成规划后等待人工确认，再运行 `task.py start` 进入实现。
- 新增/修改测试文件需要在设计与验收标准中明确必要性；本任务因为涉及 shared 契约、DB 校验和生成链路，规划中允许补充针对纯函数/契约/适配器的回归测试。
- Venice 模型列表以实时 API 为准；不得把当前模型 ID 硬编码成静态清单。

## Acceptance Criteria

- [x] 规划文件覆盖 PRD、技术设计、实施计划、任务分解和研究记录。
- [x] 设计列出已检索的组件、hooks、helpers、contracts、features/repositories、DB 函数和迁移校验，并说明复用/扩展/不复用理由。
- [x] 设计覆盖超时、有限重试、幂等、并发、事务、降级、补偿、限流、容量和可观测性，且说明不适用项。
- [x] 设计给出兼容旧 `openrouter_model_id` 配置的迁移与回滚/forward-fix 方案。
- [x] 实施计划覆盖 Admin、shared、backend、migration、Railway/env 文档、自动验证和人工回归场景。
- [ ] TEST migration 验证 Venice 明细表 shape、FK/unique、grant/RLS、级联删除、重复写幂等和回滚。
- [ ] Venice 流式与非流式回归覆盖 prompt/completion/cached/reasoning token、价格快照、成本计算、延迟、完整元数据以及 usage 缺失降级。（流式及 metadata/cost 已覆盖；非流式和 usage 缺失自动回归待补）
- [x] 规划经确认后已执行 `task.py start` 并进入实现；原“保持 planning、不改产品代码”门禁已完成其阶段性职责。

## Progress Snapshot (2026-09-29)

- **总体判断：代码实现与自动验证约 90%，发布验收约 60%；任务继续保持 `in_progress`。**
- 已完成：provider-neutral shared 契约、旧 OpenRouter 配置兼容、Admin 双 provider 编辑/目录入口、Backend Venice 目录与生成路由、provider-aware 结算、Venice 独立明细表及 usage/token/成本映射、env/架构文档。
- 已通过：shared 100 tests；Admin 55 tests + build；Backend 全量 63 files / 533 tests，最终相关回归 4 files / 36 tests；受影响包 typecheck、root lint、legacy guard、migration filename check、`git diff --check`。
- 尚未完成：两个 migration 在 TEST 的单文件执行与证据留档、真实 Admin OpenRouter/Venice 目录同步、真实 Venice SSE/非流式 smoke、失败场景和日志脱敏人工验收。
- 自动测试缺口：provider directory adapter 的 401/429/5xx/invalid JSON/stale fallback 专项测试、Admin provider 切换与跨 provider 同 ID UI 回归、Venice 非流式和 usage 缺失回归；这些缺口不否定现有实现，但完成前不得把任务标记为 Done。
