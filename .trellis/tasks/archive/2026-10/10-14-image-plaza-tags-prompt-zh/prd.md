# 图片广场标签开关与种子提示词中文搜索

## Goal

为图片广场增加运营可控的标签能力开关；为 test 库 Civitai 种子作品补齐中文提示词（列表搜索 + 详情展示）；“用同款”仍传英文原文；用户自创作提示词原样出图、不做翻译/改写。

## Background

- 父任务：`10-10-image-plaza-v2`；分享自动打标：`10-14-image-plaza-share-auto-tags`。
- 状态：规划收敛完成，**尚未授权实施**（需用户确认本摘要后再 `task.py start`）。
- 翻译脚本仅针对 **test** 已注入的 civitai 数据。

## Confirmed Facts

| 事实 | 位置 |
| ---- | ---- |
| 已有 `image_plaza_enabled` / `image_plaza_tags`，无「标签 UI + 分享打标」总开关 | `features/image-plaza/config.ts` |
| Feed 返回启用标签；`/create` 渲染筛选 chip | `routes/image-plaza.ts`；`create/page.tsx` |
| 分享空 tags → Venice 打标（默认 `deepseek-v4-1-flash`，1s race + 后台补标） | `routes/image-plaza.ts`；`tagging.ts`；`config.ts` |
| 搜索仅 `snapshot->>prompt` ilike；详情渲染 `snapshot.prompt`；契约无中文场 | `repository.ts`；`work/[workId]/page.tsx`；`shared/api/image-plaza.ts` |
| Seed 英文在 `works.snapshot.prompt`；artifacts 无 prompt；出图原样传 `attempt.prompt`；`auto_optimize` 未改写上游 | `seed-import.ts`；`job.ts` |
| 批处理脚本模式：`packages/backend/src/scripts/*.ts` | `import-image-plaza-seed.ts` |

## Key Decisions

| ID | 结论 |
| -- | ---- |
| Q1 | **一个** `runtime_config` boolean 同时控制：广场标签筛选展示 + 分享路径模型自动打标 |
| Q2 | **B**：持久化中文；搜索可匹配；详情展示中文；同款只用英文 `prompt` |
| Q2b | 用户答「A」= 上一问首选项 **B1**：有译文时详情**只显示中文**；无译文回退英文 |
| Q3 | 翻译复用 Venice `VENICE_*` + `IMAGE_PLAZA_TAGGING_MODEL`（默认 `deepseek-v4-1-flash`） |
| Q4 | 用户自创作：出图 = 输入原文；本任务不引入翻译/服务端改写 |
| Q5 | 翻译脚本仅 test；筛选 civitai seed works；production 另授权 |
| Q6 | 搜索匹配 **`prompt_zh` OR `prompt`** |
| Q7 | 开关默认 **`true`**（保持现网标签/打标行为）；关 = fail-safe 关闭展示与打标 |
| Q8 | 新 key 走与 `image_plaza_enabled` 同类的 migration 种子 + Admin 可发布 boolean（最小接入，不做新运营页） |

## Requirements

### R1 标签功能开关

- 新增 `app_core.runtime_config` 键（建议名 `image_plaza_tags_feature_enabled`，实现以 design 为准）。
- **关**：Feed/bootstrap 不返回业务标签（可仅「全部」或隐藏 chip 行）；分享不调用打标 LLM；未传 tags 时作品 `tags=[]`。
- **开**：现有标签筛选 + 分享自动打标不变。
- 仅当值为显式 `false` 时关闭；键缺失或非 boolean 视为 **开**（Q7，兼容现网）。

### R2 Seed 提示词中文（test 脚本）

- 对新脚本：读 civitai seed `snapshot.prompt` → Venice 译中文 → 写入 `snapshot.prompt_zh`（不覆盖 `prompt`）。
- 幂等：已有非空 `prompt_zh` 跳过；失败可重跑；有界并发/超时；日志无完整 prompt/密钥。
- `--target test` 闸门；禁止无确认写 production。

### R3 搜索与详情

- `listWorks`：关键词 `ilike` 匹配 `prompt_zh` 或 `prompt`。
- 详情：展示 `prompt_zh ?? prompt`（只显示一档文案）。
- Feed 卡片仍不展示提示词正文。
- 同款/复制生成：会话 snapshot 与提交只用英文 `prompt`。

### R4 用户自创作

- Studio 发送路径不增加翻译或服务端改写步骤；出图 upstream 收到用户原文。

## Acceptance Criteria

| ID | 可观察结果 |
| -- | ---------- |
| AC01 | 开关关：无业务标签筛选；分享不调打标 LLM |
| AC02 | 开关开：标签筛选与分享自动打标与现网一致 |
| AC03 | test 脚本 dry-run/apply 写入 `prompt_zh`；重跑幂等 |
| AC04 | 中文关键词可搜到已译种子；英文关键词仍可命中 |
| AC05 | 详情有 `prompt_zh` 时只显示中文；无则显示英文 |
| AC06 | 同款输入框与提交为英文 `prompt` |
| AC07 | 用户自创作 prompt 与输入一致到达出图 upstream |
| AC08 | shared/backend/frontend 适用 typecheck；相关既有测试通过；脚本有 test 闸门 |

## Out of Scope

- production 批量翻译；UGC 批量翻译。
- Vision 打标；Admin 单条改译文编辑器。
- 实现真正的 `auto_optimize` LLM 改写。
- 聊天「看看TA」链路。
- Feed 卡片上展示提示词。

## Open Questions

无。
