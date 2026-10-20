# 实施计划

1. 建立旧路径清单并记录所有源码、mock、动态加载、脚本、workflow、部署配置和现行文档消费者。
2. 使用 `git mv` 整理根脚本与图片广场 runbook；同步 repo root 计算、内部互引、package scripts、workflow 和现行文档。
3. 整理 Admin `components` 与 `lib`，同步 `App.tsx`、组件相对 import、Worker/triple-slash/raw source 路径并运行 Admin 验证。
4. 整理 Frontend 少量散落文件，更新 import 并运行 Frontend 验证。
5. 整理 Backend Lobby/Notifications/storage 与 Shared 两个领域文件，更新 mock/相对 import/根出口/spec 并运行 Backend/Shared 验证。
6. 整理 Reply Renderer rendering/worker/testing 文件，更新 index、Worker/esbuild/Vitest 路径并运行 Renderer 及两个消费者 build。
7. 扫描旧路径残留；历史 archive/snapshot 只作为历史证据保留，其余残留逐一判断和修正。
8. 运行全仓 typecheck、测试、lint、import/legacy/migration guards、Frontend/Admin build、脚本语法检查、Prettier 和 `git diff --check`。
9. 复核 diff 只含移动与引用地址变化，更新任务记录和模块路径事实；不自动提交或推送。

## 停止条件

- 需要改变导出语义、业务逻辑、路由或数据库对象才能完成移动；
- 发现仓库外部署消费者仍依赖旧路径且不能同步；
- Worker、构建工具或框架发现规则无法在不改变行为的前提下验证。

触发时保留该文件原位并记录原因，不扩大任务边界。
