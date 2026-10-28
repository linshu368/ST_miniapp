# 修复支付告警 Worker 锁连接生命周期

## Goal

用单连接 PostgreSQL advisory lock 修复支付告警 Worker 的连接池耗尽与失联；不改支付主链路、规则或数据库结构。

## Requirements

- 支付告警 Worker 的跨副本互斥必须使用同一 PostgreSQL session 获取和释放 advisory lock。
- 锁、连接和查询失败必须留下结构化日志，且不得阻断支付 API、订单结算或后续轮次。
- 未获得锁的副本只跳过本轮；进程异常或连接关闭后锁必须自动释放。
- 不新增数据库对象、迁移、运行时开关、支付规则或飞书卡片字段。

## Acceptance Criteria

- [ ] 不再通过 Prisma 连接池分别执行 session-level lock 与 unlock。
- [ ] 成功、未获锁、监控异常、投递异常和释放异常均不会泄漏专用连接。
- [ ] 必要回归测试覆盖同连接解锁与异常清理；Backend typecheck 和相关测试通过。
- [ ] 完成后能以生产 Worker 的心跳、连接池错误和 outbox 状态验证部署，不将本地测试冒充生产证明。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- 这是生产 P0 并发/连接生命周期 hotfix；设计和执行计划另附，以明确锁语义及发布恢复边界。
