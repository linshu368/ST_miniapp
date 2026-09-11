# Task Breakdown

## 依赖

- 其余六个 Batch Lab 子任务均完成并提供证据

## Tasks

| ID  | Status  | Task                                   | Files / Scope               | Depends On | Verification                       |
| --- | ------- | -------------------------------------- | --------------------------- | ---------- | ---------------------------------- |
| T0  | Blocked | 人工评审并确认依赖/环境/安全门禁       | task artifacts + target env | -          | 评审记录与明确 start 授权          |
| T1  | Todo    | 冻结 shared 契约、状态、错误与容量限制 | shared contracts/tests      | T0         | schema tests + consumers typecheck |
| T2  | Todo    | 实现持久边界、事务/幂等与 repository   | backend/database            | T1         | repository/migration/并发测试      |
| T3  | Todo    | 实现跨子任务集成与知识收口核心能力     | owned application files     | T2         | PRD业务验收                        |
| T4  | Todo    | 覆盖失败、恢复、安全与容量             | tests/runbooks              | T3         | 故障注入与停止/回滚演练            |
| T5  | Todo    | 完成消费者检查、Spec payload和集成交接 | spec/docs/module updates    | T4         | 命令全绿 + integration owner验收   |

## 完成定义

- [ ] 父 PRD每项有自动或可重复人工证据且无未归属缺口
- [ ] 普通会话/计费/所有shared consumers回归通过
- [ ] 停止条件、worker drain、应用回滚和数据库 forward-fix 演练完成
- [ ] Vercel静态部署、CI test/build、Preview API base/CORS和SPA rewrite通过
- [ ] 来源只读连接写入负测通过，环境业务数据零写入
- [ ] Batch Lab新 spec、既有module facts、modules-index、README/ARCHITECTURE与实现一致
- [ ] 验证命令、失败路径、发布/回滚和 Spec/module payload完整。
- [ ] 本任务独立归档后，父任务仍不完成；必须等待 integration-spec 全量收口。

## Execution Log

- 2026-09-11：完成详细规划；保持 planning，T0等待人工评审。
