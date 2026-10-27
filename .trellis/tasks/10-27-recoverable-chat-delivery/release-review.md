# 可恢复交付发布审查

用户授权：2026-10-27“整条链路改好…计费核对…测试通过后直接上线”。本次按该授权提交、推送、TEST→生产迁移/发布和CI通过后管理员合并，不重复请求许可。

## 行为与兼容
离页/后台/翻历史不取消；返回同一轮可见活动内容/首字检查点/最终回复。兜底有效首字不再等待身份存储才发出，存储资格仍在结算前强制确认。真截止免费、正常离页完成原价原权益一次、主动停止一次；缺报保守免单、旧终账不追扣。新服务保护旧客户端错误自动取消。新策略显式冻结，旧服务不会误启用。

## 验证
已通过本地完整前端392测试、后端897测试、shared测试、全部typecheck、前端/运营构建。真实PG17完整钱包/VIP/免费额度/并发/账本套件通过，新增恢复与Grafana查询同库验证通过。浏览器/远端TEST与最终发布记录后续补齐。

## 发布与恢复
单文件迁移先TEST后生产，核对schema/ACL；后端再前端，Grafana v3跟随。保留旧列/函数签名，不回填、不新增cron。回滚代码保留迁移与账单，不把既有免单重新打开。数据库写失败不旁路结算，服务阻塞根因由工程独立排查。1%需生产新口径样本验证。

附加检查：跨包imports/migrations/legacy检查、21模块baseline、diffcheck通过。修复了一个既有真实60ms计时测试在并发构建下偶发越界的问题，改用受控时钟，保留原30/20/60ms边界。数据库TEST/生产迁移前4个关键函数hash一致。

## 最终提交文件

- `.trellis/tasks/10-27-recoverable-chat-delivery/check.jsonl`
- `.trellis/tasks/10-27-recoverable-chat-delivery/design.md`
- `.trellis/tasks/10-27-recoverable-chat-delivery/implement.jsonl`
- `.trellis/tasks/10-27-recoverable-chat-delivery/implement.md`
- `.trellis/tasks/10-27-recoverable-chat-delivery/module-updates.json`
- `.trellis/tasks/10-27-recoverable-chat-delivery/prd.md`
- `.trellis/tasks/10-27-recoverable-chat-delivery/release-review.md`
- `.trellis/tasks/10-27-recoverable-chat-delivery/task.json`
- `.trellis/tasks/10-27-recoverable-chat-delivery/task.md`
- `packages/backend/src/features/conversations/active-delivery.test.ts`
- `packages/backend/src/features/conversations/active-delivery.ts`
- `packages/shared/migrations/20261027_recoverable_chat_delivery.sql`
- `packages/shared/migrations/tests/recoverable_chat_delivery.sql`
- `.trellis/spec/backend/app/data-reliability-and-security.md`
- `.trellis/spec/backend/app/modules/business/conversation-generation.md`
- `.trellis/spec/database/supabase/modules/business/billing-payment.md`
- `.trellis/spec/database/supabase/modules/business/conversation-storage.md`
- `.trellis/spec/frontend/app/api-dataflow-and-state.md`
- `.trellis/spec/frontend/app/modules/business/conversation-ui.md`
- `.trellis/spec/shared/contracts/api-contracts.md`
- `.trellis/spec/shared/contracts/modules/business/conversation-contracts.md`
- `README.md`
- `docs/ARCHITECTURE.md`
- `docs/grafana/chat-first-token.json`
- `packages/backend/src/features/conversations/generate-postprocess.test.ts`
- `packages/backend/src/features/conversations/generate.lifecycle.test.ts`
- `packages/backend/src/features/conversations/generate.ts`
- `packages/backend/src/features/conversations/sse.test.ts`
- `packages/backend/src/features/conversations/sse.ts`
- `packages/backend/src/features/generation/execute.test.ts`
- `packages/backend/src/features/generation/execute.ts`
- `packages/backend/src/features/generation/first-token-fallback.test.ts`
- `packages/backend/src/features/generation/first-token-fallback.ts`
- `packages/backend/src/features/generation/types.ts`
- `packages/backend/src/infrastructure/repositories/ConversationHistoryRepository.ts`
- `packages/backend/src/infrastructure/repositories/GenerationObservationRepository.ts`
- `packages/backend/src/platform/provider-routing.ts`
- `packages/backend/src/routes/conversations.ts`
- `packages/frontend/src/app/chat/[characterId]/page.tsx`
- `packages/frontend/src/hooks/use-conversation-turn.test.ts`
- `packages/frontend/src/hooks/use-conversation-turn.ts`
- `packages/frontend/src/lib/api/conversation-stream.ts`
- `packages/frontend/src/lib/perf/first-token-observation.test.ts`
- `packages/frontend/src/lib/perf/first-token-observation.ts`
- `packages/shared/src/api/conversations.ts`
- `packages/shared/src/api/generation-observations.ts`
- `scripts/test-first-token-fallback-local.sh`
