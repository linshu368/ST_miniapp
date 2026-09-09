# 实施计划

> 本任务当前只完成规划，保持 `planning`。以下内容经人工评审并明确同意实施后，才可运行 `task.py start` 和修改产品代码。

## 阶段 0：评审与环境确认

1. 评审 PRD/design，确认 private bucket、无内容审核风险、签名 URL时效和 Telegram 实际 webhook。
2. 在 Supabase MCP/控制台明确连接的是 test 项目后，只读采集 `cs_platform.support_messages/outreach_messages`、索引、RLS/grants 和 bucket 实况；不得读业务行。
3. 记录 test 与 production 的未知差异，分开制定 migration 执行单。

**门禁**：任何环境目标不清楚、内容审核风险未接受或 Bot 配置不可测试时停止。

## 阶段 1：契约与数据库兼容层

1. 先扩展 `packages/shared/src/api/support.ts`、`cs-platform.ts` 的图片消息/请求 DTO 和 runtime 校验。
2. 增加契约测试：text 兼容、image 完整性、null/unavailable URL、非法 MIME/size。
3. 新建唯一 migration：扩展两消息表、调整 body/content 约束、补 Telegram 入站幂等索引、创建 private bucket，并明确 RLS/grants。
4. 在 test 单文件执行 migration，记录执行前后 shape、锁时间、权限、bucket、历史文本约束验证和回滚演练。

**验证**：

```bash
pnpm --filter @miniapp/shared typecheck
pnpm --filter @miniapp/shared test
pnpm -r typecheck
```

**回滚点**：应用尚未写图片；若 migration 不通过，执行经审核的独立回滚 SQL或 forward-fix，不部署 Backend。

## 阶段 2：Backend 图片基础能力

1. 添加 Sharp 依赖并实现 magic-byte/声明 MIME/尺寸/解码校验、缩略图、确定对象路径、private Storage 上传、签名 URL和补偿删除。
2. 单元测试 JPEG/PNG/GIF/WebP、伪 MIME、截断图、空文件、>5 MiB、超大像素、路径隔离、签名失败降级。
3. 为 Base64 route 设置足够但有界的 bodyLimit；Telegram 下载使用流式字节上限。

**验证**：Backend 图片 helper 测试、typecheck；检查 Node/Railway 构建能安装并运行 Sharp。

## 阶段 3：链路 B 站内客服

1. 改造 support route/repository：图片上传、图片消息幂等写入、会话摘要/未读原子更新、列表签名 URL。
2. 改造 CS support route：鉴权 conversation 后存储并插入 agent 图片消息；图片沿用通知/未读。
3. 增加 Backend route/repository 测试：ownership、跨会话 token、重复 ID、Storage 失败补偿、摘要只增一次、签名过期刷新。
4. 改造 Frontend API hooks、pending outbox、SupportPage 图片选择/预览/失败重试/Lightbox。
5. 改造 CS API 与 SupportConversationPanel；保持 env query key，环境切换清理本地预览。

**验证**：

```bash
pnpm --filter @miniapp/backend typecheck
pnpm --filter @miniapp/backend test
pnpm --filter @miniapp/frontend typecheck
pnpm --filter @miniapp/frontend test
pnpm --filter @miniapp/frontend lint
pnpm --filter @miniapp/frontend build
pnpm --filter @miniapp/cs-platform typecheck
pnpm --filter @miniapp/cs-platform build
```

**人工失败路径**：离线中断、上传后消息失败、同 ID重试、切换 test/prod、签名 URL过期、文件 input 重选同图、软键盘/安全区。

## 阶段 4：链路 A Telegram 回访

1. 抽取双 webhook 共用解析；支持 photo 最大项、非图片附件提示、超限/不可重试错误收口。
2. 扩展 CsPlatformRepository 映射和入站去重；图片计入 waiting state/last times。
3. 实现有超时的 getFile/流式下载/sendPhoto；CS 发图继续 pending/sent/failed 状态机和幂等重试。
4. 改造 CS API、ConversationPanel 图片预览/失败重试/Lightbox。
5. 用 mock Telegram/Storage 测试 200、403、429+retry_after、超时、损坏文件、webhook 重投、DB/Storage/Telegram 各阶段失败。

**人工真机**：test Bot 用户→CS、CS→用户各发四种格式；确认 30s/10s SLA、message id、403 屏蔽态和非图片提示。

## 阶段 5：全量验证与发布

1. 运行 shared + 四个受影响消费者的 typecheck/test/build；CS 无 test script 的缺口必须明确记录。
2. test 环境执行两条链路矩阵：方向 × 格式 × 边界 × 重试 × Lightbox × 环境切换。
3. 跑 security/performance advisors；附 remediation URL，不把 advisor 警告静默忽略。
4. 按“migration → Backend → CS Platform → Frontend”发布，逐阶段 smoke test。
5. 观察失败率/429/orphan/内存；触发停止条件则先关闭图片入口并 forward-fix。

## Consumer 校验清单

- Shared：联合类型和导出兼容。
- Backend：所有 SELECT/mapper 返回完整图片字段，文本行正确归一化。
- Frontend：不消费 DB path，仅消费临时 URL；已有未读红点和文本 outbox 不回归。
- CS Platform：两业务流 ID/query key/env 不混用；失败/重试状态准确。
- Admin：若 shared 根出口导致类型影响，只做 typecheck，不增加图片 UI。

## 文档与知识更新

- 更新 README/ARCHITECTURE 中客服能力、bucket、路由和环境/发布前置条件。
- 更新 frontend/backend/cs-platform/shared/database 对应 module facts。
- 生成并审核 `module-updates.json`，运行 `module_knowledge.py check` 后才能归档。
