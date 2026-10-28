# 客户端首字交付 v4 发布核对

授权：用户本轮明确要求彻底替换旧标准，沿本会话“测试通过后直接上线”“先合 dev”的授权执行。原本地项目不改，隔离 checkout `/private/tmp/st-first-token-delivery`，基于 dev 2145103；生产基线 main 3062f2f。只发布本次变更，保留同期短剧/充值行为。

## 内容与风险

- v4 点击到首个有效 token 提交到 React 消息状态；接收时刻仅诊断，绝对10秒校验，首份终态锁定。去掉首字 DOM、滚动、裁剪、双绘制帧检测。
- 同原请求声明 method，同原 INSERT 落表，缺报不消失；Grafana 默认v4，成功分布严格早于上限，缺报/离页/其他失败分别展示。
- 已settled的调用元数据补录不重入收费；归档明细用永久dedup返回明确终态，未知冲突明确失败；原 failed/异常退避补齐。
- 系统超时免扣且释放额度，主动停止沿冻结报价/权益只结算一次。无新表/cron/后台扫描/额外请求，不调整4/2/10和AI调参。
- 真实网络/平台慢仍可能超时，切换口径不代表已达到1%；浏览器冻结不能保证提示在精确毫秒出现，恢复仍按原deadline裁决。

## 验证

- Backend全量106文件/1013测试；shared全量17文件/185测试。
- Frontend最终全量58文件/483测试通过，覆盖同批文字+done/error保留、连续发送、重生成新版承接、切会话退出旧观测。
- `pnpm -r typecheck`、Frontend/Admin构建通过。lint/imports/legacy/migrations通过；既有图片/大chunk警告无新增。
- PG17/PostgREST完整harness通过：v4首终态/重复无UPDATE/10秒边界/早收晚commit免扣/免费额度/主动停止/旧版本，真实102笔触发明细裁剪/永久dedup/未知唯一冲突/并发/账本。
- 手机聊天完整8项通过（390/320宽）；包含旧消息位置首字交付且滚回不二报、文字与错误同批返回仍保留并仅一次成功回报。
- TEST与生产4个相关RPC定义hash及service-only ACL一致；生产永久dedup查询EXPLAIN为两个既有唯一索引的BitmapOr，未执行业务查询或ANALYZE。
- Trellis context校验通过。模块全库索引重建被既有drama-experience.md缺“当前状态”章节阻塞；只同步本任务6个模块文档，不修无关短剧文档。

## 查询放大检查

用户追加要求：日常使用不能因本功能出现每分钟几万次数据库查询。新统计没有新 SELECT 或后台扫描：声明版本并入原 begin INSERT，正常每轮一次报告；网络失败最多复用原3次有限尝试，重复回执不会UPDATE。既有活动消息详情轮询频率不增加，终态文本保留只用客户端内存，不触发新refetch。

sync仍为30秒、不重叠、扫描并发2、每来源最多50、处理并发3、每轮最多9次供应商补录；失败延迟30/60/120/240秒且已settled不进入收费。上线后用已有日志统计请求/报告/扣费/回捞每分钟次数与重复ID，不通过额外定时数据库扫描来监控。

## 迁移与发布顺序

1. `20261028_client_committed_first_token.sql`，`20261028_llm_archived_charge_result.sql`逐文件TEST；仅替换函数，5秒lock/30秒statement，无回填/ACL扩张。
2. PR→dev，Quality Gate通过后按授权管理员合并；TEST应用版本/真实SSE与计费场景验证。
3. 生产两份migration逐文件，兼容旧应用；从最新main带入本次提交，CI通过后合并生产；核对Backend/Frontend实际SHA。
4. Grafana更新默认v4，实际查询面板；生产有限窗口复核新method与重复收费错误。未知/无样本如实记录。

恢复：兼容旧客户端，保留新函数和历史账务事实，回退应用/看板不删除数据、不重新扣免单。迁移锁超时或前置不符时停止，检查账本，禁止盲目force rerun。

## 最终路径与摘要

已完成跨层复核并修复发现的竞态；后续发布证据另记本地核对记录，避免只因记录状态循环触发生产构建。

文件清单（62个）：

- `.trellis/spec/backend/app/modules/business/conversation-generation.md`
- `.trellis/spec/backend/app/modules/business/wallet-payment.md`
- `.trellis/spec/database/supabase/modules/business/billing-payment.md`
- `.trellis/spec/database/supabase/modules/business/conversation-storage.md`
- `.trellis/spec/frontend/app/modules/business/conversation-ui.md`
- `.trellis/spec/shared/contracts/api-contracts.md`
- `.trellis/spec/shared/contracts/modules/business/conversation-contracts.md`
- `.trellis/tasks/10-28-client-ready-first-token/check.jsonl`
- `.trellis/tasks/10-28-client-ready-first-token/design.md`
- `.trellis/tasks/10-28-client-ready-first-token/implement.jsonl`
- `.trellis/tasks/10-28-client-ready-first-token/implement.md`
- `.trellis/tasks/10-28-client-ready-first-token/module-updates.json`
- `.trellis/tasks/10-28-client-ready-first-token/prd.md`
- `.trellis/tasks/10-28-client-ready-first-token/release-review.md`
- `.trellis/tasks/10-28-client-ready-first-token/task.json`
- `.trellis/tasks/10-28-client-ready-first-token/task.md`
- `README.md`
- `docs/ARCHITECTURE.md`
- `docs/first-token-fallback.md`
- `docs/grafana/README.md`
- `docs/grafana/chat-first-token.json`
- `packages/backend/src/features/conversations/generate.lifecycle.test.ts`
- `packages/backend/src/features/conversations/generate.ts`
- `packages/backend/src/features/generation/apply-charge.test.ts`
- `packages/backend/src/features/generation/apply-charge.ts`
- `packages/backend/src/features/generation/sync-job.test.ts`
- `packages/backend/src/features/generation/sync-job.ts`
- `packages/backend/src/infrastructure/repositories/ConversationHistoryRepository.cancel.test.ts`
- `packages/backend/src/infrastructure/repositories/ConversationHistoryRepository.ts`
- `packages/backend/src/infrastructure/repositories/GenerationObservationRepository.ts`
- `packages/backend/src/infrastructure/repositories/MiniappWalletRepository.test.ts`
- `packages/backend/src/infrastructure/repositories/MiniappWalletRepository.ts`
- `packages/backend/src/infrastructure/repositories/OpenRouterChatHistoryRepository.test.ts`
- `packages/backend/src/infrastructure/repositories/OpenRouterChatHistoryRepository.ts`
- `packages/backend/src/routes/conversations-thinking.test.ts`
- `packages/backend/src/routes/conversations.ts`
- `packages/frontend/src/app/chat/[characterId]/page.tsx`
- `packages/frontend/src/components/chat/chat-message-bubble.tsx`
- `packages/frontend/src/components/chat/chat-message-list.tsx`
- `packages/frontend/src/components/chat/chat-thinking.tsx`
- `packages/frontend/src/hooks/use-conversation-turn.test.ts`
- `packages/frontend/src/hooks/use-conversation-turn.ts`
- `packages/frontend/src/lib/api/conversation-stream.test.ts`
- `packages/frontend/src/lib/api/conversation-stream.ts`
- `packages/frontend/src/lib/api/conversations.ts`
- `packages/frontend/src/lib/merge-streaming-messages.test.ts`
- `packages/frontend/src/lib/merge-streaming-messages.ts`
- `packages/frontend/src/lib/perf/first-token-observation.test.ts`
- `packages/frontend/src/lib/perf/first-token-observation.ts`
- `packages/shared/migrations/20261028_client_committed_first_token.sql`
- `packages/shared/migrations/20261028_llm_archived_charge_result.sql`
- `packages/shared/migrations/tests/llm_archived_charge_result.sql`
- `packages/shared/migrations/tests/recoverable_chat_delivery.sql`
- `packages/shared/src/__tests__/telemetry-contract.test.ts`
- `packages/shared/src/api/conversations.ts`
- `packages/shared/src/api/generation-observations.ts`
- `packages/ui-tests/README.md`
- `packages/ui-tests/fixtures/data.ts`
- `packages/ui-tests/fixtures/server.ts`
- `packages/ui-tests/tests/chat.spec.ts`
- `scripts/check-legacy-references.mjs`
- `scripts/test-first-token-fallback-local.sh`
