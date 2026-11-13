# 实施计划

1. Migration `packages/shared/migrations/20261113_growth_prompt_states.sql` + `scripts/test-growth-prompt-states-migration.sh`（一次性 PG17 容器：重复执行、上限/间隔、并发不超额、ACL、级联）。
2. Shared：`api/growth-prompts.ts`（类型、请求 schema、事件常量），index 导出；shared 测试。
3. Backend：
   - `features/community/facts.ts`：`readCommunityFacts`（claim/exclusion/最近成员状态），`routes/community.ts` 入口改用它。
   - `features/community/welcome.ts`：欢迎语文本、发送与删除上一条；webhook 在 rewarded/首次 unmatched 后调用；`CommunityUpdate` 增加用户名字段。
   - `features/growth/prompt-rules.ts`（纯规则）、`infrastructure/repositories/GrowthPromptRepository.ts`、`routes/growth-prompts.ts`；app.ts 注册。
4. Frontend：`lib/api/growth-prompts.ts`、`lib/growth/prompt-visit.ts`、`components/growth/growth-prompt-host.tsx`、`components/growth/growth-prompt-card.tsx`；providers 挂载；conversation-stream onDone 累加；creator-invitation 接入单槽位。
5. UI 预览 fixture：扩展 `packages/ui-tests` 现有 fixture，新增场景「增长弹窗 · 进群」「增长弹窗 · VIP」，用于人工验收与截图。
6. 文档：backend/frontend/shared engagement-support 模块、database 模块说明、架构路由清单。

## 验证

- `pnpm --filter @miniapp/shared test`、`pnpm -r typecheck`、backend 相关测试（community、growth-prompts 规则）、`pnpm lint:complexity`、frontend build。
- 迁移脚本本地 PG17 跑通。
- 预览：390×844 截图两个弹窗、点击路径（进群打开链接、VIP 跳转返回）、输入框聚焦时不弹、同次打开不弹第二个。
- 失败路径：GET 503 → 不弹；POST 失败 → 不影响界面；欢迎语发送失败 → webhook 仍 2xx（单测覆盖文本/转义/分支）。
