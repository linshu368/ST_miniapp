# Task Breakdown

## 依赖

- 09-11-batch-lab-foundation
- 09-11-batch-lab-data-samples
- 09-11-batch-lab-postprocessing 的稳定 processor/display 接口

## Tasks

| ID  | Status  | Task                                   | Files / Scope               | Depends On | Verification                       |
| --- | ------- | -------------------------------------- | --------------------------- | ---------- | ---------------------------------- |
| T0  | Blocked | 人工评审并确认依赖/环境/安全门禁       | task artifacts + target env | -          | 评审记录与明确 start 授权          |
| T1  | Todo    | 冻结 shared 契约、状态、错误与容量限制 | shared contracts/tests      | T0         | schema tests + consumers typecheck |
| T2  | Todo    | 实现持久边界、事务/幂等与 repository   | backend/database            | T1         | repository/migration/并发测试      |
| T3  | Todo    | 实现Backend 实验与生成状态机核心能力   | owned application files     | T2         | PRD业务验收                        |
| T4  | Todo    | 覆盖失败、恢复、安全与容量             | tests/runbooks              | T3         | 故障注入与停止/回滚演练            |
| T5  | Todo    | 完成消费者检查、Spec payload和集成交接 | spec/docs/module updates    | T4         | 命令全绿 + integration owner验收   |

## 完成定义

- [ ] Batch Lab 不预留免费额度、不查/扣钱包、不写 experience.chat_history
- [ ] 普通会话无法选择 internal_research 策略
- [ ] 多轮用户输入不变，A/B 只接自己的前序原文，display HTML 不进上下文
- [ ] 第 k 轮失败使后续阻塞，重试不重跑前序或其他成功项
- [ ] 重复启动、双 worker、Backend kill/restart 不重复成功调用
- [ ] 验证命令、失败路径、发布/回滚和 Spec/module payload完整。
- [ ] 本任务独立归档后，父任务仍不完成；必须等待 integration-spec 全量收口。

## Execution Log

- 2026-09-11：完成详细规划；保持 planning，T0等待人工评审。
