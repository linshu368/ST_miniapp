# Task Breakdown

## 依赖

- 09-11-batch-lab-foundation
- 09-11-batch-lab-data-samples 的 processor/display 存储

## Tasks

| ID  | Status  | Task                                   | Files / Scope               | Depends On | Verification                       |
| --- | ------- | -------------------------------------- | --------------------------- | ---------- | ---------------------------------- |
| T0  | Blocked | 人工评审并确认依赖/环境/安全门禁       | task artifacts + target env | -          | 评审记录与明确 start 授权          |
| T1  | Todo    | 冻结 shared 契约、状态、错误与容量限制 | shared contracts/tests      | T0         | schema tests + consumers typecheck |
| T2  | Todo    | 实现持久边界、事务/幂等与 repository   | backend/database            | T1         | repository/migration/并发测试      |
| T3  | Todo    | 实现后处理与渲染安全核心能力           | owned application files     | T2         | PRD业务验收                        |
| T4  | Todo    | 覆盖失败、恢复、安全与容量             | tests/runbooks              | T3         | 故障注入与停止/回滚演练            |
| T5  | Todo    | 完成消费者检查、Spec payload和集成交接 | spec/docs/module updates    | T4         | 命令全绿 + integration owner验收   |

## 完成定义

- [ ] 编辑仅复制并新建版本，旧版本/旧 display result 不变
- [ ] 零匹配为 success+0，所有失败保留原文且不返回空白
- [ ] 灾难性回溯被硬终止且不阻塞 Fastify event loop或遗留 worker
- [ ] 危险标签/属性/URL/CSS被清洗，原文/代码按文本展示
- [ ] 批处理与单条预览执行语义一致，后处理产物不进入生成上下文
- [ ] 验证命令、失败路径、发布/回滚和 Spec/module payload完整。
- [ ] 本任务独立归档后，父任务仍不完成；必须等待 integration-spec 全量收口。

## Execution Log

- 2026-09-11：完成详细规划；保持 planning，T0等待人工评审。
