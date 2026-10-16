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

## 图片广场定价与标签

- 模型页支持统一汇率、加价倍率、每元星尘数和实时公式预览；按各模型各档位本次填写的 USD 标准价重算，向上补整十。
- 标准价随模型目录保存草稿，刷新/重新打开后从草稿或已发布目录回填；旧目录没有标准价时保持空白。统一参数仍仅属于当前编辑器，离开或重新加载后恢复默认值。任一档位（含下架模型）缺失有效标准价时禁止批量重算，不部分覆盖。
- 单档/批量重算只更新上架价草稿，允许随后手工调整；仍需保存草稿并发布才生效，不回改历史订单，也不改变钱包兑换配置。
- 标签 ID 编辑使用独立 UI 行标识；编辑中允许暂时清空或重复，保存/发布仍由 shared 严格校验。

人工回归：连续输入标签 ID、中文名称、清空后重填、删除中间行再编辑；确认焦点和其他行内容保持。填写全部标准价后批量重算，缺失一项时确认按钮禁用；检查标准价保存后刷新回填、清空后保存、历史恢复、环境隔离、viewer 只读、窄屏换行及保存/发布区分。填写标准价不自动改变上架价；未保存的输入不会保留。

## 部署与验证

Vercel 配置可能来自包内 `vercel.json` 或根 `vercel.admin.json`，取决于项目 Root Directory，两者不会自动合并。发布前核对环境变量作用域、API/CORS、SPA rewrite 和 Node 版本。普通 branch Preview 与 `dev -> main` 发布 PR 使用 `VITE_ADMIN_TEST_API_URL` 指向稳定 TEST；目标分支为 `dev` 的功能 PR 自动绑定 `stminiapp-pr-<PR号>`。稳定 TEST 映射缺失或不是 HTTPS 时，Preview 构建会失败，避免发布登录后才报网络错误的页面。

适用门禁是 Admin typecheck/test/build、`pnpm lint:imports` 和 `git diff --check`。涉及 shared 契约或 `reply-renderer` 时，追加 shared/renderer 测试与所有消费者 typecheck。发布后在目标环境验证登录、环境标识、草稿保存、明确发布、历史恢复、错误保留和只读 viewer；TEST 结果不能代替 Production 验收。
