# 实施计划（待审核）

1. 审核匹配边界与新增 repository 回归测试方案，再 task.py start。
2. 调整 backend config/feed/repository，保留分享开关逻辑。
3. 更新 Admin 文案和当前 README/架构/spec，不改历史 migration。
4. 扩展既有测试，经审核新增单个 repository mock 测试。
5. 运行检查、复核全部修改、记录不能完成的人工验证。

## 验证命令

工作目录 `g:/JobLib/ST_miniapp`：

- `pnpm --filter @miniapp/backend test src/features/image-plaza src/routes/image-plaza.test.ts`
- `pnpm --filter @miniapp/shared test`
- `pnpm --filter @miniapp/admin test`
- `pnpm --filter @miniapp/frontend test`
- `pnpm -r typecheck`
- `pnpm --filter @miniapp/admin build`
- `pnpm --filter @miniapp/frontend build`
- `pnpm --filter @miniapp/frontend lint`
- 修改文件 Prettier check、`git diff --check`。

Backend 无 build 脚本，以 typecheck/tests 验证；任何阻断记录原因。

## 失败路径与人工验收

- 开关 true/false 标签输出相同，非法/禁用 tag 400，DB 失败仍走现有错误路径。
- repository 验证中文字段、特殊字符、search+tag+cursor 交集、全部无译文限制、软删除与 limit+1。
- 运行分享关闭不调 LLM、开启自动打标、显式标签、重复分享、异步失败回归。
- 确认 TEST 后人工验证“译文包含但 tags 为空”“tags 命中但译文不含”“无译文”及多页查询；本任务不直接写远程测试数据。
- 浏览器/Telegram 验证标签展示、全部恢复、空态、组合搜索无混页、窄屏与刷新。
- mock 不代表真实 JSONB ILIKE 行为/性能或生产实况；真实查询耗时和人工场景未执行时必须明确标注。
