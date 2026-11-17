# 竞争交付发布核对

授权：用户本次明确要求修复后测试通过先合dev再上线，并澄清赢家出现立即停止败方、仅保存已收片段，不等待完整回复。原本地项目未改。基线dev6457fdb/main3ec7935；隔离checkout /private/tmp/st-first-token-delivery。

## 本次行为

- 4秒是兜底启动阈值；首发不取消，两路同一10秒首字截止，赢家只选一次并立即abort/cancel另一方。
- 2秒字段沿用但明确为兜底预留时间；同型号静默单POST至总截止，明确失败只允许一次顺序重试。
- 仅赢家走现有reply/quote/charge_id结算；系统超时免扣、主动停止和离页恢复不变。
- 败方只保存已收到文本/公开思考，各2048字符，异步终态一次、不再drain、不发用户/不进上下文/不另计费。
- 每attempt最多dispatch+terminal两次observe；删除旧首发额外供应商元数据补读。无新表/索引/cron/轮询/逐token写入。
- 单赢家数据库CAS保留；合法迟到fallback意图可补记录但不得改winner/业务终态/费用。Grafana只读旧指标列，不能读诊断片段。

## 验证

- Backend全量106文件/1032测试；竞争模块54项与execute70项，双方胜、同批、精确截止、取消、慢DB、迟到headers、Unicode边界已覆盖。
- Admin121项/shared185项、全workspace typecheck、Frontend/Admin构建、lint/imports/legacy/migrations通过。
- PG17/PostgREST完整harness通过：5项真实REST、两连接CAS、并发扣一次、primary回赢、已结算/已超时后的late intent、诊断首次锁定/限长/拒读/JSON null/重复无UPDATE、既有v4/钱包/VIP/账本。
- React静态渲染确认运营新标签；Grafana7组查询逻辑、变量、刷新不变，只改语义说明与输出别名。跨层独立复核关闭late prepare及Unicode两项阻断。
- 测试并非1%目标已经达成，也不代表供应商能撤回已生成token费用。

## 发布/恢复

单文件20261028_first_token_race.sql先TEST，再合dev和真实TEST流/最终账单验收；CI通过后生产同迁移、从main仅带本次commit发生产。权限收窄与nullable列兼容旧服务；无历史回填，CHECK NOT VALID避免旧行扫描，新写强制校验；5秒锁/30秒语句上限。回退应用保留列和原账务，不恢复正文读取权限。线上用有限日志和统计增量核验，不新建监控任务。

## 最终文件清单

- `.trellis/spec/admin/app/modules/business/operations.md`
- `.trellis/spec/backend/app/data-reliability-and-security.md`
- `.trellis/spec/backend/app/modules/business/conversation-generation.md`
- `.trellis/spec/database/supabase/modules/business/conversation-storage.md`
- `.trellis/spec/shared/contracts/api-contracts.md`
- `.trellis/spec/shared/contracts/modules/business/conversation-contracts.md`
- `.trellis/tasks/10-28-first-token-race/check.jsonl`
- `.trellis/tasks/10-28-first-token-race/design.md`
- `.trellis/tasks/10-28-first-token-race/implement.jsonl`
- `.trellis/tasks/10-28-first-token-race/implement.md`
- `.trellis/tasks/10-28-first-token-race/module-updates.json`
- `.trellis/tasks/10-28-first-token-race/prd.md`
- `.trellis/tasks/10-28-first-token-race/release-review.md`
- `.trellis/tasks/10-28-first-token-race/task.json`
- `.trellis/tasks/10-28-first-token-race/task.md`
- `README.md`
- `docs/ARCHITECTURE.md`
- `docs/first-token-fallback.md`
- `docs/grafana/README.md`
- `docs/grafana/chat-first-token.json`
- `packages/admin/src/components/FallbackConfigEditor.tsx`
- `packages/admin/src/lib/configSchemas.test.ts`
- `packages/admin/src/lib/modelCatalogDiff.test.ts`
- `packages/admin/src/lib/modelCatalogDiff.ts`
- `packages/backend/src/features/conversations/generate.ts`
- `packages/backend/src/features/generation/execute.test.ts`
- `packages/backend/src/features/generation/first-token-fallback.test.ts`
- `packages/backend/src/features/generation/first-token-fallback.ts`
- `packages/backend/src/infrastructure/repositories/GenerationObservationRepository.ts`
- `packages/shared/migrations/20261028_first_token_race.sql`
- `packages/shared/migrations/tests/recoverable_chat_delivery.sql`
- `packages/shared/src/__tests__/models.test.ts`
- `packages/shared/src/api/models.ts`
- `scripts/test-first-token-fallback-local.sh`
