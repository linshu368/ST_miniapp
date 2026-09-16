# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status  | Task                                                                              | Files / Scope                                                                   | Depends On | Verification                                                                    |
| --- | ------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------- |
| T1  | Done    | 定义图片配置、描述、attempt、错误、200 字 prompt 上限与会话批量查询契约           | `packages/shared/src/api/images.ts`、shared exports                             | -          | `pnpm --filter @miniapp/shared typecheck`；`pnpm --filter @miniapp/shared test` |
| T2  | Done    | 增加 experience 图片 attempt 表、索引、领取/收口 RPC 与 Storage bucket 策略       | `packages/shared/migrations/*.sql`                                              | T1         | test 环境单文件迁移；shape/RLS/grant/锁/回滚核验                                |
| T3  | Done    | 准备角色卡取数、`character_persona_and_style` 读取和分镜师 prompt 资源            | backend repositories、`features/image/` prompt 资源                             | T1,T2      | 字段存在/缺失场景；角色锚点不伪造；backend typecheck                            |
| T4  | Done    | 扩展 generation 的 DeepSeek 写稿/翻译与 Grok/Liaobots 生图能力                    | `packages/backend/src/features/generation/`、`features/image/`、storage/config  | T3         | DeepSeek 配置复用结论；Grok 配置缺失/成功/失败人工接口回归                      |
| T5  | Doing   | 增加图片配置、默认写稿/自定义中文直出、翻译后生图、attempt 查询/创建路由与 runner | backend routes、`app.ts`、runtime config                                        | T4         | 默认/自定义路径、200 字、翻译、202/402/409/422/5xx、重启恢复、并发与超时场景    |
| T6  | Done    | 按图 1~9 增加 React Query API、图片面板状态机、消息挂图、大图预览与充值回跳       | frontend `lib/api`、chat page/components                                        | T1,T5      | frontend typecheck/test/lint/build；图 1~9 与 Telegram WebView 人工验收         |
| T7  | Blocked | 运行全链路验收、记录 test 环境发布顺序与停止/恢复条件                             | frontend/backend/shared、migration runbook                                      | T2-T6      | 本地门禁/故障矩阵已记录；真实 test provider/DB/真机证据待补                     |
| T8  | Done    | 按“代码已落地、开关默认关、真实上线待验收”更新架构与模块现状 spec                 | `docs/ARCHITECTURE.md`、module spec/module-updates                              | T7         | module knowledge check；文档链接检查                                            |
| T9  | Done    | 增加 description 调用前 draft 落库、敏感 userPrompt 字段与同一行确认推进          | shared migration/contracts、backend image repository/routes、frontend image API | T5,T6      | draft 状态/约束、调用前提交、失败保留、确认幂等、consumer typecheck             |
| T10 | Done    | 将图片写稿/翻译文本模型 URL/API key/model 改为 runtime 可配并保留 DeepSeek 默认   | backend image config/generation、shared migration、发布文档                     | T9         | runtime tuple/整组回退、参数不变、secret 泄露扫描、test 环境切换验证            |
| T11 | Blocked | 执行追加变更全链路验证并同步架构/模块事实                                         | backend/frontend/shared、migration runbook、module spec                         | T9,T10     | 既有门禁、test migration、失败矩阵、灰度/停止/恢复证据                          |

## Execution Log

- 2026-09-11：当前任务仅完成规划与评审材料，不执行 T1~T8，不运行 `task.py start`。
- 2026-09-11：追加需求已纳入规划：图片链路分默认写稿后出图与自定义原文出图；prompt 上限 200 字；当时图片模型选择保留评审空位，2026-09-12 已更新为 Grok/Liaobots。
- 2026-09-11：追加前端交互稿要求：按图 1~9 覆盖入口、写稿加载、确认、自定义、出图加载、ready 卡、放大预览、失败和余额不足充值。
- 2026-09-12：追加外部生图流水线参考：默认路径用分镜师 prompt + DeepSeek 写中文短文；默认/自定义均先翻译英文再调用 Grok/Liaobots；Grok 配置来自 `LIAOBOTS_AUTH`、`LIAOBOTS_BASE`、`GROK_MODEL`。
- 按需求不新增测试文件；“不写新测试”不豁免既有检查与人工失败路径验证。
- 2026-09-14：完成 T1 shared 契约：新增 `packages/shared/src/api/images.ts` 与根导出；复用 200 字 shared 常量、裸 402 余额错误体口径和会话批量查询模式；验证通过 `pnpm --filter @miniapp/shared typecheck`、`pnpm --filter @miniapp/shared test`。
- 2026-09-14：T2 migration SQL 已完成静态校验：新增 `20260914_chat_message_images.sql` 与 `20260914_chat_message_images_rollback.sql`，覆盖 attempt 表、claim RPC、settlement RPC、Storage bucket、runtime config、admin managed keys 与 rollback guard；验证通过 `pnpm lint:migrations`、`git diff --check`、secret 关键字扫描。本机无 `psql`，且远端迁移必须按项目流程通过 Database Migration workflow 单文件执行，test DB shape/RLS/grant/锁/回滚核验待人工执行记录。
- 2026-09-14：用户确认 `20260914_chat_message_images.sql` 已执行，T2 进入完成状态；后续仍需在 T7 记录 test 环境 shape/RLS/grant/锁等待与 rollback guard 证据。
- 2026-09-14：完成后端 T3-T5 第一阶段：扩展 `CharacterCardRepository.character_persona_and_style`；新增 `features/image/config.ts`、`upstream.ts`、`generate.ts`、`job.ts`、`lib/chat-image-storage.ts`、`routes/images.ts`；注册图片 route 与 DB worker；钱包消费明细纳入 `image_generation` ledger。验证通过 `pnpm --filter @miniapp/backend typecheck`、`pnpm --filter @miniapp/backend test`、`pnpm --filter @miniapp/shared typecheck`、`pnpm --filter @miniapp/shared test`、`pnpm lint:migrations`。Grok/DeepSeek 真实调用、运行时开关和 202/402/409/422/超时人工回归待 test secret 配置后执行。
- 2026-09-14：完成 T6 前端接入：新增 `packages/frontend/src/lib/api/images.ts` React Query hooks、`ChatMessageImageFooter` 图片 Sheet/失败/余额不足/预览组件，并在聊天页 `renderFooter` 中按“图片在上、语音在下”组合；生成成功后刷新 session images 与 wallet。验证通过 `pnpm --filter @miniapp/frontend typecheck`、`pnpm --filter @miniapp/frontend test`、`pnpm --filter @miniapp/frontend lint`、`pnpm --filter @miniapp/frontend build`、`pnpm -r typecheck`。本机 pnpm store 曾出现 Next 包缺文件，已按 `pnpm install --force` 重取依赖后复验通过；Telegram WebView 与图 1~9 逐项人工验收仍归入 T7。
- 2026-09-14：完成 T4 可靠性收口：DeepSeek/Grok 上游适配移动到 `features/generation/image-upstream.ts`；provider dispatch 前保持 leased，dispatch 后禁止自动重投；下载增加 HTTPS/redirect/私网/流式字节防护；结算余额竞争失败补偿删对象，结算响应未知保留 storing 等待幂等对账。backend typecheck/test 通过。
- 2026-09-14：T7 本地可执行门禁与源码故障矩阵完成，记录于 `research/test-acceptance-2026-09-14.md`。shared 43、backend 401、frontend 72 项既有测试及各包 typecheck、frontend lint/build、legacy/migration guard 均通过；真实 DeepSeek/Grok、test DB 并发/账务/Storage 和 Telegram 图 1~9 仍受环境限制，T7 标记 Blocked，功能开关必须保持关闭。
- 2026-09-14：完成 T8 当前事实同步：更新 `docs/ARCHITECTURE.md`、图片 feature guide 和五个 module spec，明确“代码/test migration 已落地、runtime 默认关闭、未宣称生产上线”；生成并校验 `module-updates.json`，`module_knowledge.py check` 通过。
- 2026-09-16：追加规划 T9-T11。用户确认采用“description 调用前在 `chat_message_images` 创建 draft，保存完整 userPrompt，确认时复用同一行”的生命周期；原“不持久化描述预览/确认时新建 attempt”决策作废。
- 2026-09-16：图片写稿与翻译改为共用 `app_core.runtime_config.image_text_model_config` 单行 JSON 中的 URL/API key/model；对象完整有效时使用 runtime tuple，否则整组回退现有 `config.voice.draft` DeepSeek 参数。API key 为 backend-only secret，不纳入 Admin managed config，其他请求参数保持不变。
- 2026-09-16：完成 T9-T10 最小范围实现，仅改图片 description/translation、对应图片 attempt 契约与前端 draft id 传递；未改聊天生成、语音、计费、Grok/Replicate 或其他业务链。shared/backend typecheck、57/435 项既有测试、migration naming 与 diff check 通过；frontend typecheck 仅被工作区缺失既有 `posthog-js` 依赖阻断。远端 migration 与真实上游切换未执行，T11 保持 Blocked。
