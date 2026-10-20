# 文件移动清单

除另有说明外，目标文件名保持不变。

## 仓库脚本与运维

- `scripts/check-legacy-references.mjs` → `scripts/checks/check-legacy-references.mjs`
- `scripts/check-migration-filenames.mjs` → `scripts/checks/check-migration-filenames.mjs`
- `scripts/apply-repo-migration.sh` → `scripts/database/apply-repo-migration.sh`
- `scripts/apply-repo-migration.test.sh` → `scripts/database/apply-repo-migration.test.sh`
- `scripts/inspect-repo-migrations.sh` → `scripts/database/inspect-repo-migrations.sh`
- `scripts/openrouter-retirement-bootstrap.sql` → `scripts/database/openrouter-retirement-bootstrap.sql`
- `scripts/openrouter-retirement-local.mts` → `scripts/database/openrouter-retirement-local.mts`
- `scripts/platform-instruction-slot-windows-assert.sql` → `scripts/database/platform-instruction-slot-windows-assert.sql`
- `scripts/platform-instruction-slot-windows-bootstrap.sql` → `scripts/database/platform-instruction-slot-windows-bootstrap.sql`
- `scripts/test-admin-platform-instruction-slots-local.sh` → `scripts/database/test-admin-platform-instruction-slots-local.sh`
- `scripts/test-openrouter-original-fields-migration.sh` → `scripts/database/test-openrouter-original-fields-migration.sh`
- `scripts/test-openrouter-retirement-local.sh` → `scripts/database/test-openrouter-retirement-local.sh`
- `scripts/test-platform-instruction-slot-windows-local.sh` → `scripts/database/test-platform-instruction-slot-windows-local.sh`
- `scripts/test-vip-billing-migrations.sh` → `scripts/database/test-vip-billing-migrations.sh`
- `scripts/export-image-plaza-seed.mjs` → `scripts/data/export-image-plaza-seed.mjs`
- `scripts/import-character.ts` → `scripts/data/import-character.ts`
- `ops/image-plaza-seed-migration.md` → `ops/image-plaza/README.md`

## Admin components

以下文件从 `packages/admin/src/components/` 移入 `components/views/`：

- `AnnouncementsView.tsx`
- `CharacterCardsView.tsx`
- `InviteProgramView.tsx`
- `LoginPage.tsx`
- `OutreachCreditGrantView.tsx`
- `TextPostprocessView.tsx`
- `VipStrategyView.tsx`

以下文件从 `packages/admin/src/components/` 移入 `components/config/`：

- `ConfigValueEditor.tsx`
- `ImagePlazaConfigEditors.tsx`
- `InviteCenterConfigEditor.tsx`
- `InviteRewardRulesEditor.tsx`
- `LobbyPinnedCharactersEditor.tsx`
- `LobbyRankingParamsEditor.tsx`
- `ModelCatalogEditor.tsx`
- `ModelCatalogEditor.test.ts`
- `PaymentPromptDialogConfigEditor.tsx`
- `PlatformInstructionSlotRulesEditor.tsx`
- `ProviderRoutingConfigEditor.tsx`
- `RechargePageConfigEditor.tsx`
- `SystemInstructionsEditor.tsx`
- `WordCountTiersEditor.tsx`

## Admin lib

- `lib/adminApi.ts` → `lib/api/adminApi.ts`
- `lib/announcementsApi.ts` → `lib/api/announcementsApi.ts`
- `lib/inviteAdminApi.ts` → `lib/api/inviteAdminApi.ts`
- `lib/outreachCreditsApi.ts` 与测试 → `lib/api/`
- `lib/characterCards.ts` 与测试 → `lib/character-cards/`
- `lib/imagePlazaPricing.ts` 与测试 → `lib/image-plaza/`
- `lib/modelCatalogDiff.ts` 与测试、`lib/openRouterModels.ts` 与测试 → `lib/model-catalog/`
- `lib/textPostprocessApi.ts` 与测试、`textPostprocessPreview.ts` 与测试/worker、`textPostprocessSamples.ts`、`textPostprocessWorkbench.ts` 与测试 → `lib/text-postprocess/`
- `lib/vipStrategyForm.ts` 与测试 → `lib/vip/`

## Frontend

- `src/lib/chat-entry.ts` 与测试 → `src/lib/chat/`
- `src/lib/free-quota-dialog.ts` 与测试 → `src/lib/chat/`
- `src/lib/merge-streaming-messages.ts` 与测试 → `src/lib/chat/`
- `src/lib/recharge-redirect.ts` 与测试 → `src/lib/payment/`
- `src/lib/use-visual-viewport-height.ts` → `src/hooks/use-visual-viewport-height.ts`
- `src/components/icons.tsx` → `src/components/payment/icons.tsx`

## Backend 与 Shared

- `backend/src/lib/lobby-latest-badge.ts` 与测试 → `backend/src/features/lobby/`
- `backend/src/lib/lobby-ranking-refresh-job.ts` → `backend/src/features/lobby/`
- `backend/src/lib/notification-scope.ts` 与测试 → `backend/src/features/notifications/`
- `backend/src/lib/notifications.ts` → `backend/src/features/notifications/`
- `backend/src/lib/chat-image-storage.ts` → `backend/src/lib/storage/chat-image-storage.ts`
- `backend/src/lib/chat-voice-storage.ts` → `backend/src/lib/storage/chat-voice-storage.ts`
- `shared/src/lobby-featured.ts` → `shared/src/api/lobby-featured.ts`
- `shared/src/rich-reply-protocol.ts` → `shared/src/text-postprocess/rich-reply-protocol.ts`

## Reply Renderer

从 `packages/reply-renderer/src/` 移入 `src/rendering/`：

- `ReplyRenderer.tsx`
- `base-css.ts`
- `compose.tsx`
- `css-safety.ts`
- `markdown.ts`
- `nonce.ts`
- `scope-class.ts`
- `trusted-tree.tsx`
- `types.ts`

移入 `src/worker/`：

- `postprocess-job.ts`
- `postprocess.worker.ts`
- `worker-protocol.ts`
- `worker-scheduler.ts`

移入 `src/testing/`：

- `test-bundle-paths.ts`
- `test-global-setup.ts`

`src/index.ts` 与 `src/__tests__/reply-renderer.test.tsx` 保持原位，包级 export 不变。

## 路径敏感消费者

### 仓库脚本

- `package.json`：`lint:legacy`、`lint:migrations`、`test:migration-ledger`、`import-character`。
- `.github/workflows/ci.yml`：两个守卫说明路径。
- `.github/workflows/db-migrate.yml`：inspect/apply 的实际执行入口。
- 脚本内部：migration ledger test 对 apply/inspect 的互引；OpenRouter shell 对 bootstrap/mts 的互引；instruction-slot shell 对 bootstrap/assert 的互引；所有下沉脚本的 repo root 计算。
- 现行文档/spec：根 README、Architecture、migration README、Supabase migration spec、图片存储模块事实。
- 未归档任务中的后续可执行命令与 module update 生成材料；archive/snapshot 历史不改。

### Admin

- `src/App.tsx` 是组件和多数 lib helper 的集中消费者。
- 移动后的 views/config 继续互相引用 `ConfigValueEditor`、领域 helper 和 API helper，所有相对层级需同步。
- `textPostprocessPreview.ts` 与 `.worker.ts` 必须同目录；Worker triple-slash 路径多退一级。
- `textPostprocessPreview.test.ts` 的 `?raw` 保持 preview/worker sibling，引向 View 的路径改为 `../../components/views/TextPostprocessView.tsx?raw`。
- `vite.config.ts` 直接读取 `src/lib/preview-api.ts`，所以该文件保持原位。

### Frontend

- 聊天 helper：`hooks/use-chat-session.ts`、`hooks/use-conversation-turn.ts`、角色 gallery、聊天页/语音页、chats 页、chat model switcher 和 create studio。
- 支付 helper/icon：VIP/充值页面和支付组件。
- `recharge-redirect.test.ts` 下沉后，对 `api/*` 的 import 多退一级，对 `payment/*` 改为同目录。
- Next `app/` 文件只更新 import，不移动，URL 不变。

### Backend 与 Shared

- Lobby：`routes/characters.ts`、`app.ts`；refresh job 内部 db 与 lobby import。
- Notifications：`routes/notifications.ts`、`routes/payment.ts` 及测试、PaymentSettlement/Expire/FastReconciliation 相关测试中的 `vi.mock`。
- Storage：generation image upstream、image/voice generate 及 voice test mock；文件内部 Supabase/config/upstream 相对 import。
- Shared：`src/index.ts`、`api/lobby-pinned-characters.ts`、shared tests；包外消费者继续只用 `@miniapp/shared` 根入口。

### Reply Renderer

- `src/index.ts` 与 renderer 单测更新内部 import；Frontend/Admin 包级 import 不变。
- `vitest.config.ts` 更新 global setup。
- testing setup 的 package root 多退一级，esbuild worker entry 改为 `src/worker/postprocess.worker.ts`。
- Worker scheduler 与 worker 同目录，`new URL('./postprocess.worker.ts', import.meta.url)` 保持同义。
