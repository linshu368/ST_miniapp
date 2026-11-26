# 执行计划

状态：2026-11-25 用户“开始实施”批准，task.py start 已通过；产品代码已实现，静态/单元/构建验收中。用户补充客户端缓存方向并再次明确不进行本地UI测试。

1. 冻结基线与范围：使用research.md记录的B窗、生产SHA与源码；核对git工作区，保留无关变更。已完成。
2. 实现路由温热与loading：平铺/分组入口、首个候选空闲预取、显式意图去重、离页清理；不读取私有历史或创建会话。
3. 调整关键路径：按当前会话就绪门禁次要资源；推迟返回页和保活；角色资料按缓存/按需/normal消费。为满足复杂度限制，按职责拆小现有聊天page。
4. 观测：复用page/API出口记录同visit阶段；兼容原metrics，覆盖失败、取消、后台、跨会话晚回调与敏感字段过滤。
5. 回归：既有chat-entry、conversations-entry、client.retry/request-timing/request-concurrency、entry-phase/navigation-quiet-window、connection-warmth、page-tracker/grafana/sanitize、chat-history及consumer测试。新增文件仅限设计中确需锁定的新边界。
6. 验证命令：
   - pnpm --filter @miniapp/frontend typecheck
   - pnpm --filter @miniapp/frontend test -- --maxWorkers=2（先用实际脚本确认参数透传）
   - pnpm --filter @miniapp/frontend lint
   - pnpm --filter @miniapp/frontend build
   - pnpm lint:complexity；git diff --check
   - python .trellis/scripts/logging_planning_gate.py --task .trellis/tasks/11-25-chat-entry-route-wait
   - 若改Backend/shared：对应测试、pnpm -r typecheck、pnpm lint:backend-logging与logging:validate。
     Windows重复Next build前，验证路径后将旧.next/standalone移至仓库内output/build-snapshots，禁止递归删除junction。构建禁止更换锁文件/依赖版本来绕过问题。
7. Consumer/人工场景记录（不启动本地UI）：分组/平铺入口、搜索/管理模式、首次新建与已有会话、返回语音/充值、快速连点切换、身份失效、角色无权限、慢历史/恢复、取消/错误重试、草稿与编辑/分支/点赞/发送保护。
8. 代码审核与规范：使用trellis-check；按实际修改收紧复杂度基线，更新README/架构/模块规范、验证记录。不给未运行的UI/真机/生产P95记通过。
9. 发布与回滚交付：仅整理reviewable diff/验证结果，不自动git add/commit/push/部署；用户授权发布后再按稳定release做完整48h验收。
