# Task Breakdown

## 依赖

- 09-11-batch-lab-backend-execution
- 09-11-batch-lab-postprocessing
- 09-11-batch-lab-frontend-workbench

## Tasks

| ID  | Status  | Task                                   | Files / Scope               | Depends On | Verification                       |
| --- | ------- | -------------------------------------- | --------------------------- | ---------- | ---------------------------------- |
| T0  | Blocked | 人工评审并确认依赖/环境/安全门禁       | task artifacts + target env | -          | 评审记录与明确 start 授权          |
| T1  | Todo    | 冻结 shared 契约、状态、错误与容量限制 | shared contracts/tests      | T0         | schema tests + consumers typecheck |
| T2  | Todo    | 实现持久边界、事务/幂等与 repository   | backend/database            | T1         | repository/migration/并发测试      |
| T3  | Todo    | 实现历史血缘、复用与导出核心能力       | owned application files     | T2         | PRD业务验收                        |
| T4  | Todo    | 覆盖失败、恢复、安全与容量             | tests/runbooks              | T3         | 故障注入与停止/回滚演练            |
| T5  | Todo    | 完成消费者检查、Spec payload和集成交接 | spec/docs/module updates    | T4         | 命令全绿 + integration owner验收   |

## 完成定义

- [ ] 复制后修改新草稿不改变来源实验
- [ ] reuse 保存新实验、保留 A/B真实原文来源且模型调用数为零
- [ ] 部分失败仍可导出且每个失败项明确存在
- [ ] JSONL 每行通过 shared schema且无需源库即可还原本次输入/组合/窗口/结果
- [ ] 大实验流式导出有取消/超时/容量限制，不把正文写日志
- [ ] 验证命令、失败路径、发布/回滚和 Spec/module payload完整。
- [ ] 本任务独立归档后，父任务仍不完成；必须等待 integration-spec 全量收口。

## Execution Log

- 2026-09-11：完成详细规划；保持 planning，T0等待人工评审。
