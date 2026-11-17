# 执行计划

1. 复核共用请求入口，独立诊断模块保持每函数120行以内。
2. 接线 perf 注册及 Supabase fetch，保留 SDK 行为。
3. 回归：成功/失败/取消/挂起与脱敏、普通路由隔离、遥测抛错隔离。
4. pnpm --filter @miniapp/backend typecheck；pnpm --filter @miniapp/backend test；pnpm --filter @miniapp/shared test；pnpm lint:complexity；git diff --check。
5. 文档说明测量边界与手动 TEST/生产观察：发送、重生成、401、慢 REST，核验既有 SSE/钱包不变。无生产权限时明确未执行。
