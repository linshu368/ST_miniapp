# @miniapp/admin

内部运营 SPA，使用 Vite、React 18、Ant Design、Refine 和 Supabase session。开发端口为 `3003`。

## 本地运行

```bash
pnpm --filter @miniapp/admin dev
pnpm --filter @miniapp/admin typecheck
pnpm --filter @miniapp/admin test
pnpm --filter @miniapp/admin build
```

复制 `.env.example` 后仅填写目标环境的公开 URL 和 anon key。所有 `VITE_*` 都会进入浏览器 bundle；不得放入 service-role、数据库 URI、Admin secret 或其他凭据。TEST 与 Production session、API base 和 Supabase client 必须隔离，Preview 不得默认指向 Production 写接口。

## 回复富文本规则

导航中的「回复富文本规则」提供三栏工作台：规则列表、编辑器和真实渲染预览。工作台复用 `@miniapp/shared` 的 source/artifact 契约与编译规则，以及 `@miniapp/reply-renderer` 的最终渲染语义。

- 保存只更新草稿，不切换正式版本；发布只允许明确的已保存草稿。
- 发布和回滚带 CAS 前提与 `request_id`。超时或结果未知时先使用“请求恢复”读取权威结果，不自动重试 mutation。
- 历史回滚创建新版本，不修改旧快照；System Instructions 仍由独立配置入口管理。
- 预览编译/执行在可终止 Worker 中完成；流式模拟阶段显示原文，完整或重置终态才运行 renderer。
- source/正文、token、session 和完整错误响应不得进入日志。Preview 操作前必须确认环境；Production 写操作需要独立授权。

## 部署与验证

Vercel 配置可能来自包内 `vercel.json` 或根 `vercel.admin.json`，取决于项目 Root Directory，两者不会自动合并。发布前核对环境变量作用域、API/CORS、SPA rewrite 和 Node 版本。

适用门禁是 Admin typecheck/test/build、`pnpm lint:imports` 和 `git diff --check`。涉及 shared 契约或 `reply-renderer` 时，追加 shared/renderer 测试与所有消费者 typecheck。发布后在目标环境验证登录、环境标识、草稿保存、明确发布、历史恢复、错误保留和只读 viewer；TEST 结果不能代替 Production 验收。
