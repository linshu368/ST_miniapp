# 执行任务

- [x] T1：更新 shared 契约与测试
  - 范围：`packages/shared/src/api/community.ts`、对应测试
  - 验证：shared typecheck/test
- [x] T2：新增数据库迁移并更新后端路由
  - 范围：`packages/shared/migrations/`、`packages/backend/src/routes/community.ts`、测试
  - 依赖：T1
  - 验证：backend typecheck/test
- [x] T3：更新前端按钮可见性和反馈文案
  - 范围：`packages/frontend/src/components/profile/community-sheet.tsx`
  - 依赖：T1
  - 验证：frontend typecheck
- [x] T4：全量检查本任务改动与自动发奖兼容性
  - 依赖：T1-T3
