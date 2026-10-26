# 执行与验证

1. 审阅当前状态/原权益/取消入口，核对两个环境函数签名。
2. Shared/frontend加显式原因；backend消费新原因并保全报价、终态、额度。DB单文件新增forward migration，既有真实PG harness加计费专项用例。
3. 运行既有backend/Frontend/shared相关测试、全部消费者typecheck、frontend/admin build、lint:migrations及diff检查。计费/并发风险必须扩展既有回归，必要新SQL文件由本风险评估确认。
4. TEST执行单文件迁移与RPC/ACL/并发实际验证，生产可审阅变更清单。按用户先前直接发布授权继续，若外部门禁实际拒绝则说明。
5. dev/main CI、后端→DB→前端兼容发布顺序，查生产版本/shape/只读聚合结果；不向真实用户发送消息。
