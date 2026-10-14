# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status | Task                                | Files / Scope           | Depends On | Verification               |
| --- | ------ | ----------------------------------- | ----------------------- | ---------- | -------------------------- |
| T1  | Done   | 会话级 full/full/concise 前向迁移   | shared migration        | -          | isolated PostgreSQL passed |
| T2  | Done   | 固定富文本协议与 Admin 默认文案统一 | shared/backend/admin    | T1         | unit tests + typecheck     |
| T3  | Done   | 容错解析并隐藏控制标签              | shared text-postprocess | T2         | parser + renderer tests    |
| T4  | Done   | 完整验证与差异复核                  | affected packages       | T1-T3      | tests/typecheck/build      |

## Execution Log

- 2026-10-13：用户确认既定方案并授权创建轻量任务后开始实现；不触碰远端环境。
- 2026-10-13：新增 forward migration，以 `chat_history.turn_index` 决定每会话 full/full/concise；旧用户计数字段保留但退出运行时消费，重生成继续复制快照。
- 2026-10-13：Backend 固定追加 v1 机器协议；Admin 默认文案仅描述内容详略；Shared 对完整闭合但结构漂移的模块降级为安全卡片。
- 2026-10-13：隔离 PostgreSQL 验证同用户双会话、同会话并发、重生成、off/重开、失败回滚和 ACL；全 workspace typecheck、相关全量测试、Admin/Frontend build、migration/import/legacy/diff 检查通过。
- 待发布门禁：未执行 TEST/Production migration，未部署，未进行真机验收，未提交或推送。
