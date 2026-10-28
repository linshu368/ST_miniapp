# T4 人工审阅包（未暂存/提交）

建议后续完整变更单元：`fix: restore OpenRouter history recovery and prepare release`。本次只生成可审查内容，不请求或执行提交/推送。批准前须阅读最终 diff/摘要、生产清单、T4 审计及 module-updates.json 的四份完整内容。

## 本次文件清单与 SHA-256

以下为当前内容摘要；本文件不包含自身摘要。任一文件变化后需更新审阅包。

- `.trellis/spec/backend/app/data-reliability-and-security.md` — `002838f7d3256b994a187cb0428095f763f91a0a8db222183d4bf1388542d939`
- `.trellis/spec/database/supabase/migrations-and-rollbacks.md` — `c8b2c1365d9ae7d4abefb9690450c697abe47a444781157198bb332cfeac91ad`
- `.trellis/tasks/10-15-openrouter-history-extract/check.jsonl` — `b27753d1e671f354d3fa417b80e651621b7dd87060c42c7dcb089da59e9343c0`
- `.trellis/tasks/10-15-openrouter-history-extract/implement.jsonl` — `f227bc8eab7c05a05d5a6edb79d1b878dc83ac931cd3c69379c0582644d03286`
- `.trellis/tasks/10-15-openrouter-history-extract/implement.md` — `df674f0cb47565db0e01913c4a9536c626ef824c0b8de0b0983ee327207e1669`
- `.trellis/tasks/10-15-openrouter-history-extract/module-updates.json` — `c91aba7d1094058c995c6447fe8e534946021771fd77bc5384a56f09baa45f58`
- `.trellis/tasks/10-15-openrouter-history-extract/prd.md` — `03f414c0aed81b1d38ee9ce439f9bb9dc3cb7eb37551e148c95b635fdc496011`
- `.trellis/tasks/10-15-openrouter-history-extract/production-release-checklist.md` — `0140d77276e45819077adddea3ecb86ff8fa981fa0dab5833cd878dac78af26b`
- `.trellis/tasks/10-15-openrouter-history-extract/research/t4-final-audit-2026-10-16.md` — `6cbea2e077baac75300049cd2b54bde06a29c28d81bd214f9ebbd9ffb705f033`
- `.trellis/tasks/10-15-openrouter-history-extract/task.json` — `d9eec96676edd687d7372b9defa4778c1d10df193da383da5604d6932c73ccee`
- `.trellis/tasks/10-15-openrouter-history-extract/task.md` — `c9917700c57dbef549128e86380c1d7499557181daaae788705a01fb354d9fb0`
- `README.md` — `8b933a44528484ebba9aa9b9bd0883bf6a92060320fa21c628bd6e8b7801ae16`
- `docs/ARCHITECTURE.md` — `634c40e5ce75130755e9d8a92a924352cdcde83aca39143187d3775daa839ce1`
- `packages/backend/src/features/generation/openrouter-metadata.test.ts` — `bd5177b551160d00786bed742755912d5ddffad3ef5718ca101b01ed817ca00c`
- `packages/backend/src/features/generation/openrouter-metadata.ts` — `7b7d50798d8e804d6610e56df63a444c23111e745a92914af669ce202b86b13a`
- `packages/backend/src/features/generation/sync-job.test.ts` — `3f2cd59eecad38d1ec1a5a83d3a90a511e292fa7309cc6a111b9c6153c733484`
- `packages/backend/src/features/generation/sync-job.ts` — `94b2dc50578fccbf6d0e8218956e921ceda22d32bb1decd2cdd95cd0703ffbc7`
- `packages/backend/src/infrastructure/repositories/ConversationHistoryRepository.cancel.test.ts` — `be032a449eedf0847386a6e4d668cc47c746c129fb6fca62f9ac6a4788a1d426`
- `packages/backend/src/infrastructure/repositories/ConversationHistoryRepository.ts` — `33c693fe36299808dacceb36fcdc2d43b3340dba806c00855907f93f5add5c89`
- `packages/backend/src/infrastructure/repositories/OpenRouterChatHistoryRepository.test.ts` — `27b94bb3076ac38a63b7f001ba7878c0a7ca2941ad0de6f8c63c0a6f91657d46`
- `packages/backend/src/infrastructure/repositories/OpenRouterChatHistoryRepository.ts` — `8b19f5670092e51bd1696d3ab5342712e91996bc79c153a14c0c17c86cc6fa11`

## 验证与风险

Backend 669 tests、Shared 139 tests、workspace typecheck/build、lint/import/legacy/migrations、PG17 migration、migration-ledger、task/context/module 校验与 diff 检查通过。细节见 task.md。四份既有 migrations 未改动；无新增测试文件、公开契约、依赖或远端写入。

T4 三项 P1 已本地修复：计费/Venice 恢复入口、缺失占位恢复、raw JSON 内容隔离。PR/部署仍为 caebc0c6，不含 T4 补丁；T3 真机失败场景、Production 容量/窗口预检与 PR Review 402 门禁未完。Production 未授权，不能迁移/合并/main 部署。

## 排除的既有工作

保留且不纳入建议提交：.trellis/tasks/10-12-admin-preview-api-guard/ 下原有 prd.md/task.md/design.md/implement.md 改动，以及 docs/后处理规则-实际应用问题汇总.md。未重置、覆盖或暂存。

当前 Trellis 保持 in_progress；module-updates.json 仅准备，未 apply/archive。
