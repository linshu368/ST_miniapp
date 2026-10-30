# 执行方案

1. shared创作DTO/schema/helper先行，定接口与cover/studio回流。
2. 并行：角色owner/access/审核/迁移与admin；editor+API hooks；quote/结算/钱包迁移；root cover/polish/hub/studio/fixtures集成。
3. 复用packages/ui-tests增加creator固定场景，覆盖发布/草稿/导入/AI截断/封面回流/状态，不新建一次性验收系统。
4. 针对权限、计费、revision并发、契约和migration风险批准必要回归；普通视觉不新写镜像测试。运行shared测试、消费者typecheck、相关backend现有测试、frontend/editor测试和lint、admin构建、frontend构建；无新变更不重复全套。
5. 隔离Postgres执行单文件迁移验证；检查schema/权限/RLS、重放防重、实扣0/非零/自用/VIP、退款重复及余额不足。记录未能跑的真实环境边界。
6. 320/390/430移动端检查编辑器/空间/封面回流/聊天返回；生产不自动发布，完成后展示可打开本地效果。

预期命令：pnpm --filter @miniapp/shared test; pnpm -r typecheck; pnpm --filter @miniapp/backend test; pnpm --filter @miniapp/frontend test; pnpm --filter @miniapp/admin build; pnpm --filter @miniapp/frontend build; pnpm test:ui --grep @creator（扩展现有suite）。具体实际执行与结果记入task.md。

## 创作连续性增量
Editor agent负责候选类型/恢复、草稿新字段/基准指纹和Dialog回调；Core agent负责空间草稿状态和approved DTO；root负责主编辑器接线、恢复副本/封面复用/缺项定位/提交差异、fixture与固定验收。共享文件按职责串行写，不回退彼此更改。完成后移动端独立验收。
