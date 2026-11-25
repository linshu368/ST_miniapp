# 任务
- [x] 核对环境来源、现有素材、变换和缓存入口。
- [x] 实现两端名单和环境隔离。
- [x] 执行回归、构建及静态检查并记录结果。
- [ ] TEST 部署后核对真实 WebView 与账期用量。

本地通过：前端 15 项与后端 48 项相关测试、pnpm -r typecheck、pnpm -r --if-present build、复杂度及后端日志门禁、git diff --check。另以相同的 dev 分支和 PR 环境变量加载实际 next.config，production 开关为 false，preview 为 true。旧代码的 lint 警告未阻断构建。没有进行线上发布。
