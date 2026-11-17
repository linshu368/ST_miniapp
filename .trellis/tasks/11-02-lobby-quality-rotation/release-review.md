# 推荐评分与24小时全量轮换发布清单

用户已授权本次管理员发布，随后明确不要灰度和启用开关、适配最新生产角色创作数据、分开换一批与许愿入口。当前合并基线main85780e91，保留启动拆分、创作者数据、心愿墙等全部已发布内容；main请求只新增本功能差异。

## 最终行为

上线直接对全体用户启用，默认24小时；运营只保留间隔/重复上限/探索数量。旧门控字段仅兼容存储，不控制实际启用。换一批留推荐栏右侧，许愿在真实列表末尾轻提示，搜索空态独立入口保留。

## 验证与发布

全包typecheck通过；固定评分/轮换86项（包含真实PG17），shared236项，创作相关路由60项，Admin相关20项，fixture10项。合并后手机端大厅/创作数据/心愿39项通过，末尾入口定向验收390/320共4项通过。最终提交再经远端完整质量门禁和两端构建。

TEST与production迁移均已成功并核验权限；迁移checksum保持513072fab7db92e27492786442128bd87b164d35e20fd346b7510cc46272677c，不重写已执行SQL、不覆盖运营原评分配置。原#602已合dev；适配补充先经dev，再合独立#603发布main。新版本核验commit、健康、新路由与qualified-v1刷新。无需运营登录或开关操作。回退使用兼容旧应用，保留新增表及可信证据。

## main相对文件清单

- `.trellis/spec/admin/app/modules/business/operations.md`
- `.trellis/spec/backend/app/modules/business/character-lobby.md`
- `.trellis/spec/database/supabase/modules/infrastructure/schema-security.md`
- `.trellis/spec/frontend/app/modules/business/character-lobby.md`
- `.trellis/spec/shared/contracts/modules/business/character-lobby-contracts.md`
- `.trellis/tasks/11-02-lobby-quality-rotation/check.jsonl`
- `.trellis/tasks/11-02-lobby-quality-rotation/design.md`
- `.trellis/tasks/11-02-lobby-quality-rotation/implement.jsonl`
- `.trellis/tasks/11-02-lobby-quality-rotation/implement.md`
- `.trellis/tasks/11-02-lobby-quality-rotation/module-updates.json`
- `.trellis/tasks/11-02-lobby-quality-rotation/prd.md`
- `.trellis/tasks/11-02-lobby-quality-rotation/release-review.md`
- `.trellis/tasks/11-02-lobby-quality-rotation/task.json`
- `.trellis/tasks/11-02-lobby-quality-rotation/task.md`
- `.trellis/tasks/11-02-lobby-quality-rotation/validation.md`
- `.trellis/tasks/11-02-lobby-score-qualified-users/check.jsonl`
- `.trellis/tasks/11-02-lobby-score-qualified-users/design.md`
- `.trellis/tasks/11-02-lobby-score-qualified-users/implement.jsonl`
- `.trellis/tasks/11-02-lobby-score-qualified-users/implement.md`
- `.trellis/tasks/11-02-lobby-score-qualified-users/module-updates.json`
- `.trellis/tasks/11-02-lobby-score-qualified-users/prd.md`
- `.trellis/tasks/11-02-lobby-score-qualified-users/task.json`
- `.trellis/tasks/11-02-lobby-score-qualified-users/task.md`
- `.trellis/tasks/11-02-lobby-score-qualified-users/validation.md`
- `README.md`
- `docs/ARCHITECTURE.md`
- `package.json`
- `packages/admin/src/components/LobbyPinnedCharactersEditor.tsx`
- `packages/admin/src/components/LobbyRankingParamsEditor.tsx`
- `packages/admin/src/lib/configSchemas.test.ts`
- `packages/admin/src/lib/configSchemas.ts`
- `packages/backend/package.json`
- `packages/backend/src/app.ts`
- `packages/backend/src/features/lobby/featured.ts`
- `packages/backend/src/features/lobby/pinned-characters.ts`
- `packages/backend/src/features/lobby/ranking-score.ts`
- `packages/backend/src/features/lobby/ranking-stats.integration.test.ts`
- `packages/backend/src/features/lobby/ranking-stats.ts`
- `packages/backend/src/features/lobby/recommendation-ranking.test.ts`
- `packages/backend/src/features/lobby/recommendation-ranking.ts`
- `packages/backend/src/features/lobby/recommendation-repository.ts`
- `packages/backend/src/features/lobby/recommendation.ts`
- `packages/backend/src/lib/lobby-ranking-refresh-job.ts`
- `packages/backend/src/routes/lobby-recommendation.test.ts`
- `packages/backend/src/routes/lobby-recommendation.ts`
- `packages/frontend/src/components/characters/character-gallery.tsx`
- `packages/frontend/src/components/characters/use-lobby-exposures.ts`
- `packages/frontend/src/lib/api/lobby-recommendations.ts`
- `packages/frontend/src/lib/lobby-recommendation-state.test.ts`
- `packages/frontend/src/lib/lobby-recommendation-state.ts`
- `packages/frontend/src/lib/lobby-return.ts`
- `packages/frontend/src/lib/roleplay-navigation.ts`
- `packages/shared/migrations/20261102_lobby_quality_rotation.sql`
- `packages/shared/migrations/README.md`
- `packages/shared/src/api/characters.ts`
- `packages/shared/src/api/lobby-pinned-characters.ts`
- `packages/shared/src/api/lobby-ranking-params.ts`
- `packages/shared/src/api/lobby-recommendation.ts`
- `packages/shared/src/index.ts`
- `packages/ui-tests/README.md`
- `packages/ui-tests/fixtures/data.ts`
- `packages/ui-tests/fixtures/server.test.ts`
- `packages/ui-tests/fixtures/server.ts`
- `packages/ui-tests/tests/creator.spec.ts`
- `packages/ui-tests/tests/fixtures.ts`
- `packages/ui-tests/tests/roleplay.spec.ts`

最终内容以该提交相对main的PR diff为准；未识别无关改动：无。
